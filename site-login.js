/**
 * Automatic email/password login for the sites the runner signs in to by itself
 * (entries with `autoLogin: true` in auto-apply-runner.js SITES: hirist, instahyre,
 * linkedin). Modeled on naukriDirectLogin in naukri-profile-refresh.js: fill email,
 * fill password, click submit, poll for success or an error message.
 *
 * Escape hatch, not a bypass: when a site answers with a captcha, OTP / PIN prompt,
 * security checkpoint, email verification or a Cloudflare challenge, this module
 * gives up (one attempt per run, no retries) and the runner tells the user to run
 * `node auto-apply-runner.js <site> login` once at the desktop. A block marker file
 * keeps later scheduled runs from retrying for 24 h — repeated automated logins
 * right after a checkpoint are exactly what gets an account restricted.
 *
 * Credential values are never logged: messages only name the .env KEYS.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

// Blocker patterns, checked in this order; the first match wins. Each entry may test
// the page url, the document title, the visible body text and/or the iframe urls.
// The OTP pattern needs an actual entry prompt ("Enter the 6-digit code", "we sent you
// a code"): a bare "Login with OTP" button on a normal login form is not a blocker.
const BLOCKERS = [
  {
    kind: 'checkpoint',
    url: /linkedin\.com\/checkpoint\/|\/uas\/.*challenge|\/authwall/i,
    text: /security check|verify it.s you|security verification/i,
  },
  {
    kind: 'captcha',
    frame: /recaptcha|hcaptcha|arkoselabs|funcaptcha/i,
    text: /captcha|i.m not a robot|press and hold/i,
  },
  {
    kind: 'cloudflare',
    title: /just a moment/i,
    text: /checking your browser|verify you are human/i,
  },
  {
    kind: 'otp',
    text: /enter (the )?(otp|code|pin|verification code|\d-digit)|we (have )?sent (a|an|you a) (code|otp|pin)|one[- ]time password/i,
  },
  {
    kind: 'email-verification',
    text: /verify your email|confirm your email|check your (email|inbox)/i,
  },
];

// An invisible reCAPTCHA (LinkedIn's login page always carries one, FEAT-004) is a
// background score, not a challenge shown to the user: never a blocker on its own.
const INVISIBLE_FRAME = /[?&]size=invisible\b/i;

/**
 * Pure: classify a page snapshot. Returns
 * 'checkpoint' | 'captcha' | 'cloudflare' | 'otp' | 'email-verification' | null.
 * frameSrcs must list only VISIBLE iframes (snapshot() filters them).
 */
function detectBlocker({ url = '', title = '', text = '', frameSrcs = [] } = {}) {
  const frames = frameSrcs.filter((s) => s && !INVISIBLE_FRAME.test(s));
  // "This site is protected by reCAPTCHA" footers are not a challenge either
  text = String(text).replace(/protected by (re|h)captcha[^.\n]*/gi, '');
  for (const b of BLOCKERS) {
    if (b.url && b.url.test(url)) return b.kind;
    if (b.title && b.title.test(title)) return b.kind;
    if (b.text && b.text.test(text)) return b.kind;
    if (b.frame && frames.some((s) => b.frame.test(s))) return b.kind;
  }
  return null;
}

// Node-side page helpers (page = Playwright Page)
const exists = (page, sel) => page.locator(sel).count().then((n) => n > 0).catch(() => false);
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

// Only iframes the user can actually see: a hidden / off-screen / tiny captcha frame
// is not a challenge (page.frames() would list every one of them).
const VISIBLE_FRAMES_JS = `[...document.querySelectorAll('iframe')].filter((f) => {
  const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
  if (r.width < 40 || r.height < 40) return false;
  if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
  if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
  return f.checkVisibility ? f.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
}).map((f) => f.src || '')`;

async function snapshot(page) {
  const [title, text, frameSrcs] = await Promise.all([
    page.title().catch(() => ''),
    page.evaluate('document.body ? document.body.innerText.slice(0, 4000) : ""').catch(() => ''),
    page.evaluate(VISIBLE_FRAMES_JS).catch(() => []),
  ]);
  return { url: page.url(), title, text, frameSrcs };
}

