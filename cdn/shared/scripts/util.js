/* ──────────────────────────────────────────────────────────────────────────
 * Shared browser helpers for cootshk.dev apps (Tailor, Modpack…).
 * Plain global script — load BEFORE an app's own script. No module system so
 * these become globals the app can call directly.
 * ────────────────────────────────────────────────────────────────────────── */

/* DOM query shorthands */
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

/* HTML-escape a value for safe interpolation into innerHTML. */
function esc(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

/* 1234 -> "1.2K", 3400000 -> "3.4M". */
function formatDownloads(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/* "hello world" -> "Hello World" */
function titleCase(s) {
  return String(s).replace(/\b\w/g, c => c.toUpperCase());
}

/* Hex SHA-1 of an ArrayBuffer/typed array via WebCrypto. */
async function computeSha1(buffer) {
  const hash = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
