# Dry run of scripts/update.ps1 on Windows PowerShell 5.1 (run by GitHub Actions on Windows).
# Builds a copy of the app that is a few versions behind, with the kind of local edits that block
# a plain "git pull", runs the CURRENT updater against it, and checks the result.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tmp = $env:RUNNER_TEMP; if (-not $tmp) { $tmp = $env:TEMP }
$work = Join-Path $tmp 'updater-test'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory $work | Out-Null

function Check([bool]$cond, [string]$msg) {
  if (-not $cond) { throw "FAIL: $msg" }
  Write-Host "ok - $msg" -ForegroundColor Green
}
function GitQ { & git @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $args failed" } }

# A fake "GitHub": bare repo whose main is the commit being tested.
$head = (& git -C $repo rev-parse HEAD).Trim()
GitQ clone --quiet --bare $repo "$work\remote.git"
GitQ --git-dir "$work\remote.git" update-ref refs/heads/main $head
GitQ --git-dir "$work\remote.git" symbolic-ref HEAD refs/heads/main
GitQ clone --quiet --branch main "$work\remote.git" "$work\app"
$app = "$work\app"

# The user's copy is 3 updates behind ...
GitQ -C $app reset --quiet --hard "$head~3"
$old = (& git -C $app rev-parse HEAD).Trim()
New-Item -ItemType Directory "$app\node_modules" -Force | Out-Null   # skip npm install unless deps changed
# ... with edits made through the app (block a plain git pull) ...
$themeFile = "$app\config\theme.json"
(Get-Content -Raw $themeFile) -replace '"clubName":\s*"[^"]*"', '"clubName": "My Test Club"' | Set-Content -NoNewline $themeFile
$teamFile = "$app\config\teams\riverside.json"
(Get-Content -Raw $teamFile) -replace '"short":\s*"[^"]*"', '"short": "XYZ"' | Set-Content -NoNewline $teamFile
# ... and their own files, which must survive untouched.
Set-Content "$app\config\teams\my-own-team.json" '{"name":"My Own Team","short":"MOT","squad":[]}'
New-Item -ItemType Directory "$app\data" -Force | Out-Null
Set-Content "$app\data\state.json" '{"state":{"rev":42}}'
Set-Content "$app\.env" 'CONTROL_PIN=1234'

# Run the updater being tested against that copy.
& powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\scripts\update.ps1" -Folder $app
Check ($LASTEXITCODE -eq 0) 'updater exits successfully'

Check ((& git -C $app rev-parse HEAD).Trim() -eq $head) 'copy is now on the latest version'
Check ((& git -C $app status --porcelain --untracked-files=no) -eq $null) 'no edited files left blocking future updates'
Check ((Get-Content -Raw "$app\data\theme.json") -match 'My Test Club') 'edited theme kept in data\theme.json'
$backup = Get-ChildItem "$app\data\update-backup" -Directory | Select-Object -First 1
Check ($null -ne $backup) 'backup folder created'
Check ((Get-Content -Raw (Join-Path $backup.FullName 'config\theme.json')) -match 'My Test Club') 'theme.json backed up'
Check ((Get-Content -Raw (Join-Path $backup.FullName 'config\teams\riverside.json')) -match '"XYZ"') 'edited example team backed up'
Check (Test-Path "$app\config\teams\my-own-team.json") 'own team file untouched'
Check ((Get-Content -Raw "$app\data\state.json") -match '"rev":42') 'match data untouched'
Check (Test-Path "$app\.env") '.env untouched'

# Second run: nothing to do.
& powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\scripts\update.ps1" -Folder $app
Check ($LASTEXITCODE -eq 0) 'second run (already up to date) exits successfully'

# A folder that isn't a git checkout fails cleanly.
New-Item -ItemType Directory "$work\zip-copy" | Out-Null
& powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\scripts\update.ps1" -Folder "$work\zip-copy"
Check ($LASTEXITCODE -eq 1) 'non-git folder stops with an error instead of breaking'

Write-Host 'Updater dry run passed.' -ForegroundColor Green