// Text of the error elements that are actually rendered (innerText of a hidden node
// still returns its text, so filter on layout boxes).
const visibleErrorText = (page, sel) => page.evaluate((s) =>
  [...document.querySelectorAll(s)]
    .filter((el) => el.getClientRects().length)
    .map((el) => el.innerText || '')
    .join(' ').replace(/\s+/g, ' ').trim().slice(0, 300), sel).catch(() => '');

// Click the first VISIBLE match of a locator (sites often render a hidden mobile copy
// of the same control first in DOM order). No-op when nothing visible matches.
async function clickVisibleExact(loc) {
  for (let i = 0, n = await loc.count().catch(() => 0); i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 10000 }); return true; }
  }
  return false;
}

// Hirist (probe, FEAT-002): logged in = the header profile avatar
// ([data-testid="header-profile-avatar-container"]) is rendered AND no visible "Login"
// button (logged-out header). The avatar check keeps a half-hydrated page, which has
// neither, from reading as logged in.
async function hiristLoggedIn(page) {
  if (!/hirist\.tech/.test(page.url())) return false;
  if (!(await exists(page, '[data-testid="header-profile-avatar-container"], img[alt="user_profile"]'))) return false;
  const btns = page.getByRole('button', { name: 'Login', exact: true });
  for (let i = 0, n = await btns.count().catch(() => 0); i < n; i++) {
    if (await btns.nth(i).isVisible().catch(() => false)) return false;
  }
  return true;
}

const DEFAULT_ERROR_RE = /incorrect|invalid|wrong|doesn.t match|not registered|couldn.t find/i;
const DEFAULT_ERROR_SEL = '[role="alert"], [class*="error" i], [class*="alert" i]';

// Per-site login descriptors.
//   loginUrl, isLoggedIn(page) → bool, emailSel, passwordSel, submitSel,
//   preLogin(page)? (e.g. switch an OTP-first form to "Login with password"),
//   errorRe (wrong-credentials text), errorSel? (where that text appears).
const SITE_LOGIN = {
  linkedin: {
    loginUrl: 'https://www.linkedin.com/login',
    isLoggedIn: async (page) =>
      !/\/(login|checkpoint|uas|authwall)/.test(page.url()) &&
      /linkedin\.com/.test(page.url()) &&
      exists(page, '#global-nav, .global-nav__me, header.global-nav'),
    // Probe (FEAT-004): the redesigned /login has obfuscated ids (_R_…), no #username /
    // session_key, and a HIDDEN copy of the form first in DOM order — so match on the
    // input type and only visible nodes (Playwright :visible). Old ids kept as fallback.
    emailSel: 'input[type="email"]:visible, #username:visible, input[name="session_key"]:visible',
    passwordSel: 'input[type="password"]:visible',
    submitSel: 'form:has(input[type="password"]:visible) button[type="submit"]:visible, button[type="submit"]:visible',
    errorSel: '#error-for-username, #error-for-password, .alert-content, [role="alert"]',
    errorRe: DEFAULT_ERROR_RE,
  },
  // Confirmed by probe in FEAT-002: there is no /login page (it redirects home); the
  // header "Login" button opens a MUI dialog that defaults to OTP ("Email or Mobile
  // Number" + "Get OTP") with a "Use Password to Login" link that swaps in an
  // email + password <form> (input[name=email] / input[name=password], submit "Login").
  hirist: {
    loginUrl: 'https://www.hirist.tech/',
    isLoggedIn: hiristLoggedIn,
    preLogin: async (page) => {
      // The page hydrates a few seconds after domcontentloaded; a click before that
      // does nothing, so retry until the dialog's OTP/email field shows up.
      const field = page.locator('input[name="otpIdentifier"], [role="dialog"] input[name="email"]').first();
      for (let i = 0; i < 4 && !(await field.isVisible().catch(() => false)); i++) {
        await page.waitForTimeout(2500);
        await clickVisibleExact(page.getByRole('button', { name: 'Login', exact: true }));
        await field.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      }
      await page.waitForTimeout(800 + Math.random() * 700);
      await clickVisibleExact(page.getByText('Use Password to Login', { exact: true }));
      await page.waitForTimeout(800 + Math.random() * 700);
    },
    emailSel: '[role="dialog"] form input[name="email"]',
    passwordSel: '[role="dialog"] form input[name="password"]',
    submitSel: '[role="dialog"] form button[type="submit"]',
    errorSel: '[role="dialog"] [role="alert"], [role="dialog"] .Mui-error, [role="dialog"] [class*="error" i], .MuiSnackbar-root, .MuiAlert-message',
    errorRe: DEFAULT_ERROR_RE,
  },
  // Confirmed by probe in FEAT-003: /login/ is a plain Django form (input#email,
  // input#password, CSRF token, button[type=submit] "Log in"); Cloudflare's "Just a
  // moment..." clears by itself in headed Chrome. Logged-in pages (/candidate/... and
  // /search-jobs) carry the header "SIGN OUT" link (a[href="/logout/"]); logged-out
  // pages show the header "Log in" link (a.login-link) instead.
  instahyre: {
    loginUrl: 'https://www.instahyre.com/login/',
    isLoggedIn: async (page) =>
      /instahyre\.com/.test(page.url()) && !/\/login/.test(page.url()) &&
      (await exists(page, 'a[href$="/logout/"]')) &&
      !(await visible(page, 'a.login-link[href*="/login"]')),
    emailSel: 'input#email',
    passwordSel: 'input#password',
    submitSel: 'form:has(#password) button[type="submit"]',
    errorRe: DEFAULT_ERROR_RE,
  },
};

