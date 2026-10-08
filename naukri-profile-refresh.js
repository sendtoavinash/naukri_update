/**
 * Naukri Profile Refresh — toggles a trailing "." on the resume headline
 * so the profile counts as "updated" every run.
 *
 * Hourly:  launchd runs:  node naukri-profile-refresh.js   (off-screen Chrome)
 * Debug:   node naukri-profile-refresh.js login                           (visible Chrome window)
 *
 * Login is automatic: if the Naukri session is gone, it re-signs in. It prefers
 * Naukri's own direct login (NAUKRI_EMAIL / NAUKRI_PASSWORD from .env) and falls
 * back to the Google account only when no Naukri password is set. State lives in
 * the headline itself — trailing dots cycle each run: "" → "." → ".." → "" → ...
 *
 * Also re-uploads the resume PDF whenever the "Uploaded on" date shown on
 * the profile is not today's date.
 */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");
const { CREDS, NAUKRI_CREDS, naukriProfileUrl, resumePath } = require("./config"); // credentials + profile URL come from .env, never hard-coded
const { nextHeadline, uploadedToday } = require("./naukri-helpers");
const {
  minimizeBrowserWindows,
  hideBrowserWindows,
  SHOW_FLAG,
} = require("./window-utils");

const PROFILE_URL = naukriProfileUrl;
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${PROFILE_URL}`;

const PROFILE_DIR = path.join(__dirname, ".naukri-chrome-profile");
const LOG_FILE = path.join(__dirname, "naukri-refresh.log");
const ERROR_SHOT = path.join(__dirname, "naukri-refresh-error.png");
const RESUME_PATH = resumePath; // set RESUME_FILE in .env to change which PDF is uploaded
const LOGIN_MODE = process.argv[2] === "login";
// Re-upload the CV even when the profile already shows today's date — needed when
// you swap in a different PDF, since the date check alone would skip it.
const FORCE_CV = process.argv.includes("--force-cv");
// Hidden by default so an hourly run never flashes a window; --minimize keeps it in
// the taskbar, --show leaves it on screen. `node show-windows.js refresh` brings it back.
const SHOW_WINDOW = process.argv.includes("--show");
const MINIMIZE_ONLY = process.argv.includes("--minimize");

const log = (msg) => {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
};

const onProfile = (url) => url.pathname.startsWith("/mnjuser");

// Direct Naukri login via the Email ID / Password form on naukri.com/nlogin/login.
// Used whenever NAUKRI_PASSWORD is set in .env. The account signs in to Naukri
// directly; Google blocks automated sign-in and reports a correct password as wrong.
async function naukriDirectLogin(ctx, page) {
  log("Session gone — signing in with Naukri email/password...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  const emailBox = page
    .locator('input#usernameField, input[placeholder*="Email" i], input[name="email"]')
    .first();
  await emailBox.waitFor({ state: "visible", timeout: 30000 });
  await emailBox.fill(NAUKRI_CREDS.email);

  const passBox = page
    .locator('input#passwordField, input[type="password"], input[placeholder*="Password" i]')
    .first();
  await passBox.waitFor({ state: "visible", timeout: 30000 });
  await passBox.fill(NAUKRI_CREDS.password);

  await page
    .locator('button[type="submit"], button:has-text("Login"), button.loginButton')
    .first()
    .click();

  // Wait until we land on an /mnjuser page (the login redirects there on success)
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (onProfile(new URL(page.url()))) {
      log("Naukri login OK, session saved.");
      return page;
    }
    // Surface a wrong-credentials error early instead of waiting the full 90s
    const err = await page
      .locator('.server-err, .err-msg, [class*="error" i]')
      .first()
      .innerText()
      .catch(() => "");
    if (/invalid|incorrect|wrong|not registered/i.test(err)) {
      throw new Error(
        "Naukri rejected the login: " +
          err.replace(/\s+/g, " ").trim().slice(0, 120) +
          " — check NAUKRI_EMAIL / NAUKRI_PASSWORD in .env.",
      );
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(
    "Naukri direct login did not complete — credentials may be wrong, or Naukri " +
      'showed a captcha. Run "node naukri-profile-refresh.js login" and sign in once manually.',
  );
}

// Prefer the direct Naukri login when a password is configured, else Google.
async function naukriLogin(ctx, page) {
  if (NAUKRI_CREDS.password) return naukriDirectLogin(ctx, page);
  return googleLogin(ctx, page);
}

/**
 * Cycle a trailing dot on one editable profile section ("" → "." → ".." → "" → ...),
 * then verify from the server that it stuck. Shared by the resume headline and the
 * profile summary so both count as a profile update every run.
 *
 * `section` describes how to reach that section's editor:
 *   label      human name for log/error messages
 *   editIcon   selector for the pencil/edit control that opens the editor
 *   field      selector for the textarea/contenteditable holding the text
 *
 * Returns a short status string, e.g. "dot 1 added" / "dots cleared", or null when
 * the section isn't present on the profile (so a missing summary is a skip, not a
 * failure — not every Naukri profile has a summary filled in).
 */
async function cycleDotSection(page, section) {
  const editIcon = page.locator(section.editIcon);
  const field = page.locator(section.field);
  const required = section.required !== false;
  // How many times to re-run the full open sequence when the editor fails to appear.
  // Lazy widgets (the profile summary) sometimes need the scroll → click retried
  // because the editor JS isn't wired up when the first click lands.
  const openAttempts = section.openAttempts ?? 3;
  const fieldTimeout = section.fieldTimeout ?? 8000;

  // Poll until the field is actually interactive — the textarea can be in the DOM
  // and visible a moment before Naukri wires it up, which otherwise makes `fill`
  // or the follow-up read return a stale/empty value.
  async function waitEditable() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await field.first().isEditable().catch(() => false)) return;
      await page.waitForTimeout(250);
    }
  }

  // Open the section's editor: scroll its widget into view (lazy widgets like the
  // profile summary only render once visible), wait for the pencil, then click it.
  // The whole sequence runs inside a retry loop so a swallowed click or a slow lazy
  // render is recovered deterministically rather than tripping a single long waitFor.
  // `firstTime` controls whether a missing section is a skip (optional) or a fail.
  async function openEditor(firstTime) {
    let pencilAttached = false;
    for (let attempt = 1; attempt <= openAttempts; attempt++) {
      // Re-scroll on every attempt — a reload (verify step) starts at the top of the
      // page, so the lazy summary widget isn't rendered until we re-scroll to it.
      if (section.widget) {
        const w = page.locator(section.widget).first();
        await w.scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => {});
        // The widget is a data-plugin="lazyload" container; it flips
        // data-loaded="true" and hydrates its React editor only after it has been
        // scrolled into view. Wait for that flag (then a short settle) so the pencil
        // click lands on a wired-up control instead of being swallowed.
        await page
          .locator(`${section.widget}[data-loaded="true"]`)
          .first()
          .waitFor({ state: "attached", timeout: 10000 })
          .catch(() => {});
        await page.waitForTimeout(800);
      }
      // Naukri's edit pencils are often visibility:hidden until the widget is hovered,
      // so wait for the icon to be ATTACHED (not visible), hover the widget to reveal
      // it, then open the editor via `openClick` (see below).
      try {
        await editIcon.first().waitFor({ state: "attached", timeout: required ? 30000 : 15000 });
        pencilAttached = true;
      } catch {
        // The pencil never attached. If it's an optional section on the very first
        // open, treat a genuinely absent section as a skip; otherwise retry/fail.
        if (firstTime && !required) {
          log(`  ${section.label}: section not present — skipping`);
          return false;
        }
        continue;
      }
      await editIcon.first().scrollIntoViewIfNeeded().catch(() => {});
      // Hover the widget (or the icon) to un-hide the pencil before clicking.
      const hoverTarget = section.widget ? page.locator(section.widget).first() : editIcon.first();
      await hoverTarget.hover({ timeout: 5000 }).catch(() => {});
      await editIcon.first().hover({ timeout: 5000 }).catch(() => {});
      // After the first edit, Naukri injects an off-screen coachmark overlay
      // (`.ltCont`/`.ltLayer`) that spans the page, so Playwright's hit-test thinks
      // it intercepts clicks on the summary pencil and a normal click retries until
      // it times out, and a follow-up force-click (fired after that churn) often
      // doesn't register either. Dispatching the DOM `click` event straight to the
      // pencil bypasses the overlay cleanly and is proven to open the editor whether
      // or not the overlay is present, so try that FIRST, then fall back to a real
      // force-click. (`openClick` is a helper so the field-visible check below runs
      // after whichever mechanism fired.)
      const openClick = async () => {
        await editIcon.first().dispatchEvent("click").catch(() => {});
        if (await field.first().isVisible().catch(() => false)) return;
        await editIcon.first().click({ timeout: 5000, force: true }).catch(() => {});
      };
      await openClick();
      try {
        await field.first().waitFor({ state: "visible", timeout: fieldTimeout });
        await waitEditable();
        return true;
      } catch {
        // Editor didn't open — dismiss any half-open modal and re-run the whole
        // scroll → click → wait sequence on the next attempt.
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(800);
      }
    }
    // All attempts exhausted. An optional section whose pencil never attached is a
    // skip; anything else (required, or an attached pencil that wouldn't open) fails.
    if (!pencilAttached && firstTime && !required) {
      log(`  ${section.label}: section not present — skipping`);
      return false;
    }
    throw new Error(`${section.label}: editor never opened after ${openAttempts} attempts`);
  }

  if (!(await openEditor(true))) return null;

  // Read the current value from either a textarea (inputValue) or a contenteditable.
  const readValue = async () => {
    const v = await field.first().inputValue().catch(() => null);
    if (v != null) return v;
    return (await field.first().innerText().catch(() => "")) || "";
  };
  const current = (await readValue()).trimEnd();
  const dots = current.length - current.replace(/\.+$/, "").length;
  const updated = nextHeadline(current); // same dot-cycling logic as the headline

  await field.first().fill(updated);
  // The same off-screen `.ltLayer` coachmark that blocks the summary pencil also
  // makes Playwright think the Save button is intercepted, so a plain click hangs
  // and — worse — can be silently swallowed, leaving the modal to close without the
  // edit persisting (the summary intermittently read back the OLD dot count from the
  // server). Fire Save with the same proven overlay-bypass the pencil uses: dispatch
  // the DOM `click` event first, then a real force-click as a fallback.
  // Let the editor register the new value before saving: an immediate Save after
  // fill() sometimes submitted the OLD text (seen as "save did not stick" on the
  // summary). Wait until the field reports the new value, then a short settle.
  for (let i = 0; i < 10; i++) {
    if ((await readValue()).trimEnd() === updated) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(600);

  const saveBtn = page.getByRole("button", { name: /^save$/i }).first();
  // One click per attempt: dispatch the DOM click first (bypasses the overlay), and
  // only fall back to a force-click on the retries below. Firing both back to back
  // could send two saves while the first was still in flight.
  let saveTries = 0;
  const clickSave = async () => {
    if (saveTries++ === 0) await saveBtn.dispatchEvent("click").catch(() => {});
    else await saveBtn.click({ timeout: 3000, force: true }).catch(() => {});
  };
  await clickSave();
  // Poll for the editor to close rather than a single `waitFor({state:"hidden"})`:
  // the modal-close animation and the lingering coachmark overlay make a one-shot
  // hidden-wait race. Re-fire Save every ~3s while the editor is still open so a
  // swallowed Save under the overlay is retried deterministically rather than lost.
  const closeDeadline = Date.now() + 20000;
  let lastClick = Date.now();
  while (Date.now() < closeDeadline) {
    const stillVisible = await field.first().isVisible().catch(() => false);
    if (!stillVisible) break;
    if (Date.now() - lastClick > 3000) {
      lastClick = Date.now();
      await clickSave();
    }
    await page.waitForTimeout(500);
  }

  // Modal closing isn't proof the save stuck — reload and re-read from the server.
  await page.goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await openEditor(false); // re-open after reload (re-scrolls to a lazy widget)
  // Poll the readback rather than reading once: right after the re-opened editor
  // becomes editable the textarea can briefly report an empty or stale value before
  // Naukri hydrates it with the server's value, which made the one-shot read compare
  // a pre-population value against `updated` and throw a false "did not stick". Accept
  // as soon as the field reports the saved value; only fail if it never does.
  let saved = (await readValue()).trimEnd();
  const verifyDeadline = Date.now() + 8000;
  while (saved !== updated && Date.now() < verifyDeadline) {
    await page.waitForTimeout(250);
    saved = (await readValue()).trimEnd();
  }
  if (saved !== updated) {
    throw new Error(
      // show the END of the text: the trailing dots are the only part that differs
      `${section.label} save did not stick — server ends "…${saved.slice(-30)}", expected "…${updated.slice(-30)}"`,
    );
  }
  // Close the editor so the next section's reload starts clean.
  await page.keyboard.press("Escape").catch(() => {});

  return dots >= 2 ? "dots cleared" : `dot ${dots + 1} added`;
}

async function googleLogin(ctx, page) {
  log("Session gone — signing in with Google...");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Naukri's "Sign in with Google" is a plain div.socialbtn.google
  const googleBtn = page
    .locator('.socialbtn.google, [class*="socialbtn"][class*="google"]')
    .first();
  await googleBtn.waitFor({ timeout: 20000 });
  await googleBtn.click();

  // The Google sign-in may open a popup OR replace the current tab — find it either way
  let g = null;
  for (let i = 0; i < 30 && !g; i++) {
    await page.waitForTimeout(1000);
    g = ctx.pages().find((p) => /accounts\.google\./.test(p.url())) || null;
  }
  if (!g) throw new Error("Google sign-in page never appeared");
  await g.waitForLoadState("domcontentloaded");

  // Account already known to this Chrome profile → click it, else full email+password
  const knownAccount = g.locator(`[data-email="${CREDS.email}"]`).first();
  if (await knownAccount.isVisible().catch(() => false)) {
    await knownAccount.click();
  } else {
    const emailBox = g
      .locator(
        'input#identifierId, input[type="email"], input[name="identifier"]',
      )
      .first();
    await emailBox.waitFor({ state: "visible", timeout: 60000 });
    await emailBox.fill(CREDS.email);
    await g.locator('#identifierNext, button:has-text("Next")').first().click();
    const passBox = g
      .locator('input[type="password"], input[name="Passwd"]')
      .first();
    await passBox.waitFor({ state: "visible", timeout: 60000 });
    await passBox.fill(CREDS.password);
    await g.locator('#passwordNext, button:has-text("Next")').first().click();
  }

  // Wait until any tab lands back on the logged-in naukri profile
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    // consent screen ("Continue") sometimes follows the password step
    if (!g.isClosed()) {
      await g
        .locator('button:has-text("Continue")')
        .first()
        .click({ timeout: 500 })
        .catch(() => {});
    }
    const done = ctx.pages().find((p) => {
      try {
        return onProfile(new URL(p.url()));
      } catch {
        return false;
      }
    });
    if (done) {
      log("Google login OK, session saved.");
      return done;
    }
    if (g.isClosed() || /naukri\.com/.test(g.url())) {
      // auth finished but landed elsewhere — go to the profile directly
      await page
        .goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => {});
      if (onProfile(new URL(page.url()))) {
        log("Google login OK, session saved.");
        return page;
      }
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    "Google login did not complete — likely a 2-step verification prompt. " +
      'Run "node naukri-profile-refresh.js login" and approve it once manually.',
  );
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false, // naukri's Akamai bot-check blocks headless; minimised headed instead
    viewport: { width: 1280, height: 850 },
    // --window-position pins an on-screen origin; the profile still carries the old
    // -32000 bounds, which would otherwise make a restored window invisible.
    args: [
      "--disable-blink-features=AutomationControlled",
      // Hidden runs launch off-screen so the window never appears at all: hiding can
      // only happen after the window exists, which showed up as a 1-3s flash of
      // "about:blank - Google Chrome" on every hourly run. --show/--minimize/login
      // need a real on-screen origin instead, and show-windows.js moves a hidden
      // window back into view before showing it.
      SHOW_WINDOW || MINIMIZE_ONLY || LOGIN_MODE
        ? "--window-position=0,0"
        : "--window-position=-32000,-32000",
    ],
  });
  // Hidden rather than parked at -32000,-32000: off-screen made the taskbar button
  // useless, because "restoring" put the window back where no monitor reaches.
  // Pass --show to keep it on screen, --minimize to leave it in the taskbar.
  //
  // Swept on a timer, not hidden once: Chrome can take longer than a single delay to
  // put its window up, and the Google sign-in opens a further window part-way through
  // a run — either of those would otherwise sit visible for the rest of the run.
  // Paused while show-windows.js has set its flag, so it never fights a window you
  // deliberately brought up.
  let hideTimer = null;
  if (!LOGIN_MODE && !SHOW_WINDOW) {
    const stow = MINIMIZE_ONLY ? minimizeBrowserWindows : hideBrowserWindows;
    const sweep = () => {
      if (fs.existsSync(SHOW_FLAG)) return;
      stow(PROFILE_DIR).catch(() => {});
    };
    setTimeout(sweep, 1200);
    hideTimer = setInterval(sweep, 3000);
    hideTimer.unref?.(); // never hold the process open on this alone
    ctx.once("close", () => clearInterval(hideTimer));
  }
  let page = ctx.pages()[0] || (await ctx.newPage());

  try {
    await page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!onProfile(new URL(page.url()))) {
      page = await naukriLogin(ctx, page);
    }
    // login may land on /mnjuser/homepage — make sure we're on the profile itself
    if (!/\/mnjuser\/profile/.test(page.url())) {
      await page.goto(PROFILE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    // Cycle the trailing dot on BOTH the resume headline and the profile summary,
    // each verified from the server. Both edits count as a profile update, so doing
    // both keeps the profile looking freshly touched every hour.
    const headlineMsg = await cycleDotSection(page, {
      label: "headline",
      required: true, // every profile has a resume headline
      // No widget-scroll: the headline is at the top of the profile and this exact
      // selector worked reliably before the summary change was added.
      editIcon:
        '#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit',
      field: "#resumeHeadlineTxt",
    });

    // The summary is a best-effort extra: Naukri occasionally drops a summary save.
    // A miss must not fail the whole run — the headline edit already counted as the
    // profile update and the resume step below still has to run. Log it and retry
    // next hour.
    let summaryMsg = null;
    let summaryErr = "";
    try {
      summaryMsg = await cycleDotSection(page, {
        label: "summary",
        required: false, // skip gracefully if a profile has no summary filled in
        openAttempts: 3, // lazy editor sometimes needs the scroll → click retried
        // Confirmed against the live profile: widget #lazyProfileSummary lazy-loads
        // low on the page, pencil is ".edit.icon", editor textarea is #profileSummaryTxt.
        widget: "#lazyProfileSummary",
        editIcon: "#lazyProfileSummary .edit.icon, #lazyProfileSummary .icon.edit",
        field: '#profileSummaryTxt, textarea[name="profileSummary"]',
      });
    } catch (e) {
      summaryErr = e.message.split("\n")[0].slice(0, 120);
      log(`  WARN: summary not updated this run (${summaryErr}) — will retry next hour`);
      await page.keyboard.press("Escape").catch(() => {});
      // Get back to a clean profile page for the resume step. A half-finished summary
      // save can still be navigating, which aborts this goto (net::ERR_ABORTED), so
      // settle briefly and retry rather than failing the whole run.
      for (let i = 0; i < 3; i++) {
        await page.waitForTimeout(2000);
        const ok = await page
          .goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
          .then(() => true)
          .catch(() => false);
        if (ok && onProfile(new URL(page.url()))) break;
      }
    }

    // Compose a combined status: "headline dot 1 added, summary dot 1 added"
    const dotMsg = [
      `headline ${headlineMsg || "unchanged"}`,
      summaryMsg
        ? `summary ${summaryMsg}`
        : summaryErr
          ? "summary failed (retry next hour)"
          : "summary skipped",
    ].join(", ");

    // ---- resume re-upload: only when the profile's "Uploaded on" date isn't today ----
    let cvMsg = "cv up-to-date";
    // Read the whole page and parse the date right after "Uploaded on" — scoping to
    // one element was unreliable, and testing today's date against the surrounding
    // block matched the profile's "last updated" date (which this very script sets
    // to today), so the re-upload never fired.
    // The resume widget renders after domcontentloaded, so wait for it to appear
    // before reading — reading straight after the reload returned a page with no
    // "Uploaded on" text at all and failed verification on a good upload.
    const pageText = async () => {
      await page
        .getByText(/Uploaded on/i)
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
      return page
        .locator("body")
        .innerText({ timeout: 30000 })
        .catch(() => "");
    };
    if (FORCE_CV || !uploadedToday(await pageText())) {
      if (!fs.existsSync(RESUME_PATH))
        throw new Error(`resume file missing: ${RESUME_PATH}`);
      await page
        .locator('#attachCV, input[type="file"]')
        .first()
        .setInputFiles(RESUME_PATH);
      // verify from the server: reload and re-read the uploaded-on date. With
      // --force-cv the date is already today, so check the FILENAME instead —
      // that's the only proof the new PDF actually replaced the old one.
      await page.waitForTimeout(10000);
      await page.goto(PROFILE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      const after = await pageText();
      // Match the full filename, not the stem: "Ankit Baghel" alone also matches the
      // OLD "Ankit Baghel Resume-1.pdf", so a failed upload would verify clean.
      // Naukri may append "-1" before the extension on re-upload, so allow that.
      const base = path.basename(RESUME_PATH);
      const stem = path.basename(RESUME_PATH, path.extname(RESUME_PATH));
      const nameRe = new RegExp(
        `${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?\\${path.extname(RESUME_PATH)}`,
        "i",
      );
      const ok = FORCE_CV ? nameRe.test(after) : uploadedToday(after);
      if (!ok) {
        const shown = (/Uploaded on[^\n]*/i.exec(after) || [
          '(no "Uploaded on" text found)',
        ])[0];
        throw new Error(
          `cv upload did not stick — profile shows "${shown.slice(0, 80)}"`,
        );
      }
      cvMsg = `cv re-uploaded (verified: ${base})`;
    }

    log(`OK: ${dotMsg} (verified), ${cvMsg}`);
  } catch (err) {
    const pages = ctx.pages();
    for (let i = 0; i < pages.length; i++) {
      await pages[i]
        .screenshot({ path: ERROR_SHOT.replace(".png", `-${i}.png`) })
        .catch(() => {});
    }
    log(
      `ERROR: ${err.message.split("\n")[0]} (screenshots: naukri-refresh-error-*.png)`,
    );
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
})();
