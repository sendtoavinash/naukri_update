# Running on an always-on Mac mini (hourly, native macOS)

This runs the Naukri profile refresh plus Naukri/Wellfound auto-apply every hour.

## Why not Docker / OrbStack

Naukri (Akamai) and Wellfound (DataDome) block **headless** browsers, so these
scripts drive a real, visible Google Chrome. A Linux container has no macOS Chrome
and no display, so the browser can't open and every run fails the bot-check. Run
this **natively on the mini's macOS desktop**, not in a container.

## Prerequisites on the mini

- macOS with **auto-login enabled** (System Settings → Users & Groups → Automatically
  log in), so there's always a logged-in desktop session for Chrome to draw into.
  A dummy HDMI plug helps if there's no monitor attached.
- **Node.js 18+**  →  `node --version`
- **Google Chrome** installed
- Git

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
#    - open .env, fill in GOOGLE_EMAIL/PASSWORD, identity, CTC (in LAKHS, e.g. 27),
#      links, etc. See .env.example for every field.
#    - CTC must be in lakhs, not rupees (the forms are labelled LPA).

# 4. Add your resume PDF into this folder, matching RESUME_FILE in .env
#    (default name: "Avinash Upadhyay.pdf")

# 5. Verify everything (reads only, submits nothing)
node check-setup.js --quick     # should be all green except the CSV/browser warnings
```

## One-time logins (MUST be done on the mini's own desktop, not over SSH)

Each opens a visible Chrome window. Sign in with Google, approve any 2-step prompt,
then close the window. The session saves into `.*-chrome-profile/` and is reused.

```bash
node naukri-profile-refresh.js login       # Naukri profile-refresh session
node auto-apply-runner.js naukri login      # Naukri apply session
node auto-apply-runner.js wellfound login   # Wellfound session
```

## Dry run first (strongly recommended)

Fills forms but never submits. Watch one run before going live.

```bash
node naukri-profile-refresh.js              # quick: cycles the headline dot + resume
node auto-apply-runner.js wellfound         # dry run (no --live)
node auto-apply-runner.js naukri            # dry run (no --live)
```

## Install the hourly schedule (launchd)

```bash
./setup-schedule-macos.sh install
./setup-schedule-macos.sh status            # verify all three are loaded
```

This registers three LaunchAgents that run every hour while you're logged in:

| Job | Command |
|---|---|
| `com.avi.NaukriProfileRefresh` | `node naukri-profile-refresh.js` |
| `com.avi.NaukriAutoApply`      | `node auto-apply-runner.js naukri --live --scheduled` |
| `com.avi.WellfoundAutoApply`   | `node auto-apply-runner.js wellfound --live --scheduled` |

`--scheduled` adds a random 0-14 min jitter and only runs 09:00–23:00, so it doesn't
look like a bot firing at exactly HH:00:00 around the clock.

Daily caps are enforced across runs: Naukri 20/day, Wellfound 50/day.

### Useful commands

```bash
launchctl start com.avi.NaukriProfileRefresh   # run one now, for testing
./setup-schedule-macos.sh status               # check what's loaded
./setup-schedule-macos.sh remove               # unload + delete all three
tail -f logs/com.avi.WellfoundAutoApply.out.log
```

Per-run logs also go to `naukri-refresh.log`, `auto-apply-wellfound.log`, etc. and
every submitted application is appended to `applications.csv`.

## Heads-up

- The Chrome window is **visible** on the mini during each run (window-hiding is
  Windows-only). On an always-on mini used only for this, that's fine.
- `--live` submits real applications under your name. Auto-applying may violate
  Naukri's / Wellfound's Terms of Service and can get an account rate-limited or
  banned. Review a dry run before enabling `--live`. Use at your own risk.
- To pause just one job: `./setup-schedule-macos.sh remove` then re-install, or
  `launchctl unload ~/Library/LaunchAgents/com.avi.WellfoundAutoApply.plist`.
