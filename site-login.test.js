/**
 * node site-login.test.js — the login escape hatch's pure parts: blocker detection and
 * the 24 h block marker. No browser, no network. Throws on the first failing assertion.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectBlocker, writeBlock, readBlock, clearBlock, blockFile, loginMessage,
  credsHash, badCredsReason, loginOnce, ensureLoggedIn,
} = require('./site-login');

// ---- detectBlocker ----
const cases = [
  [{ url: 'https://www.linkedin.com/checkpoint/challenge/x' }, 'checkpoint'],
  [{ url: 'https://www.linkedin.com/authwall?x' }, 'checkpoint'],
  [{ text: 'Enter the 6-digit code we sent to your email' }, 'otp'],
  [{ text: 'Login with OTP  Login with password' }, null], // a button, not a prompt
  [{ title: 'Just a moment...' }, 'cloudflare'],
  [{ frameSrcs: ['https://www.google.com/recaptcha/api2/anchor'] }, 'captcha'],
  [{ frameSrcs: ['https://client-api.arkoselabs.com/x'] }, 'captcha'],
  [{ text: 'Please verify your email address' }, 'email-verification'],
  [{ text: 'Java Backend Developer  Apply  Posted 2 days ago' }, null],
  [{}, null],
];
for (const [input, want] of cases) {
  assert.strictEqual(detectBlocker(input), want, `detectBlocker(${JSON.stringify(input)}) should be ${want}`);
}

// ---- block marker round-trip (temp dir, never the repo) ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-login-'));
try {
  assert.strictEqual(readBlock('linkedin', dir), null, 'no marker yet');
  writeBlock('linkedin', 'checkpoint', dir);
  assert.ok(fs.existsSync(blockFile('linkedin', dir)), 'marker file written');
  assert.strictEqual(readBlock('linkedin', dir).reason, 'checkpoint', 'fresh marker is read back');
  assert.strictEqual(readBlock('linkedin', dir, 0), null, 'marker older than maxAgeMs is ignored');
  clearBlock('linkedin', dir);
  assert.strictEqual(readBlock('linkedin', dir), null, 'cleared marker is gone');
  clearBlock('linkedin', dir); // clearing twice is fine (ENOENT ignored)
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- LinkedIn invisible reCAPTCHA is not a blocker; a visible challenge is ----
const invisible = 'https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=x&co=y&hl=en&size=invisible&cb=z';
assert.strictEqual(detectBlocker({ url: 'https://www.linkedin.com/login', frameSrcs: [invisible] }), null,
  'invisible reCAPTCHA anchor alone is not a blocker');
assert.strictEqual(detectBlocker({ url: 'https://www.linkedin.com/feed/', frameSrcs: [invisible] }), null,
  'invisible frame on a post-login page is not a blocker');
assert.strictEqual(detectBlocker({ text: 'Sign in  This site is protected by reCAPTCHA and the Google Privacy Policy' }), null,
  'reCAPTCHA footer text is not a blocker');
assert.strictEqual(detectBlocker({ frameSrcs: [invisible, 'https://www.google.com/recaptcha/enterprise/bframe?k=x'] }), 'captcha',
  'a visible challenge frame next to the invisible one is a blocker');
assert.strictEqual(detectBlocker({ url: 'https://www.linkedin.com/checkpoint/challenge/abc', frameSrcs: [invisible] }), 'checkpoint',
  'checkpoint URL is a blocker');
assert.strictEqual(detectBlocker({ text: "Let's do a quick security check" }), 'checkpoint', 'visible verification text');

// ---- bad-credentials marker: written with a hash, cleared when .env creds change ----
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'site-login-'));
try {
  const oldCreds = { email: 'user@example.com', password: 'old-secret' };
  const h = credsHash('linkedin', oldCreds);
  assert.strictEqual(h, credsHash('linkedin', { ...oldCreds }), 'hash is stable');
  writeBlock('linkedin', badCredsReason('linkedin'), dir2, { credsHash: h });
  const raw = fs.readFileSync(blockFile('linkedin', dir2), 'utf8');
  assert.ok(!raw.includes(oldCreds.password) && !raw.includes(oldCreds.email), 'marker never stores credential values');
  assert.ok(/LINKEDIN_EMAIL \/ LINKEDIN_PASSWORD in \.env/.test(JSON.parse(raw).reason), 'reason names the .env keys');
  assert.ok(readBlock('linkedin', dir2, undefined, h), 'same creds: still blocked (no hourly retry)');
  assert.ok(readBlock('linkedin', dir2, 0, h), 'bad-credentials marker does not age out');
  const newHash = credsHash('linkedin', { ...oldCreds, password: 'new-secret' });
  assert.notStrictEqual(newHash, h, 'changed password changes the hash');
  assert.strictEqual(readBlock('linkedin', dir2, undefined, newHash), null, 'changed creds: marker ignored');
  assert.ok(!fs.existsSync(blockFile('linkedin', dir2)), 'changed creds: marker file removed');
  // `login` mode clears it via clearBlock
  writeBlock('linkedin', badCredsReason('linkedin'), dir2, { credsHash: h });
  clearBlock('linkedin', dir2);
  assert.strictEqual(readBlock('linkedin', dir2, undefined, h), null, 'login mode clears the marker');
} finally {
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ---- one auto-login attempt per run ----
(async () => {
  const calls = [];
  const fake = async (page, site, opts) => { calls.push(opts.noAttempt); return { status: 'logged-in', reason: '' }; };
  const once = loginOnce(fake);
  await once(null, 'hirist', {});
  await once(null, 'hirist', {});
  await once(null, 'hirist', {});
  assert.deepStrictEqual(calls, [false, true, true], 'only the first call may type credentials');

  const calls2 = [];
  const once2 = loginOnce(async (p, s, o) => { calls2.push(o.noAttempt); return { status: 'already', reason: '' }; });
  await once2(null, 'hirist', {});
  await once2(null, 'hirist', {});
  assert.deepStrictEqual(calls2, [false, false], 'a reused session does not use up the attempt');

  // the real ensureLoggedIn with noAttempt never navigates or types
  let navigated = false;
  const page = { url: () => 'https://www.instahyre.com/login/', goto: async () => { navigated = true; } };
  const r = await ensureLoggedIn(page, 'instahyre', { creds: { email: 'a@b.c', password: 'x' }, noAttempt: true });
  assert.strictEqual(r.status, 'failed');
  assert.ok(!navigated, 'noAttempt: no login page visit');
  assert.ok(loginMessage('instahyre', r.reason).includes('node auto-apply-runner.js instahyre login'));

  console.log('site-login: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

// ---- user-facing message ----
const msg = loginMessage('linkedin', 'checkpoint');
assert.ok(msg.includes('node auto-apply-runner.js linkedin login'), 'message tells the user what to run');
assert.ok(msg.includes('checkpoint'), 'message carries the reason');