const KEY = (siteKey) => siteKey.toUpperCase();

/**
 * One login attempt. Returns { status, reason, badCreds? } with status
 * 'already' | 'logged-in' | 'blocked' | 'failed' | 'no-creds'.
 * badCreds: true only when the site definitely rejected the email/password.
 * noAttempt: only check the saved session, never type credentials (used after this
 * run's one attempt, see loginOnce).
 * reason is safe to log: it never contains a credential value.
 */
async function ensureLoggedIn(page, siteKey, { creds = {}, log = () => {}, noAttempt = false } = {}) {
  const d = SITE_LOGIN[siteKey];
  const K = KEY(siteKey);
  // Belt and braces: any message that could echo a typed value gets scrubbed.
  const scrub = (s) => {
    let out = String(s || '');
    for (const v of [creds.email, creds.password]) if (v) out = out.split(v).join('<redacted>');
    return out;
  };
  if (!d) return { status: 'failed', reason: `no login descriptor for ${siteKey}` };
  try {
    if (await d.isLoggedIn(page)) { log('already logged in'); return { status: 'already', reason: '' }; }
    if (noAttempt) return { status: 'failed', reason: "still logged out after this run's one auto-login attempt" };
    if (!creds.password) return { status: 'no-creds', reason: `${K}_PASSWORD not set in .env` };
    if (!creds.email) return { status: 'no-creds', reason: `${K}_EMAIL (or EMAIL) not set in .env` };

    await page.goto(d.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Cloudflare's "Just a moment..." usually clears by itself in a headed Chrome
    for (let t = Date.now(); Date.now() - t < 30000 && /just a moment/i.test(await page.title().catch(() => ''));) {
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1500 + Math.random() * 1500);
    // the login URL may redirect straight into the app when the session is still valid
    if (await d.isLoggedIn(page)) { log('already logged in'); return { status: 'already', reason: '' }; }
    let blocker = detectBlocker(await snapshot(page));
    if (blocker) return { status: 'blocked', reason: blocker };

    if (d.preLogin) await d.preLogin(page);

    // Type like a person (per-key delay) rather than an instant fill.
    const type = async (sel, value) => {
      const box = page.locator(sel).first();
      await box.waitFor({ state: 'visible', timeout: 30000 });
      await box.click();
      await box.fill('');
      await box.pressSequentially(value, { delay: 60 + Math.random() * 80 });
    };
    try {
      await type(d.emailSel, creds.email);
      await page.waitForTimeout(500 + Math.random() * 1000);
      await type(d.passwordSel, creds.password);
    } catch (e) {
      // the form never showed up: a challenge page in its place is the usual reason
      blocker = detectBlocker(await snapshot(page));
      if (blocker) return { status: 'blocked', reason: blocker };
      return { status: 'failed', reason: 'login form not found on ' + d.loginUrl };
    }
    await page.waitForTimeout(500 + Math.random() * 1000);
    // The click itself may time out when the page navigates mid-click (seen on LinkedIn,
    // FEAT-004 probe: the login succeeded but click() threw) — let the poll decide.
    await page.locator(d.submitSel).first().click({ timeout: 15000 }).catch(() => {});

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      // Logged-in first: a real feed can contain words like "captcha" in user content,
      // and every isLoggedIn already excludes the challenge URLs.
      if (await d.isLoggedIn(page)) { log(`logged in with ${K}_EMAIL`); return { status: 'logged-in', reason: '' }; }
      blocker = detectBlocker(await snapshot(page));
      if (blocker) return { status: 'blocked', reason: blocker };
      const err = await visibleErrorText(page, d.errorSel || DEFAULT_ERROR_SEL);
      if ((d.errorRe || DEFAULT_ERROR_RE).test(err)) {
        return { status: 'failed', badCreds: true, reason: badCredsReason(siteKey) };
      }
    }
    return { status: 'failed', reason: 'login did not complete' };
  } catch (e) {
    return { status: 'failed', reason: scrub(String((e && e.message) || e).split('\n')[0]).slice(0, 120) };
  }
}

