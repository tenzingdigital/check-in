// lib/mail.js — the one outbound email this app sends.
/* ============================================================================

   No new dependency. Node 22 ships global fetch, so a transactional email is
   one HTTPS call to a provider's API; adding nodemailer plus an SMTP config
   to send a single message would be the larger change, not the smaller one.
   The app's three dependencies (express, pg, dotenv) stay three.

   Configure with two environment variables:

     RESEND_API_KEY   an API key from resend.com
     MAIL_FROM        the verified sender, e.g. "CheckSteady <noreply@…>"

   WITH NEITHER SET the reset link is written to the service log instead, with
   a warning. That is a deliberate fallback rather than a silent failure: on a
   single-site deployment the operator already has log access (and with it the
   database URL), so this grants them nothing they did not have, and it means
   the feature works on day one rather than appearing to work. It is still a
   fallback — anyone who can read your logs can seize an account during the
   hour a link is live — so set the two variables before you have staff who
   are not you.
   ========================================================================= */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

// Returns { delivered: boolean }. Never throws: a mail outage must not turn
// into a 500 that tells the browser whether an address exists.
async function send({ to, subject, text }) {
  // The test suite runs the server in-process with no provider and reads
  // what would have been sent. Never set in production.
  // It answers "not delivered", exactly as an unconfigured service does, so
  // the routes that hand a link back to an administrator behave the same.
  if (process.env.HUT_MAIL_SINK === '1') {
    (global.__mailSink = global.__mailSink || []).push({ to, subject, text });
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
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
      // A hung mail provider must not hold the request open: the browser is
      // getting the same answer either way.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[mail] provider returned ${res.status} sending to ${to}`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    console.error(`[mail] send failed: ${err.message}`);
    return { delivered: false };
  }
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

module.exports = { send, resetEmail, inviteEmail, codeEmail, isConfigured };
