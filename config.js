/**
 * Loads all personal data + credentials from .env so nothing sensitive lives in code.
 * Tiny hand-rolled parser — no dependency needed for a flat KEY=value file.
 */
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const E = loadEnv(path.join(__dirname, '.env'));
const g = (k, d = '') => (E[k] != null && E[k] !== '' ? E[k] : (process.env[k] || d));

if (!g('NAME') || !g('EMAIL')) {
  console.warn('[config] .env missing or empty — copy .env.example to .env and fill it in.');
}

const CV = {
  name: g('NAME'),
  email: g('EMAIL'),
  phone: g('PHONE'),
  location: g('LOCATION'),
  currentRole: g('CURRENT_ROLE'),
  company: g('COMPANY') || (g('CURRENT_ROLE').split(' at ')[1] || '').split(' (')[0],
  education: g('EDUCATION'),
  yearsOfExperience: g('YEARS_EXPERIENCE'),
  yearsNumber: (g('YEARS_EXPERIENCE').match(/\d+/) || ['1'])[0], // numeric-only chatbot fields
  skills: g('SKILLS'),
  highlights: g('HIGHLIGHTS').split('||').map((s) => s.trim()).filter(Boolean),
  // application answers
  noticePeriod: g('NOTICE_PERIOD'),
  currentCTC: g('CURRENT_CTC'),                 // bare number for chatbots, e.g. "10"
  expectedCTC: g('EXPECTED_CTC'),               // e.g. "18-25"
  currentSalary: g('CURRENT_CTC') + ' LPA',     // formatted for free-text fields
  expectedSalary: g('EXPECTED_CTC') + ' LPA',
  dob: g('DOB'),
  gender: g('GENDER'),
  workAuth: g('WORK_AUTH', 'Authorized to work in my country of residence.'),
  // links
  github: g('GITHUB_URL'),
  linkedin: g('LINKEDIN_URL'),
  portfolio: g('PORTFOLIO_URL'),
  links: `GitHub: ${g('GITHUB_URL')} | LinkedIn: ${g('LINKEDIN_URL')} | Portfolio: ${g('PORTFOLIO_URL')}`,
  // derived sentences
  remoteOk: 'Yes, I am fully set up for remote work and also open to hybrid/onsite.',
  relocate: `Yes, I am open to relocation. I am currently based in ${g('LOCATION')}.`,
  startDate: `I can start within ${g('NOTICE_PERIOD')}.`,
};

const CREDS = { email: g('GOOGLE_EMAIL') || g('EMAIL'), password: g('GOOGLE_PASSWORD') };
// Naukri's own direct login (Email ID / Password on naukri.com/nlogin/login).
// Preferred over Google when set — the automatic profile-refresh re-login uses it,
// which avoids Google's anti-automation "wrong password" block for accounts that
// sign in to Naukri directly rather than via Google.
const NAUKRI_CREDS = {
  email: g('NAUKRI_EMAIL') || g('EMAIL'),
  password: g('NAUKRI_PASSWORD'),
};
// Email/password logins for the sites the runner signs in to by itself (site-login.js).
// Keyed by the runner's site name so it can look up SITE_CREDS[site] with no per-site
// branches. Email falls back to EMAIL, like NAUKRI_CREDS; a missing password means
// "no auto-login" and the run asks for a one-time manual `login` instead.
const SITE_CREDS = {
  hirist: { email: g('HIRIST_EMAIL') || g('EMAIL'), password: g('HIRIST_PASSWORD') },
  instahyre: { email: g('INSTAHYRE_EMAIL') || g('EMAIL'), password: g('INSTAHYRE_PASSWORD') },
  linkedin: { email: g('LINKEDIN_EMAIL') || g('EMAIL'), password: g('LINKEDIN_PASSWORD') },
};
const geminiKey = g('GEMINI_KEY');
// Resume-relevance gate: a job is applied to only if it is NOT blocklisted AND its
// relevance score (0-100) is >= this threshold. Default 50; override via
// RELEVANCE_THRESHOLD in .env. Higher = stricter. Coerced to a number and clamped 0-100.
const relevanceThreshold = (() => {
  const n = Number(g('RELEVANCE_THRESHOLD', '50'));
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
})();
const naukriProfileUrl = g('NAUKRI_PROFILE_URL', 'https://www.naukri.com/mnjuser/profile');
// The PDF uploaded to the Naukri profile and attached to external application forms.
// Relative names resolve against the repo folder; an absolute path is used as-is.
const resumePath = path.resolve(__dirname, g('RESUME_FILE', 'Ankit Baghel.pdf'));

module.exports = { CV, CREDS, NAUKRI_CREDS, SITE_CREDS, geminiKey, naukriProfileUrl, resumePath, relevanceThreshold };
