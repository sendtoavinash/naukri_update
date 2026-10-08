/**
 * Instahyre Auto-Apply — injected by auto-apply-runner.js (`node auto-apply-runner.js instahyre`).
 * Personal data comes from .env via window.__APPLY_CONFIG; nothing PII is hard-coded.
 *
 * The runner signs in by itself (site-login.js: /login/ form → INSTAHYRE_EMAIL /
 * INSTAHYRE_PASSWORD) and injects this script on the two list pages only:
 * /candidate/opportunities/?matching=true (the profile-matched "Recommended jobs" feed)
 * and /search-jobs?skills=…&years=…&location=… (keyword search).
 *
 * WHAT IT DOES (DOM confirmed by the FEAT-003 live probe):
 * - Both list pages are AngularJS: each card is a div.employer-block repeated by
 *   ng-repeat="opp in opportunities …" whose scope holds the opportunity (job id,
 *   title, company, keywords, public job URL). The script reads that scope (read-only)
 *   and falls back to the card's "Company - Title" heading / href.
 * - Instahyre shows NO posted date anywhere (cards, job modal, job page, scope data)
 *   and has NO sort control. Job ids are sequential (/job-<id>-…), so each page's
 *   cards are processed highest id first as the newest-first proxy; there is no
 *   freshness skip because there is no date to read.
 * - Relevance gate per card: title blocklist, then the shared resume scorer
 *   (relevance.js, globalThis.__relevance) on title + card text (skills tags + note).
 * - Each relevant job's public page (/job-<id>-<slug>/) is opened in ONE same-origin
 *   popup the script drives; it reads the JD and locates the ".apply-button" "Apply
 *   now" button. That button submits on the FIRST click (it calls submitChoice(opp,
 *   true) / submitChoiceNonMatching(), i.e. the update_interest API, then toasts
 *   "Application sent to <company>!") — there is no confirm step or questionnaire.
 * - Dry run: logs the button it would click and clicks nothing that can submit.
 *   Live: clicks it once and counts the job only when the "Application sent" toast
 *   shows or the button turns into an applied state; otherwise logs a calibration dump.
 * - "Not interested" is never clicked (it is a submit too: submitChoice(opp, false)).
 * - When a page is exhausted it clicks the in-page "Next »" pager (no reload; up to
 *   MAX_PAGES), else returns so the runner rotates to the next search.
 */
