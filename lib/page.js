// lib/page.js — the one server-rendered page shell: the trial sign-up pages
// and the unsubscribe page. Plain HTML in the app's own stylesheet, no
// script, so it works in any mail client's browser.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pageHtml({ title, heading, body, backHref = 'https://checksteady.com/', backLabel = 'Back to checksteady.com' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex">
<title>${esc(title)} — CheckSteady</title>
<link rel="stylesheet" href="/app-common.css">
</head>
<body class="app-signup">
<main class="wrap">
  <section class="login">
    <h1>CheckSteady</h1>
    <h2>${esc(heading)}</h2>
    ${body}
    <p class="hint"><a class="linkish" href="${esc(backHref)}">${esc(backLabel)}</a></p>
  </section>
</main>
</body>
</html>`;
}

module.exports = { esc, pageHtml };