const badCredsReason = (siteKey) =>
  `bad credentials — the site rejected them; fix ${KEY(siteKey)}_EMAIL / ${KEY(siteKey)}_PASSWORD in .env`;

// One-way fingerprint of the .env credentials, so a bad-credentials marker can tell
// when they were changed. The marker stores ONLY this hash, never the values.
function credsHash(site, creds = {}) {
  return crypto.createHash('sha256')
    .update(`naukri_update:${site}\0${creds.email || ''}\0${creds.password || ''}`)
    .digest('hex').slice(0, 32);
}

// One auto-login attempt per runner invocation: the first call may type credentials,
// later calls (after a browser restart) only reuse the saved session.
function loginOnce(ensure = ensureLoggedIn) {
  let attempted = false;
  return async (page, siteKey, opts = {}) => {
    const r = await ensure(page, siteKey, { ...opts, noAttempt: attempted });
    if (r.status !== 'already') attempted = true;
    return r;
  };
}

// ---- block marker: login-blocked-<site>.json {at, reason, credsHash?} ----
// Captcha/OTP/checkpoint markers expire after 24 h. A bad-credentials marker (has
// credsHash) does not expire: it lasts until the .env credentials change or
// `node auto-apply-runner.js <site> login` clears it.
const blockFile = (site, dir = __dirname) => path.join(dir, `login-blocked-${site}.json`);

function writeBlock(site, reason, dir = __dirname, extra = {}) {
  try { fs.writeFileSync(blockFile(site, dir), JSON.stringify({ at: new Date().toISOString(), reason, ...extra })); } catch (e) {}
}

// The active marker, else null. currentHash = credsHash() of today's .env credentials.
function readBlock(site, dir = __dirname, maxAgeMs = DAY_MS, currentHash) {
  let b;
  try { b = JSON.parse(fs.readFileSync(blockFile(site, dir), 'utf8')); } catch (e) { return null; }
  if (b.credsHash) {
    if (currentHash && currentHash !== b.credsHash) { clearBlock(site, dir); return null; } // creds were fixed
    return b;
  }
  const age = Date.now() - new Date(b.at).getTime();
  return Number.isFinite(age) && age < maxAgeMs ? b : null;
}

function clearBlock(site, dir = __dirname) {
  try { fs.unlinkSync(blockFile(site, dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

const loginMessage = (site, reason) =>
  `🔒 ${site}: ${reason} — not bypassing it. At the desktop, run: node auto-apply-runner.js ${site} login`;

module.exports = {
  BLOCKERS, detectBlocker, SITE_LOGIN, ensureLoggedIn, loginOnce, credsHash, badCredsReason,
  blockFile, writeBlock, readBlock, clearBlock, loginMessage,
};