(async function instahyreAutoApply() {
  'use strict';

  const __CFG = (typeof window !== 'undefined' && window.__APPLY_CONFIG) || {};

  // ======================= CONFIG =======================
  const CONFIG = {
    DRY_RUN: true,             // runner flips via --live; true = locate Apply now, never click it
    MAX_APPLICATIONS: 5,       // runner overrides with perRun / what is left of the daily cap
    // Human pace between applications (randomised between min/max).
    MIN_DELAY_MS: 45000,
    MAX_DELAY_MS: 120000,
    MAX_PAGES: 5,              // in-page pagination depth per search before handing back
    geminiKey: __CFG.geminiKey || '',   // optional: Gemini API key for unmatched questions

    // Kept for the shared list parsers and as the no-relevance-module fallback only;
    // the live gate is blocklist + resume-relevance score.
    TITLE_KEYWORDS: [
      'java', 'spring', 'backend', 'back end', 'full stack', 'fullstack',
      'software engineer', 'software developer', 'sde', 'microservices', 'kafka',
      'platform engineer', 'member of technical staff', 'developer', 'engineer',
    ],
    // Senior / lead / staff are deliberately NOT blocked: this is a ~7 yr backend profile.
    TITLE_BLOCKLIST: [
      'director', 'vice president', 'head of', 'manager', 'intern', 'trainee', 'fresher',
      'qa', 'test', 'sdet', 'devops', 'sre', 'designer', 'sales', 'marketing', 'support',
      '.net', 'c#', 'php', 'ruby', 'ios', 'android', 'flutter', 'salesforce', 'sap', 'mainframe',
    ],
  };

  // ======================= CV DATA (from .env via the runner) =======================
  const CV = __CFG.CV || {
    name: '', email: '', phone: '', location: '', currentRole: '', company: '', education: '',
    yearsOfExperience: '', yearsNumber: '1', skills: '', highlights: ['', '', '', '', ''], noticePeriod: '',
    currentCTC: '', expectedCTC: '', currentSalary: '', expectedSalary: '', dob: '', gender: '',
    workAuth: '', github: '', linkedin: '', portfolio: '', links: '', remoteOk: '', relocate: '', startDate: '',
  };

  // ============== QUESTION → ANSWER BANK ==============
  // Instahyre's apply is one click with no questionnaire (probe), so this bank is a
  // safety net for a question form appearing later. First pattern that matches wins.
  // References ONLY CV (check-setup evaluates this array on its own). Stack answers are
  // built from CV.skills / CV.highlights rather than a hard-coded stack.
  const QA_BANK = [
    [/company name|current (company|employer)|organi[sz]ation/i, CV.company],
    [/notice period|when can you (start|join)|start date|joining|how soon/i, CV.noticePeriod],
    [/current .{0,15}(ctc|salary|compensation|annual)/i, CV.currentCTC],
    [/(expected|desired) .{0,15}(ctc|salary|compensation|pay)|salary expectation/i, CV.expectedCTC],
    [/years? of (work |professional |total |relevant )?experience|how (long|many years)|total experience|relevant experience/i, CV.yearsNumber || '1'],
    [/remote|work from home|wfh/i, CV.remoteOk],
    [/reloc|move to|shift to|based out of|work from (our )?office|commute|on-?site/i, CV.relocate],
    [/e-?mail/i, CV.email], // before location: "Email address" must not hit /address/
    [/where are you .{0,15}(based|located)|current location|city|address/i, CV.location],
    [/visa|sponsorship|work authorization|legally authorized|right to work|citizen/i, CV.workAuth],
    [/\blinkedin\b/i, CV.linkedin],
    [/\bgithub\b/i, CV.github],
    [/portfolio|personal website/i, CV.portfolio],
    [/linkedin|github|portfolio|website|link/i, CV.links],
    [/why (do you want|are you interested|this role|this company|us|join)/i,
      `I build and run production backend systems end to end. ${CV.highlights[0] || ''}. This role matches the stack I work in every day.`],
    [/tell (us|me) about yourself|introduce yourself|about you|summary/i,
      `I'm ${CV.name}, ${CV.currentRole}. ${CV.highlights[0] || ''}. ${CV.highlights[1] || ''}. ${CV.highlights[2] || ''}.`],
    [/skill|tech(nology)? stack|tools|framework|java|spring|microservice|backend|back-end|api/i,
      `Hands-on with ${CV.skills.split(',').slice(0, 10).join(',').trim()}. ${CV.highlights[0] || ''}.`],
    [/education|degree|university|college|qualification/i, CV.education],
    [/phone|contact number|mobile/i, CV.phone],
    [/^name$|your name|full name|candidate name|first name/i, CV.name],
  ];

  const GENERIC_ANSWER = `I'm ${CV.name}, ${CV.currentRole}. ` + (CV.highlights[0] || '') + '.';

  // ======================= HELPERS =======================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const humanDelay = () => sleep(CONFIG.MIN_DELAY_MS + Math.random() * (CONFIG.MAX_DELAY_MS - CONFIG.MIN_DELAY_MS));
  const log = (...a) => console.log('%c[auto-apply]', 'color:#1fa1d6;font-weight:bold', ...a);
  const txt = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  // getClientRects, not offsetParent: offsetParent is null for position:fixed nodes
  // (the job page's apply bar becomes fixed on scroll).
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.disabled;

  // Angular-bound inputs ignore plain .value writes: native setter + input/change.
  function setValue(el, value) {
    const win = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype
                : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function labelTextOf(el) {
    const doc = el.ownerDocument;
    return (
      el.closest('label')?.textContent ||
      (el.id && doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.closest('div')?.previousElementSibling?.textContent ||
      el.parentElement?.textContent || ''
    ).replace(/\s+/g, ' ').trim();
  }

  function findButtonByText(root, regex) {
    return [...root.querySelectorAll('button, a, [role="button"], [type="submit"]')]
      .find((b) => visible(b) && regex.test(txt(b)) && txt(b).length < 40);
  }

  async function waitFor(fn, timeoutMs = 10000, pollMs = 300) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      let res = null;
      try { res = fn(); } catch (e) { /* popup mid-navigation */ }
      if (res) return res;
      await sleep(pollMs);
    }
    return null;
  }

  async function answerQuestion(questionText) {
    for (const [pattern, answer] of QA_BANK) {
      if (pattern.test(questionText) && String(answer ?? '').trim()) return answer;
    }
    if (CONFIG.geminiKey) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${CONFIG.geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text:
                `You are answering a job application question on my behalf. Answer in first person, 1-3 sentences, professional, no markdown. If the question expects a number, answer with just the number.\n\nMy CV:\n${JSON.stringify(CV)}\n\nQuestion: ${questionText}` }] }],
            }),
          }
        );
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      } catch (e) {
        log('Gemini call failed, using generic answer:', e.message);
      }
    }
    return GENERIC_ANSWER;
  }

  // ======================= SELECTORS (from the FEAT-003 probe) =======================
  const SELECTORS = {
    // list pages: /candidate/opportunities/?matching=true and /search-jobs?…
    cardBlock: '[ng-repeat^="opp in opportunities"]',   // div.employer-block, one per job
    cardAnchor: 'a#employer-profile-opportunity',        // href on /search-jobs, ng-click modal on opportunities
    cardHeading: 'h2.company-name',                      // "Company - Title"
    nextPage: 'li[ng-click="nextPage()"]',               // "Next »"; class "hidden" on the last page
    // job page /job-<id>-<slug>/ (inside the popup)
    detailTitle: 'h1',
    detailJD: '#job-description',
    applyButton: '.apply-button button',                 // "Apply now": submits on the first click
    applyButtonText: /^apply now$/i,
    appliedText: /^(applied|application sent|already applied)/i,
    externalApplyText: /company (site|website)|apply on|external/i,
    appliedToast: /application sent to|applied successfully|successfully applied|already applied/i,
    dialog: '.application-modal, .app-modal, [role="dialog"]',
    dialogSubmitText: /^(submit|send|done|save|continue|next)\b/i,
    // header: logged in = "SIGN OUT" link, logged out = "Log in" link
    logoutLink: 'a[href$="/logout/"]',
    loginLink: 'a.login-link[href*="/login"]',
  };

  // ======================= CROSS-PAGE STATE =======================
  const STORE_KEY = 'autoApplyInstahyre';
  let state;
  try { state = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { state = {}; }
  // Dry and live keep separate seen-lists so a dry run never hides jobs from a live run.
  const SEEN_KEY = CONFIG.DRY_RUN ? 'seenDry' : 'seen';
  if (!Array.isArray(state[SEEN_KEY])) state[SEEN_KEY] = [];
  if (typeof state.applied !== 'number') state.applied = 0;
  const saveState = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} };

  // ======================= RELEVANCE (shared scorer) =======================
  const RELEVANCE_THRESHOLD = Number.isFinite(__CFG.relevanceThreshold) ? __CFG.relevanceThreshold : 50;
  const blocklisted = (t) => {
    const lower = t.toLowerCase();
    return CONFIG.TITLE_BLOCKLIST.some((k) => lower.includes(k));
  };
  // {ok, score, reason, via}: blocklist pre-filter, then relevance.js scoreJob.
  const relevantEnough = async (title, text) => {
    if (blocklisted(title)) return { ok: false, score: 0, reason: 'title blocklisted', via: 'blocklist' };
    const R = (typeof globalThis !== 'undefined' && globalThis.__relevance) ||
              (typeof window !== 'undefined' && window.__relevance);
    if (!R) {
      const lower = title.toLowerCase();
      const ok = CONFIG.TITLE_KEYWORDS.some((k) => lower.includes(k));
      return { ok, score: ok ? 100 : 0, reason: 'relevance module unavailable — title-keyword fallback', via: 'fallback' };
    }
    const r = await R.scoreJob({ title, text }, CV, { apiKey: CONFIG.geminiKey, threshold: RELEVANCE_THRESHOLD });
    return { ok: r.score >= RELEVANCE_THRESHOLD, score: r.score, reason: r.reason, via: r.via };
  };

  // ======================= BOT CHECKS =======================
  // Instahyre sits behind Cloudflare. A challenge / captcha is never fought: report it
  // and stop; the runner writes the 24 h block marker and tells the user to run login.
  function blocked(doc) {
    if (!doc || !doc.body) return null;
    const frames = [...doc.querySelectorAll('iframe')].map((f) => f.src || '');
    if (frames.some((s) => /recaptcha|hcaptcha|arkoselabs|funcaptcha|challenges\.cloudflare|turnstile/i.test(s))) return 'captcha';
    if (/just a moment/i.test(doc.title)) return 'cloudflare';
    const body = (doc.body.innerText || '').slice(0, 4000);
    if (/verify you are human|checking your browser/i.test(body)) return 'cloudflare';
    if (/i.m not a robot|press and hold|unusual (traffic|activity)/i.test(body)) return 'captcha';
    return null;
  }
  const loggedOut = (doc) => !doc.querySelector(SELECTORS.logoutLink) &&
    [...doc.querySelectorAll(SELECTORS.loginLink)].some(visible);

  // ======================= CARD PARSING =======================
  // /job-<id>-<slug>/ → id. Job ids are sequential, so a higher id is a newer posting.
  const jobIdOf = (href) => ((String(href || '').match(/\/job-(\d+)-/) || [])[1] || '');

  // The card's Angular scope (read-only): {job: {id, title, opportunity_url|public_url,
  // locations, keywords}, employer: {company_name}}. null when Angular is not reachable.
  function oppOf(el) {
    try {
      const ng = window.angular;
      const s = ng && ng.element(el).scope();
      return (s && s.opp) || null;
    } catch (e) { return null; }
  }

  function readCards() {
    const out = [];
    const ids = new Set();
    for (const block of document.querySelectorAll(SELECTORS.cardBlock)) {
      if (!visible(block)) continue;
      const anchor = block.querySelector(SELECTORS.cardAnchor);
      const heading = txt(block.querySelector(SELECTORS.cardHeading));   // "Company - Title"
      const opp = oppOf(block);
      const j = (opp && opp.job) || {};
      const rel = j.opportunity_url || j.public_url || (anchor && anchor.getAttribute('href')) || '';
      let link;
      try { link = rel ? new URL(rel, location.origin).origin + new URL(rel, location.origin).pathname : ''; } catch (e) { link = ''; }
      const id = String(j.id || jobIdOf(link));
      if (!link || !id || ids.has(id)) continue;
      // the runner's supervisor closes any non-main tab whose URL contains "/apply" or
      // matches injectOn; a (theoretical) slug like that would kill the popup mid-job
      if (/\/apply|candidate\/opportunities|search-jobs/i.test(link)) continue;
      ids.add(id);
      const company = (opp && opp.employer && opp.employer.company_name) || j.hiring_company_name ||
        (heading.includes(' - ') ? heading.split(' - ')[0] : '');
      const title = j.title || j.candidate_title ||
        (heading.includes(' - ') ? heading.split(' - ').slice(1).join(' - ') : heading);
      out.push({
        el: block, id, link, title, company,
        location: j.locations || '',
        text: (txt(block) + ' ' + (Array.isArray(j.keywords) ? j.keywords.join(', ') : '')).slice(0, 1500),
      });
    }
    // Newest first by job id (no dates and no sort control on Instahyre).
    return out.sort((x, y) => Number(y.id) - Number(x.id));
  }

  // ======================= QUESTIONNAIRE (live only, inside popup) =======================
  // Not seen in the probe (the apply is one click); kept so an unexpected question
  // dialog is answered from QA_BANK instead of being abandoned half-filled.
  async function fillQuestionnaire(dlg) {
    const YES = /^(yes|willing|open to|agree|immediate|i am able|i can)/i;
    const fields = [...dlg.querySelectorAll('input, textarea, select')]
      .filter((el) => visible(el) && !/hidden|file|submit|button/i.test(el.type || ''));
    const radioGroups = new Set();
    for (const el of fields) {
      const q = labelTextOf(el);
      if (el.type === 'radio') {
        if (radioGroups.has(el.name)) continue;
        radioGroups.add(el.name);
        const group = fields.filter((r) => r.type === 'radio' && r.name === el.name);
        const pick = group.find((r) => YES.test(labelTextOf(r))) || group[0];
        pick.click();
        log(`  ☑ picked: "${labelTextOf(pick).slice(0, 50)}"`);
        continue;
      }
      if (el.type === 'checkbox') continue; // consent boxes are left to the user / calibration
      if (el.value) continue;
      const answer = String(await answerQuestion(q));
      if (el.tagName === 'SELECT') {
        const opts = [...el.options].filter((o) => o.value);
        const pick = opts.find((o) => o.text.toLowerCase().includes(answer.toLowerCase())) ||
                     opts.find((o) => YES.test(o.text)) || opts[0];
        if (pick) setValue(el, pick.value);
      } else {
        setValue(el, el.type === 'number' ? (answer.match(/\d+(\.\d+)?/) || [CV.yearsNumber || '1'])[0] : answer);
      }
      log(`  ✍ Q: "${q.slice(0, 60)}" → "${answer.slice(0, 40)}"`);
      await sleep(400 + Math.random() * 600);
    }
    const send = findButtonByText(dlg, SELECTORS.dialogSubmitText);
    if (!send) { log('  ⚠ questionnaire: no submit button found'); return false; }
    send.click();
    return true;
  }

  // ======================= ONE JOB (popup) =======================
  // Returns true (applied / would apply), false (skipped or failed) or 'stop'.
  async function applyInPopup(popup, job) {
    popup.location.href = job.link;
    const doc = () => popup.document;
    const found = await waitFor(() => {
      const d = doc();
      // Setting location.href does not swap the document immediately: until the new
      // page commits, popup.document is still the PREVIOUS job (readyState complete).
      // Only accept the document once it is actually the requested job.
      if (!d || d.readyState !== 'complete') return null;
      const b = blocked(d);
      if (b) return { kind: 'blocked', b };
      if (jobIdOf(d.location.href) !== job.id) return null;
      const btns = [...d.querySelectorAll(SELECTORS.applyButton)].filter(visible);
      const btn = btns.find((x) => SELECTORS.applyButtonText.test(txt(x)));
      const ext = findButtonByText(d, SELECTORS.externalApplyText);
      if (ext && !btn) return { kind: 'external', btn: ext };
      const applied = btns.find((x) => SELECTORS.appliedText.test(txt(x))) ||
        [...d.querySelectorAll('.apply-button')].find((x) => visible(x) && SELECTORS.appliedText.test(txt(x)));
      if (applied) return { kind: 'applied' };
      if (btn) return { kind: 'apply', btn };
      if (loggedOut(d)) return { kind: 'logged-out' };
      return null;
    }, 25000);

    if (!found) { log('  ⚠ no "Apply now" button found on the job page — skipping.'); return false; }
    if (found.kind === 'blocked') { log(`🔒 BLOCKED: ${found.b}`); return 'stop'; }
    if (found.kind === 'logged-out') { log('⚠ job page shows the Log in link — session lost. Run: node auto-apply-runner.js instahyre login'); return 'stop'; }
    if (found.kind === 'applied') { log('  already applied — skipping.'); return false; }
    if (found.kind === 'external') { log(`  ⏭ external apply — skipping ("${txt(found.btn).slice(0, 40)}")`); return false; }

    const d = doc();
    const title = txt(d.querySelector(SELECTORS.detailTitle)) || job.title;
    log(`▶ Applying: ${title} @ ${job.company || '?'} | ${job.link}`);

    if (CONFIG.DRY_RUN) {
      log(`  🔍 DRY_RUN — would click: "${txt(found.btn)}". Nothing was sent.`);
      return true;
    }

    const applyBtn = found.btn;
    const dialogsBefore = new Set([...d.querySelectorAll(SELECTORS.dialog)].filter(visible));
    applyBtn.click();

    // Re-read popup.document on every check: an apply can navigate the popup.
    // POSITIVE confirmation only: the "Application sent" toast, or an "Applied" label on
    // THIS job's page. A popup that closed, navigated away (login redirect, error page)
    // or just lost the Apply button is NOT an application.
    const confirmed = () => {
      if (popup.closed) return false;
      const dd = doc();
      if (!dd || !dd.body) return false;
      const toast = dd.querySelector('#toast-container');
      if (toast && SELECTORS.appliedToast.test(txt(toast))) return true;
      if (jobIdOf(dd.location.href) !== job.id) return false;
      // the Angular template swaps the "Apply now" button for an "Applied" one
      if (applyBtn.isConnected && visible(applyBtn) && SELECTORS.appliedText.test(txt(applyBtn))) return true;
      return [...dd.querySelectorAll(`${SELECTORS.applyButton}, .apply-button`)]
        .some((x) => visible(x) && SELECTORS.appliedText.test(txt(x)));
    };
    const outcome = await waitFor(() => {
      const dd = doc();
      if (!dd || !dd.body) return null;
      if (blocked(dd)) return 'blocked';
      if (confirmed()) return 'applied';
      const dlg = [...dd.querySelectorAll(SELECTORS.dialog)].find((x) => !dialogsBefore.has(x) && visible(x) &&
        x.querySelector('input:not([type="hidden"]):not([type="checkbox"]), textarea, select'));
      return dlg ? { dlg } : null;
    }, 12000);
    if (outcome === 'blocked') { log(`🔒 BLOCKED: ${blocked(doc())}`); return 'stop'; }
    if (outcome && outcome.dlg) {
      log('  📝 question dialog — answering from the QA bank');
      if (!(await fillQuestionnaire(outcome.dlg))) return false;
    }
    const success = outcome === 'applied' || await waitFor(confirmed, 12000);
    if (success) {
      log('  ✅ application submitted (instahyre)');
      return true;
    }
    // The confirmation could not be verified: dump what the page said so the
    // selectors above can be calibrated.
    const dd = doc();
    const btns = dd && dd.body ? [...dd.querySelectorAll('button')].filter(visible).map(txt).filter(Boolean).slice(0, 10) : [];
    log('  ⚠ could not confirm success — not counting it.');
    log(`  🔬 calibration — url: ${dd ? dd.location.href.slice(0, 120) : '(no document)'}`);
    log(`  🔬 calibration — visible buttons: ${JSON.stringify(btns)}`);
    log(`  🔬 calibration — page text: "${dd && dd.body ? txt(dd.body).slice(0, 300) : ''}"`);
    return false;
  }

  // ======================= MAIN LOOP =======================
  log(`Starting. DRY_RUN=${CONFIG.DRY_RUN}, max=${CONFIG.MAX_APPLICATIONS}, threshold=${RELEVANCE_THRESHOLD}`);
  if (!/(^|\.)instahyre\.com$/.test(location.hostname)) { log('⚠ Open an instahyre.com job list first.'); return; }

  // Cards render after the Angular app fetches them: wait before deciding anything.
  const ready = await waitFor(() => blocked(document) || readCards().length || null, 30000, 500);
  const b0 = blocked(document);
  if (b0) { log(`🔒 BLOCKED: ${b0}`); return; }
  if (loggedOut(document)) { log('⚠ not logged in — run: node auto-apply-runner.js instahyre login'); return; }
  if (!ready) { log('No job cards rendered after 30s — the list page may have changed.'); return; }

  const popup = window.open('about:blank', 'instahyreApplyPopup', 'width=1250,height=900');
  if (!popup) { log('🚫 POPUP BLOCKED — allow popups for instahyre.com.'); return; }

  let applied = 0;   // dry + live this injection; the runner enforces the run/day totals
  let pageNo = 1;
  let stop = false;
  // Cards rejected in this injection: not persisted (a better scorer or a Gemini key
  // may accept them later), but not re-scored and re-logged on every loop pass either.
  const rejected = new Set();
  while (applied < CONFIG.MAX_APPLICATIONS && !stop) {
    const cards = readCards();
    let job = null;
    let nSeen = 0, nFiltered = 0;
    for (const c of cards) {
      if (state[SEEN_KEY].includes(c.link)) { nSeen++; continue; }
      if (rejected.has(c.link)) { nFiltered++; continue; }
      const rel = await relevantEnough(c.title, c.text);
      if (!rel.ok) {
        nFiltered++;
        rejected.add(c.link);
        log(`  ✗ skip "${c.title.slice(0, 50)}" @ ${c.company || '?'} — score ${rel.score} < ${RELEVANCE_THRESHOLD} [${rel.via}: ${String(rel.reason).slice(0, 60)}]`);
        continue;
      }
      log(`  ✓ relevant "${c.title.slice(0, 50)}" @ ${c.company || '?'} (${c.location}) — score ${rel.score} >= ${RELEVANCE_THRESHOLD} [${rel.via}: ${String(rel.reason).slice(0, 60)}]`);
      job = c;
      break;
    }
    saveState();

    if (!job) {
      log(`(page ${pageNo}: ${cards.length} cards — ${nSeen} already seen, ${nFiltered} filtered out)`);
      const next = [...document.querySelectorAll(SELECTORS.nextPage)]
        .find((li) => visible(li) && !li.classList.contains('hidden') && !li.classList.contains('disabled'));
      if (next && pageNo < CONFIG.MAX_PAGES) {
        // In-page Angular pager (no reload): wait for a different first card.
        const firstBefore = cards[0] ? cards[0].id : '';
        log(`🌐 Next results page (${pageNo + 1})`);
        next.click();
        const changed = await waitFor(() => { const c = readCards(); return c.length && c.some((x) => x.id !== firstBefore) && !c.some((x) => x.id === firstBefore); }, 20000, 500);
        if (!changed) { log('Next page did not load — handing back to the runner.'); break; }
        pageNo++;
        window.scrollTo(0, 0);
        await sleep(1500 + Math.random() * 1500);
        continue;
      }
      log('All search pages exhausted — handing back to the runner for the next search.');
      break;
    }

    state[SEEN_KEY].push(job.link);
    saveState();
    job.el.scrollIntoView({ block: 'center' });

    const ok = await applyInPopup(popup, job);
    if (ok === 'stop') { stop = true; break; }
    if (ok === true) {
      applied++;
      if (!CONFIG.DRY_RUN) { state.applied++; saveState(); }
      log(`  progress: ${applied}/${CONFIG.MAX_APPLICATIONS} this injection`);
    }
    if (applied < CONFIG.MAX_APPLICATIONS) await humanDelay();
  }

  try { popup.close(); } catch (e) {}
  log(CONFIG.DRY_RUN
    ? `DRY RUN finished — ${applied} jobs located, nothing was sent.`
    : `Finished. ${applied} applications this injection, ${state.applied} today.`);
})();
