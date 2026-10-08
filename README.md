# Auto-Apply

Job-application automation for **Naukri**, **Wellfound**, **Hirist**, **Instahyre** and
**LinkedIn**, plus an hourly **Naukri profile refresh** that keeps your profile looking
freshly updated for recruiter searches. Everything runs locally on macOS in a real Google
Chrome driven by Playwright, and every personal detail lives in `.env` — nothing is
hard-coded.

## Supported sites

| Site | Daily cap | Login method | Apply method |
|---|---|---|---|
| Naukri | 20 | Direct `NAUKRI_EMAIL`/`NAUKRI_PASSWORD` (Google fallback) | In-site apply + "Apply on company site" external ATS follow-through |
| Wellfound | 50 | Google login (one-time, by hand) | In-site apply + external follow-through |
| Hirist | 20 | `.env` auto-login (`HIRIST_EMAIL`/`PASSWORD`, `site-login.js`) | In-site apply |
| Instahyre | 20 | `.env` auto-login (`INSTAHYRE_EMAIL`/`PASSWORD`) | In-site apply |
| LinkedIn | 10 | `.env` auto-login (`LINKEDIN_EMAIL`/`PASSWORD`) | **Easy Apply only** (off-site jobs skipped) |

Caps are enforced across runs via `apply-state-<site>.json`; multiple logons in one day
resume the count rather than restarting it.

## Requirements

- **macOS** (scheduling is launchd-only; `os` is pinned to `darwin`)
- **Node.js 18+** (`node --version`)
- **Google Chrome** installed
- A **logged-in desktop session** — Naukri (Akamai), Wellfound (DataDome) and the others
  block headless Chrome, so every run needs a real desktop to draw into.

## Quick start

```bash
git clone https://github.com/sendtoavinash/naukri_update.git
cd naukri_update
npm install
cp .env.example .env            # then fill it in (see .env.example for every field)
# drop your resume PDF into this folder, named to match RESUME_FILE in .env
npm run check                   # read-only sanity check (flags placeholder values until .env is filled)
# one-time logins — run these AT THE DESKTOP, not over SSH:
npm run login:naukri-refresh
npm run login:naukri
npm run login:wellfound
npm run login:hirist
npm run login:instahyre
npm run login:linkedin
# dry runs (fill forms, never submit) — watch one before going live:
npm run dry:naukri
npm run dry:wellfound
npm run schedule:install        # register the six hourly launchd jobs
```

`npm run check` reports failures for placeholder credentials/highlights until you fill in
`.env` — that is expected on a fresh clone.

## Configuration

Every key the tool reads is documented and grouped in [`.env.example`](.env.example);
copy it to `.env` and fill it in. `.env` is git-ignored, so your real data is never pushed.
Notable keys:

| Variable | What it is |
|---|---|
| `NAUKRI_EMAIL` / `NAUKRI_PASSWORD` | Naukri direct login — **preferred over Google** (Google blocks automated sign-in and reports a correct password as wrong) |
| `GOOGLE_EMAIL` / `GOOGLE_PASSWORD` | Legacy fallback for Naukri sign-in; used only if `NAUKRI_PASSWORD` is empty |
| `HIRIST`/`INSTAHYRE`/`LINKEDIN_EMAIL` + `_PASSWORD` | Per-site auto-login credentials |
| `RESUME_FILE` | Resume PDF uploaded to Naukri and attached to external forms (relative to this folder, or an absolute path) |
| `CURRENT_CTC` / `EXPECTED_CTC` | In **LAKHS**, not rupees (forms are labelled LPA) |
| `RELEVANCE_THRESHOLD` | Minimum resume-relevance score to apply (0–100, default `50`; higher = stricter) |
| `GEMINI_KEY` | Optional — scores job relevance and answers unknown application questions |

Sessions are saved under `.<site>-chrome-profile/` (Naukri apply uses
`.naukri-apply-profile/`, the refresh uses `.naukri-chrome-profile/`).

## How relevance filtering works

Every job is screened in two steps (`relevance.js`):

1. **Title blocklist** — obviously off-target titles are dropped outright.
2. **Relevance score** — the job is scored 0–100 against your resume; it is applied to
   only if the score is **≥ `RELEVANCE_THRESHOLD`** (default 50). When `GEMINI_KEY` is set,
   Gemini scores it; otherwise a deterministic keyword/skill-overlap scorer is used.

Jobs are processed newest-first. To tune: raise `RELEVANCE_THRESHOLD` for fewer,
more-relevant applications; lower it to cast a wider net. Setting `GEMINI_KEY` generally
gives better scoring than keyword overlap.

## Commands

