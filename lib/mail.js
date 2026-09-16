// lib/mail.js — the one outbound email this app sends.
/* ============================================================================

   No new dependency. Node 22 ships global fetch, so a transactional email is
   one HTTPS call to a provider's API; adding nodemailer plus an SMTP config
   to send a single message would be the larger change, not the smaller one.
   The app's three dependencies (express, pg, dotenv) stay three.

   Configure with three environment variables:

     RESEND_API_KEY   an API key from resend.com
     MAIL_FROM        the verified sender, e.g. "CheckSteady <noreply@…>"
     PUBLIC_URL       the origin every emailed link is built from (see
                      publicUrl() below) — REQUIRED, not optional. Without
                      it, password reset, staff invitation and trial
                      sign-up all refuse the request before calling send()
                      at all: there is no safe origin to put in the link,
                      and building one from the request's Host header is
                      exactly the forgeable shortcut this file exists to
                      close.

   WITH RESEND_API_KEY/MAIL_FROM UNSET (and PUBLIC_URL set) the link is
   written to the service log instead, with a warning. That is a deliberate
   fallback rather than a silent failure: on a single-site deployment the
   operator already has log access (and with it the database URL), so this
   grants them nothing they did not have, and it means the feature works on
   day one rather than appearing to work. It is still a fallback — anyone who
   can read your logs can seize an account during the hour a link is live —
   so set all three variables before you have staff who are not you.
   ========================================================================= */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

// The origin every emailed link must use — PUBLIC_URL, and nothing else.
// server.js sets trust proxy with no Host allowlist, and its CSRF check lets
// a request with no Origin header through by design, so a request with a
// forged Host would otherwise ride into a genuine, DKIM-signed email
// carrying a live single-use token, to whatever origin the attacker chose.
// This lives here rather than in each route because every route that needs
// it is already calling into lib/mail.js to send the email that link goes
// in, and because it is the one place that already knows what "unconfigured"
// means for outbound mail (see isConfigured() above).
//
// Returns null when PUBLIC_URL is unset. Never a value built from a request.
// Callers decide what "no link" means for them — see routes/settings.js
// reportLink() and jobs.js reportLink(), which established this rule for the
// weekly report link; the three single-use-credential links (password
// reset, staff invite, trial verification) follow it here.
function publicUrl() {
  return String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
}

// Returns { delivered: boolean }. Never throws: a mail outage must not turn
// into a 500 that tells the browser whether an address exists.
//
// `html` is optional and always accompanies `text`, never replaces it: the
// plain part stays the message in full, so a client that shows it — or a
// person who reads mail as text on purpose — loses nothing but the styling.
// `headers` is optional and forwarded verbatim; the recurring emails use it
// for `List-Unsubscribe` (lib/emailPrefs.js).
// `attachments` is optional: [{ filename, content: Buffer, contentType }] — the
// Sunday Weekly Register Update as a Word document (lib/weeklyReport.js).
async function send({ to, subject, text, html, headers, attachments }) {
  // The test suite runs the server in-process with no provider and reads
  // what would have been sent. Never set in production.
  // It answers "not delivered", exactly as an unconfigured service does, so
  // the routes that hand a link back to an administrator behave the same.
  if (process.env.HUT_MAIL_SINK === '1') {
    // Mirrors the "no headers at all" case below: an empty object (what
    // emailPrefs.headersFor() returns with no link) is not headers.
    const sunk = headers && Object.keys(headers).length ? headers : undefined;
    (global.__mailSink = global.__mailSink || []).push({
      to, subject, text, html, headers: sunk,
      ...(attachments && attachments.length ? { attachments } : {}),
    });
    return { delivered: false };
  }
  if (!isConfigured()) {
    console.warn(
      `[mail] RESEND_API_KEY/MAIL_FROM are not set, so this was not emailed.\n` +
      `[mail] to: ${to}\n[mail] ${subject}\n${text}`,
    );
    return { delivered: false };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM, to: [to], subject, text,
        ...(html ? { html } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
        // Resend takes attachments inline as base64; the Sunday document is a
        // few kilobytes. `content` arrives as a Buffer from the caller.
        ...(attachments && attachments.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64'), ...(a.contentType ? { content_type: a.contentType } : {}) })) }
          : {}),
      }),
      // A hung mail provider must not hold the request open: the browser is
      // getting the same answer either way.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // The response body is the provider's own explanation (e.g. Resend
      // names exactly which check failed — unverified domain, sender not
      // matching the verified domain, an API key restricted from sending).
      // That is what turns a bare status code into something a person can
      // act on without guessing. It can only contain what the provider sent
      // back, never a request header, so it cannot leak RESEND_API_KEY —
      // but a provider that echoes the request body on a validation error
      // would put the single-use reset or invitation link this send() call
      // is carrying straight into the log, and 300 characters is ample for
      // one, so anything URL-shaped is stripped before logging. What is
      // left is still untrusted and unbounded, so it is read defensively
      // and capped well short of flooding the log with, say, an HTML error
      // page. Reading it can itself fail; that must not stop the status
      // code from being logged or turn into a throw.
      let detail = '';
      try {
        const body = (await res.text())
          .trim()
          .replace(/\s+/g, ' ')
          .replace(/https?:\/\/\S+/gi, '[link removed]');
        if (body) detail = `: ${body.slice(0, 300)}`;
      } catch {
        // Body unreadable — the status code below is still worth logging.
      }
      console.error(`[mail] provider returned ${res.status} sending to ${to}${detail}`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    console.error(`[mail] send failed: ${err.message}`);
    return { delivered: false };
  }
}

