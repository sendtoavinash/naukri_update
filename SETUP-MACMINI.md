# Running on an always-on Mac mini (hourly, native macOS)

This runs the Naukri profile refresh plus Naukri / Wellfound / Hirist / Instahyre / LinkedIn
auto-apply every hour. See [`README.md`](README.md) for the full command and configuration
reference; this is the always-on-machine runbook.

## Why native macOS (not Docker / OrbStack)

Naukri (Akamai) and Wellfound (DataDome) block **headless** browsers, so these scripts
drive a real, visible Google Chrome. A Linux container has no macOS Chrome and no display,
so the browser can't open and every run fails the bot-check. Run this **natively on the
mini's macOS desktop**, not in a container.

## Prerequisites on the mini

- macOS with **auto-login enabled** (System Settings → Users & Groups → Automatically
  log in), so there's always a logged-in desktop session for Chrome to draw into.
- A **dummy HDMI plug** if no monitor is attached — macOS needs a display to render Chrome.
- Keep the machine awake: System Settings → Displays/Battery → Energy, set **"Prevent
  automatic sleeping"** (or `caffeinate`) so hourly jobs still fire.
- **Node.js 18+** (`node --version`)
- **Google Chrome** installed
- **Git**

## One-time setup (run these on the mini)

```bash
# 1. Clone
cd ~
git clone https://github.com/sendtoavinash/naukri_update.git
cd naukri_update

# 2. Install dependencies
npm install

# 3. Create your .env from the template and fill it in
cp .env.example .env
#    - fill in NAUKRI_EMAIL/NAUKRI_PASSWORD (preferred over Google), the per-site
#      credentials, identity, CTC, links, etc. See .env.example for every field.
#    - CTC must be in LAKHS, not rupees (the forms are labelled LPA).

# 4. Add your resume PDF into this folder. Its name must match RESUME_FILE in .env
#    (there is no hard-coded resume name — whatever RESUME_FILE points to is used).

# 5. Verify everything (reads only, submits nothing)
npm run check     # placeholder values are flagged until .env is filled with real data
```

## One-time logins (MUST be done on the mini's own desktop, not over SSH)

Each opens a visible Chrome window. Sign in, approve any 2-step prompt, then close the
window. The session saves into `.*-chrome-profile/` and is reused.

```bash
npm run login:naukri-refresh    # Naukri profile-refresh session
npm run login:naukri            # Naukri apply session
npm run login:wellfound         # Wellfound session (Google)
npm run login:hirist            # these three otherwise auto-login from .env
npm run login:instahyre
npm run login:linkedin          # recommended by hand for LinkedIn
```

## Dry run first (strongly recommended)

Fills forms but never submits. Watch one run before going live.

```bash
npm run refresh                 # quick: cycles the headline dot + resume
npm run dry:wellfound           # dry run (no --live)
npm run dry:naukri              # dry run (no --live)
```

## Install the hourly schedule (launchd)

```bash
npm run schedule:install
npm run schedule:status         # verify all six are loaded
```

This registers six LaunchAgents that run every hour while you're logged in:

| Job | Command |
|---|---|
| `com.avi.NaukriProfileRefresh` | `node naukri-profile-refresh.js` |
| `com.avi.NaukriAutoApply`      | `node auto-apply-runner.js naukri --live --scheduled` |
| `com.avi.WellfoundAutoApply`   | `node auto-apply-runner.js wellfound --live --scheduled` |
| `com.avi.HiristAutoApply`      | `node auto-apply-runner.js hirist --live --scheduled` |
| `com.avi.InstahyreAutoApply`   | `node auto-apply-runner.js instahyre --live --scheduled` |
| `com.avi.LinkedinAutoApply`    | `node auto-apply-runner.js linkedin --live --scheduled` |

`--scheduled` adds a random 0–14 min jitter and only runs the apply jobs 09:00–23:00, so
it doesn't look like a bot firing at exactly HH:00:00 around the clock.

Daily caps are enforced across runs: Naukri 20, Wellfound 50, Hirist 20, Instahyre 20,
LinkedIn 10 per day.

### Useful commands

```bash
launchctl start com.avi.NaukriProfileRefresh   # run one now, for testing
npm run schedule:status                        # check what's loaded
npm run schedule:remove                        # unload + delete all six
tail -f logs/com.avi.WellfoundAutoApply.out.log
```

Per-run logs also go to `naukri-refresh.log`, `auto-apply-wellfound.log`, etc. and every
submitted application is appended to `applications.csv`.

## Heads-up

- The Chrome window is **visible** on the mini during each run (window-hiding is
  Windows-only). On an always-on mini used only for this, that's fine.
- `--live` submits real applications under your name. Auto-applying may violate each
  site's Terms of Service (LinkedIn is the strictest) and can get an account rate-limited
  or banned. Review a dry run before enabling `--live`. Use at your own risk.
- To pause just one job: `npm run schedule:remove` then re-install, or
  `launchctl unload ~/Library/LaunchAgents/com.avi.WellfoundAutoApply.plist`.
