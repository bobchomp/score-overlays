/* Helpers for older browsers (e.g. iPads stuck on iOS 12). A classic script in plain old JavaScript on purpose,
   so it runs everywhere. Loaded before the page's own code by the dock and the Lineups / Teams / Theme pages.

   1. Flex "gap": Safari before 14.1 ignores `gap` in flex layouts, so icons and labels run together.
      Where it's missing, matching margins are added for every CSS rule that sets display:flex and a gap.
   2. If the page's code hasn't started after a few seconds (a browser too old for it), say so on screen
      instead of showing buttons that do nothing. */
(function () {
  'use strict';
  var errors = [];
  window.addEventListener('error', function (e) { errors.push(e.message || String(e.error || 'error')); });

  function flexGapWorks() {
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    d.appendChild(document.createElement('div'));
    d.appendChild(document.createElement('div'));
    document.body.appendChild(d);
    var ok = d.scrollHeight === 1;
    d.parentNode.removeChild(d);
    return ok;
  }

  function gapRules(rules, out, media) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.cssRules && r.media) { gapRules(r.cssRules, out, r.media.mediaText); continue; }
      if (!r.style || !r.selectorText) continue;
      var disp = r.style.display;
      if (disp !== 'flex' && disp !== 'inline-flex') continue;
      var col = r.style.columnGap || r.style.gap, row = r.style.rowGap || r.style.gap;
      if ((!col || col === 'normal') && (!row || row === 'normal')) continue;
      var vertical = /column/.test(r.style.flexDirection || '');
      var wraps = /wrap/.test(r.style.flexWrap || '');
      var sels = r.selectorText.split(',');
      var css = '';
      for (var k = 0; k < sels.length; k++) {
        var s = sels[k].trim();
        if (vertical) { if (row && row !== 'normal') css += s + ' > * + * { margin-top: ' + row + '; }\n'; }
        else {
          if (col && col !== 'normal') css += s + ' > * + * { margin-left: ' + col + '; }\n';
          if (wraps && row && row !== 'normal') css += s + ' > * { margin-bottom: ' + row + '; }\n';
        }
      }
      if (css) out.push(media ? '@media ' + media + ' {\n' + css + '}\n' : css);
    }
  }

  function polyfillGap() {
    if (!/[?&]nogap\b/.test(location.search) && flexGapWorks()) return; // ?nogap: try the fallback in any browser
    document.documentElement.className += ' no-flex-gap';
    var out = [];
    for (var i = 0; i < document.styleSheets.length; i++) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; } // e.g. Google Fonts
      if (rules) gapRules(rules, out);
    }
    var style = document.createElement('style');
    style.id = 'flex-gap-fallback';
    style.appendChild(document.createTextNode(out.join('')));
    document.head.appendChild(style);
  }

  function watchStart() {
    setTimeout(function () {
      if (window.__appReady) return;
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;padding:14px 16px;border-radius:10px;' +
        'background:#4a1416;border:1px solid #f85149;color:#ffdcd9;font:15px/1.4 -apple-system,system-ui,sans-serif';
      box.textContent = 'This page could not start in this browser, so the buttons won\'t work. ' +
        'Try reloading. If it keeps happening, tell whoever looks after the system: ' +
        (errors.length ? errors[0] : 'no error was reported') + ' (' + navigator.userAgent + ')';
      document.body.appendChild(box);
    }, 8000);
  }

  function ready() { polyfillGap(); watchStart(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
