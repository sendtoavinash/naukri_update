#!/bin/bash
# ============================================================
#  macOS equivalent of setup-schedule.ps1 (which is Windows-only).
#  Registers three hourly automation jobs with launchd (the native macOS scheduler).
#
#    Install:  ./setup-schedule-macos.sh install
#    Status:   ./setup-schedule-macos.sh status
#    Remove:   ./setup-schedule-macos.sh remove
#    Run one now (for testing):  launchctl start com.avi.NaukriProfileRefresh
#
#  No sudo needed: these are per-user LaunchAgents that run in your login session,
#  which they must — Naukri (Akamai) and Wellfound (DataDome) block headless Chrome,
#  so every run needs a real desktop to draw into.
#
#  IMPORTANT: window-utils.js only hides the browser on Windows. On macOS the Chrome
#  window is VISIBLE for the duration of each run. The profile refresh is quick; the
#  apply runs can take up to ~100 minutes.
#
#  Prerequisite: you must have completed the one-time interactive logins first, so the
#  saved sessions exist under .naukri-chrome-profile / .wellfound-chrome-profile /
#  .naukri-apply-profile. Without them these jobs run but apply to nothing.
# ============================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$(command -v node || true)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$REPO/logs"

# label | node script + args | interval seconds
JOBS=(
  "com.avi.NaukriProfileRefresh|naukri-profile-refresh.js"
  "com.avi.NaukriAutoApply|auto-apply-runner.js naukri --live --scheduled"
  "com.avi.WellfoundAutoApply|auto-apply-runner.js wellfound --live --scheduled"
)
INTERVAL=3600  # every hour

plist_path() { echo "$AGENTS_DIR/$1.plist"; }

# Build a <string> array of program arguments from "node + script + args".
program_args_xml() {
  local args="$1"
  printf '    <string>%s</string>\n' "$NODE"
  for a in $args; do
    printf '    <string>%s</string>\n' "$a"
  done
}

write_plist() {
  local label="$1" args="$2"
  local plist; plist="$(plist_path "$label")"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo '  <key>Label</key>'
    echo "  <string>$label</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    program_args_xml "$args"
    echo '  </array>'
    echo '  <key>WorkingDirectory</key>'
    echo "  <string>$REPO</string>"
    echo '  <key>StartInterval</key>'
    echo "  <integer>$INTERVAL</integer>"
    echo '  <key>RunAtLoad</key>'
    echo '  <false/>'
    echo '  <key>StandardOutPath</key>'
    echo "  <string>$LOG_DIR/$label.out.log</string>"
    echo '  <key>StandardErrorPath</key>'
    echo "  <string>$LOG_DIR/$label.err.log</string>"
    echo '  <key>EnvironmentVariables</key>'
    echo '  <dict>'
    echo '    <key>PATH</key>'
    echo "    <string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>"
    echo '  </dict>'
    echo '</dict>'
    echo '</plist>'
  } > "$plist"
  echo "  wrote $plist"
}

cmd_install() {
  [ -n "$NODE" ] || { echo "ERROR: node not found on PATH"; exit 1; }
  mkdir -p "$AGENTS_DIR" "$LOG_DIR"
  echo "Repo:  $REPO"
  echo "Node:  $NODE"
  echo "Installing $(( ${#JOBS[@]} )) hourly LaunchAgents..."
  echo ""
  for job in "${JOBS[@]}"; do
    local label="${job%%|*}"
    local args="${job#*|}"
    local plist; plist="$(plist_path "$label")"
    # unload any existing version first so a re-install is clean
    launchctl unload "$plist" 2>/dev/null || true
    write_plist "$label" "$args"
    launchctl load "$plist"
    echo "  loaded $label  (every $((INTERVAL/60)) min)"
    echo ""
  done
  echo "Done. All three jobs run every hour while you are logged in."
  echo ""
  echo "Verify:        ./setup-schedule-macos.sh status"
  echo "Run one now:   launchctl start com.avi.NaukriProfileRefresh"
  echo "Logs:          $LOG_DIR/"
  echo "Remove all:    ./setup-schedule-macos.sh remove"
}

cmd_remove() {
  for job in "${JOBS[@]}"; do
    local label="${job%%|*}"
    local plist; plist="$(plist_path "$label")"
    if [ -f "$plist" ]; then
      launchctl unload "$plist" 2>/dev/null || true
      rm -f "$plist"
      echo "removed: $label"
    else
      echo "not present: $label"
    fi
  done
}

cmd_status() {
  for job in "${JOBS[@]}"; do
    local label="${job%%|*}"
    local plist; plist="$(plist_path "$label")"
    if [ ! -f "$plist" ]; then
      printf "%-32s NOT INSTALLED\n" "$label"
      continue
    fi
    # launchctl list prints "PID STATUS LABEL" for loaded jobs
    local line; line="$(launchctl list | grep "$label" || true)"
    if [ -n "$line" ]; then
      printf "%-32s LOADED   %s\n" "$label" "$line"
    else
      printf "%-32s installed but NOT loaded\n" "$label"
    fi
  done
}

case "${1:-}" in
  install) cmd_install ;;
  remove)  cmd_remove ;;
  status)  cmd_status ;;
  *) echo "Usage: $0 {install|status|remove}"; exit 1 ;;
esac