/* ---------------------------------------------------------------------------
   The house style for a report email.

   Every recurring report (the overnight safeguarding check, the Sunday
   weekly update, the House Rules reminder) is composed as words by its own
   module and laid out here, so the three look like one product rather than
   three eras of one. The plain-text part each composer already produced is
   still sent alongside and is still the whole message.

   Rules this layout keeps, which are not only taste:

   - No image, anywhere. Not the mark, not a spacer, not a pixel. A remote
     image in a mail to a centre's staff is a read receipt for whoever hosts
     it, and this product's whole claim is that it does not watch people. It
     also means nothing to "display images below" — the mail is complete on
     arrival, in a locked-down mail client, offline.
   - No external stylesheet, font or script: mail clients strip them, and
     Gmail drops <style> blocks in some views, so every rule is inline.
   - Tables for layout, because Outlook renders mail with Word's engine and
     ignores modern CSS layout entirely.
   - Explicit background AND text colour on every block: a client that flips
     to dark must not leave dark text on a background it did not repaint.
   ------------------------------------------------------------------------ */

const INK = '#101828', MUTED = '#5b6478', LINE = '#e3e8f0', ACCENT = '#1d4ed8', PAGE = '#f4f6fb';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TONES = {
  attention: { bg: '#fffbeb', border: '#fcd34d', ink: '#92400e' },
  clear:     { bg: '#f0fdf4', border: '#bbf7d0', ink: '#166534' },
};

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Only ever an https link this app built from PUBLIC_URL, but href is the one
// place in these mails where a value becomes executable if it is not, so the
// scheme is checked here rather than trusted from the caller.
function safeHref(href) {
  const s = String(href || '').trim();
  return /^https:\/\//i.test(s) ? s : null;
}

