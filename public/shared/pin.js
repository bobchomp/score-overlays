// The control PIN is remembered per device (OBS docks keep localStorage between sessions).
const KEY = 'control-pin';
export function getPin() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
export function setPin(pin) { try { localStorage.setItem(KEY, pin); } catch {} }
export function clearPin() { try { localStorage.removeItem(KEY); } catch {} }
