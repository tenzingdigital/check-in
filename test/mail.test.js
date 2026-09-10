// The mail provider's error-body logging. Run:  node test/mail.test.js
/* ============================================================================

   lib/mail.js send() talks to Resend over plain fetch, with no server, no
   database and no HTTP listener of its own — every other suite in this repo
   sets HUT_MAIL_SINK=1 before requiring the server, which short-circuits
   send() before it ever reaches the fetch() below, so a provider error is
   never exercised there. This file requires lib/mail.js directly instead of
   going through a route, and replaces global.fetch with a stand-in that
   answers like Resend does on failure, so the behaviour is covered without
   a live provider or a running cluster.

   Assertions are plain throws, for the same reason the other suites use none
   of a test framework.
   ========================================================================= */

const assert = require('assert/strict');

// send() checks this before anything else; make sure it takes the real path.
delete process.env.HUT_MAIL_SINK;
process.env.RESEND_API_KEY = 'test-key-do-not-log-me';
process.env.MAIL_FROM = 'CheckSteady <noreply@checksteady.com>';

const mail = require('../lib/mail');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`   ok  ${name}`);
}

// Swaps global.fetch for the duration of fn and captures console.error calls
// made while it runs, restoring both afterwards even if fn throws.
async function withFetch(fetchImpl, fn) {
  const realFetch = global.fetch;
  const realError = console.error;
  const logs = [];
  global.fetch = fetchImpl;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    global.fetch = realFetch;
    console.error = realError;
  }
}

async function main() {
  await test('logs the provider explanation alongside the status', async () => {
    const body = JSON.stringify({
      statusCode: 403,
      name: 'restricted_api_key',
      message: 'This API key is restricted to only send testing emails.',
    });
    const { result, logs } = await withFetch(
      async () => ({ ok: false, status: 403, text: async () => body }),
      () => mail.send({ to: 'owner@example.com', subject: 'Test', text: 'body' }),
    );
    assert.deepEqual(result, { delivered: false }, 'a provider error must still answer { delivered: false }');
    assert.equal(logs.length, 1, 'exactly one line should be logged for a provider error');
    assert.match(logs[0], /provider returned 403/);
    assert.match(logs[0], /restricted_api_key/);
    assert.match(logs[0], /only send testing emails/);
  });

  await test('never logs the API key or request headers', async () => {
    const { logs } = await withFetch(
      async () => ({ ok: false, status: 403, text: async () => '{"message":"restricted"}' }),
      () => mail.send({ to: 'owner@example.com', subject: 'Test', text: 'body' }),
    );
    const joined = logs.join('\n');
    assert.ok(!joined.includes(process.env.RESEND_API_KEY), 'the API key must never reach the log');
    assert.ok(!/authorization/i.test(joined), 'no request header should reach the log');
    assert.ok(!/bearer/i.test(joined), 'no request header should reach the log');
  });

  await test('truncates a large body instead of flooding the log', async () => {
    const hugeBody = '<html>' + 'x'.repeat(5000) + '</html>';
    const { logs } = await withFetch(
      async () => ({ ok: false, status: 500, text: async () => hugeBody }),
      () => mail.send({ to: 'owner@example.com', subject: 'Test', text: 'body' }),
    );
    assert.equal(logs.length, 1);
    assert.ok(logs[0].length < 400, `logged line should be bounded, was ${logs[0].length} chars`);
  });

  await test('a body that fails to read still logs the status and never throws', async () => {
    const { result, logs } = await withFetch(
      async () => ({ ok: false, status: 502, text: async () => { throw new Error('stream already consumed'); } }),
      () => mail.send({ to: 'owner@example.com', subject: 'Test', text: 'body' }),
    );
    assert.deepEqual(result, { delivered: false });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /provider returned 502/);
  });

  await test('a successful response still delivers as before', async () => {
    const { result, logs } = await withFetch(
      async () => ({ ok: true, status: 200, text: async () => '' }),
      () => mail.send({ to: 'owner@example.com', subject: 'Test', text: 'body' }),
    );
    assert.deepEqual(result, { delivered: true });
    assert.equal(logs.length, 0);
  });

  console.log(`\nPASS: ${passed} mail-logging assertions.`);
}

main().catch((err) => {
  console.error(`\nFAIL: ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