| npm script | Raw command | What it does |
|---|---|---|
| `npm run check` | `node check-setup.js --quick` | Read-only setup check (no browser) |
| `npm test` | `node relevance.test.js && node site-login.test.js && node naukri-helpers.test.js` | Browser-free unit tests |
| `npm run refresh` | `node naukri-profile-refresh.js` | Run the Naukri profile refresh once |
| `npm run login:naukri-refresh` | `node naukri-profile-refresh.js login` | One-time visible sign-in for the refresh |
| `npm run login:<site>` | `node auto-apply-runner.js <site> login` | One-time visible sign-in for a site |
| `npm run dry:<site>` | `node auto-apply-runner.js <site>` | Dry run — fills forms, never submits |
| `npm run schedule:install` | `./setup-schedule-macos.sh install` | Register the hourly launchd jobs |
| `npm run schedule:status` | `./setup-schedule-macos.sh status` | Show which jobs are loaded |
| `npm run schedule:remove` | `./setup-schedule-macos.sh remove` | Unload + delete the jobs |

`<site>` is one of `naukri | wellfound | hirist | instahyre | linkedin`. To apply for
real, add `--live` to the raw command (e.g. `node auto-apply-runner.js naukri --live`);
`--force-cv` on the refresh re-uploads the resume even if the date already shows today.

## Hourly schedule (launchd)

```bash
npm run schedule:install   # register the jobs
npm run schedule:status    # check they are loaded
npm run schedule:remove    # unload + delete them
```

Six per-user LaunchAgents run every hour while you are logged in:

| Job | Command |
|---|---|
| `com.avi.NaukriProfileRefresh` | `node naukri-profile-refresh.js` |
| `com.avi.NaukriAutoApply` | `node auto-apply-runner.js naukri --live --scheduled` |
| `com.avi.WellfoundAutoApply` | `node auto-apply-runner.js wellfound --live --scheduled` |
| `com.avi.HiristAutoApply` | `node auto-apply-runner.js hirist --live --scheduled` |
| `com.avi.InstahyreAutoApply` | `node auto-apply-runner.js instahyre --live --scheduled` |
| `com.avi.LinkedinAutoApply` | `node auto-apply-runner.js linkedin --live --scheduled` |

`--scheduled` adds a random 0–14 min jitter and only runs the apply jobs between 09:00
and 23:00, so it doesn't look like a bot firing at exactly HH:00:00 around the clock.
Run one immediately with `launchctl start com.avi.NaukriProfileRefresh`. See
[`SETUP-MACMINI.md`](SETUP-MACMINI.md) for an always-on Mac mini runbook.

## Logs and outputs

- `logs/com.avi.*.{out,err}.log` — launchd stdout/stderr per job
  (`tail -f logs/com.avi.NaukriAutoApply.out.log`)
- `naukri-refresh.log`, `auto-apply-<site>.log` — per-run history
- `applications.csv` — every submitted application (Date, Site, Role, Company, Salary, Skills, Job Link, JD)
- `apply-state-<site>.json` — the per-day counter for each site's cap
- `*-error-*.png`, `blocked-step-<site>.png` — screenshots captured on errors/blocks
- `login-blocked-<site>.json` — a 24 h skip marker written on a captcha/checkpoint

## Troubleshooting

| Symptom | Fix |
|---|---|
| launchd exit code `78` / `com.apple.provenance` in `logs/` | Never pre-create or truncate files in `logs/` from a terminal (macOS tags them). Delete the offending log file, then `launchctl unload` + `load` just that one plist. |
| Captcha / checkpoint `BLOCKED` + `login-blocked-<site>.json` appears | That site is skipped for 24 h. Run `npm run login:<site>` and finish the captcha/OTP by hand; the `login` run clears the marker. |
| Bad-credentials marker | Keyed by a hash of the creds; it clears automatically once you change that site's `.env` email/password. |
| `profile in use` | Only one process may use a Chrome profile dir at a time — stop any running job (or the matching launchd job) before running by hand. |
| `summary not updated` warning in the refresh log | Naukri occasionally drops the profile-summary save; the headline still counted as an update and the summary is retried next hour. |
| Naukri Google login blocked for automation | Set `NAUKRI_PASSWORD` in `.env` so the tool uses Naukri's direct login instead of Google. |
| `npm run check` reports failures on a fresh clone | Expected — it flags placeholder values until `.env` is filled with real data. |
| A session is logged out for good | Delete that `.<site>-chrome-profile/` folder and redo `npm run login:<site>`. |
| Want today's counter reset | Delete `apply-state-<site>.json`. |

## Adding a new site

1. Add a new entry to `SITES` in `auto-apply-runner.js` (search URLs, profile dir,
   `injectOn`, `submittedRe`, `dailyCap`, `perRun`; set `autoLogin: true` to reuse
   `site-login.js`).
2. Write a per-site injected console script (`<site>-auto-apply.js`) modelled on an
   existing one; it reads `window.__APPLY_CONFIG` for your data.
3. Add a `<SITE>_EMAIL` / `<SITE>_PASSWORD` pair to `SITE_CREDS` in `config.js` and to
   `.env.example`.
4. Relevance filtering is shared — the new site reuses `relevance.js` automatically.
5. Add a new LaunchAgent line to the `JOBS` array in `setup-schedule-macos.sh`.

## Disclaimer

`--live` submits real applications under your name. Automation may violate each site's
Terms of Service and can get an account rate-limited or banned. **LinkedIn** is the
strictest: only Easy Apply is used and its cap is deliberately low, but it can still
restrict the account. Review a dry run first; use at your own risk.