function layout({ siteName, heading, figure, paragraphs = [], rows = [], cta, notes = [], unsubscribe, footer }) {
  const footerText = footer || 'It carries counts only — the detail stays behind your login.';
  const tone = TONES[figure?.tone] || TONES.clear;
  const href = safeHref(cta?.href);
  const p = (t, colour = INK) =>
    `<p style="margin:0 0 14px;font:15px/1.55 ${FONT};color:${colour};">${escapeHtml(t)}</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
    <tr><td style="background:${ACCENT};padding:16px 24px;">
      <span style="font:700 17px/1.2 ${FONT};color:#ffffff;letter-spacing:-0.01em;">CheckSteady</span>
      ${siteName ? `<span style="font:400 14px/1.2 ${FONT};color:#dbe6ff;"> &middot; ${escapeHtml(siteName)}</span>` : ''}
    </td></tr>
    <tr><td style="padding:24px;">
      <h1 style="margin:0 0 16px;font:700 19px/1.35 ${FONT};color:${INK};">${escapeHtml(heading)}</h1>
      ${figure ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${tone.bg};border:1px solid ${tone.border};border-radius:10px;margin:0 0 18px;">
        <tr><td style="padding:14px 16px;">
          <div style="font:700 26px/1.1 ${FONT};color:${tone.ink};">${escapeHtml(figure.value)}</div>
          <div style="font:15px/1.4 ${FONT};color:${tone.ink};padding-top:4px;">${escapeHtml(figure.label)}</div>
        </td></tr>
      </table>` : ''}
      ${paragraphs.map((t) => p(t)).join('')}
      ${rows.length ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:10px;margin:0 0 18px;">
        ${rows.map((r, i) => {
          const edge = i ? `border-top:1px solid ${LINE};` : '';
          return `
        <tr>
          <td style="padding:11px 16px;font:15px/1.4 ${FONT};color:${INK};${edge}">
            ${escapeHtml(r.label)}${r.note ? `<br><span style="font-size:13px;color:${MUTED};">${escapeHtml(r.note)}</span>` : ''}
          </td>
          <td align="right" valign="top" style="padding:11px 16px 11px 8px;font:700 15px/1.4 ${FONT};color:${INK};${edge}">${escapeHtml(r.value)}</td>
        </tr>`;
        }).join('')}
      </table>` : ''}
      ${href ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 18px;">
        <tr><td style="background:${ACCENT};border-radius:10px;">
          <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;">${escapeHtml(cta.label)}</a>
        </td></tr>
      </table>` : ''}
      ${notes.map((t) => p(t, MUTED)).join('')}
    </td></tr>
    <tr><td style="background:#fbfcfe;border-top:1px solid ${LINE};padding:14px 24px;">
      <p style="margin:0;font:13px/1.5 ${FONT};color:${MUTED};">You are receiving this because your CheckSteady account is ticked for it. ${escapeHtml(footerText)}${unsubscribe && safeHref(unsubscribe) ? ` <a href="${escapeHtml(safeHref(unsubscribe))}" style="color:${MUTED};">Unsubscribe</a>` : ''}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// The plain-text twin of the footer link. Callers append it as the last
// paragraph so a text-only client still has the way out.
function textFooter(unsubscribe) {
  return unsubscribe ? `To stop these emails: ${unsubscribe}` : null;
}

function resetEmail({ fullName, link, minutes }) {
  return {
    subject: 'Reset your check-in password',
    text:
`Hello ${fullName},

Somebody asked to reset the password for your check-in account. Open this
link to choose a new one:

${link}

The link works once and expires in ${minutes} minutes. Choosing a new password
signs the account out everywhere, including any terminal left logged in.

If this was not you, you can ignore this message. Your password has not
changed, and nobody can use the link without this email.
`,
  };
}

// The invitation is the reset link with different words: the account exists,
// it has no password, and this is how its owner chooses one.
function inviteEmail({ fullName, siteName, link, hours, invitedBy }) {
  return {
    subject: `Set up your ${siteName || 'CheckSteady'} account`,
    text:
`Hello ${fullName},

${invitedBy ? invitedBy + ' has' : 'You have been'} set up an account for you on the ${siteName || 'CheckSteady'}
register. Open this link to choose your password:

${link}

The link works once and expires in ${hours} hours. Nobody else knows or can
see your password — if the link has expired, ask an administrator to send a
new one.
`,
  };
}

function codeEmail({ fullName, code, minutes }) {
  return {
    subject: `${code} is your login code`,
    text: `Hello ${fullName},

Your login code is:

    ${code}

It works once and expires in ${minutes} minutes. If you did not just try to
log in, someone has your password: change it now from the login screen.`,
  };
}

module.exports = { send, resetEmail, inviteEmail, codeEmail, isConfigured, publicUrl, layout, escapeHtml, textFooter };
