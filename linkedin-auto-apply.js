/**
 * LinkedIn Easy Apply — injected by auto-apply-runner.js (`node auto-apply-runner.js linkedin`).
 * Personal data comes from .env via window.__APPLY_CONFIG; nothing PII is hard-coded.
 *
 * The runner signs in by itself (site-login.js, LINKEDIN_EMAIL / LINKEDIN_PASSWORD) and
 * stops on any checkpoint / captcha / OTP — this script never fights one either.
 *
 * WHAT IT DOES (list/detail DOM confirmed by the FEAT-004 probe; modal from the plan):
 * - Works the two-pane search page (/jobs/search/?…&f_AL=true&sortBy=DD — Easy Apply
 *   only, newest first). Cards are li[data-occludable-job-id]; LinkedIn renders their
 *   content only once scrolled into view, so the list is scrolled in jittered steps.
 * - Per card: skip without an "Easy Apply" footer or with "Applied"; click it (SPA, no
 *   reload), wait for the detail pane, read the JD, relevance gate = title blocklist
 *   then the shared scorer (relevance.js, globalThis.__relevance) on title + JD.
 * - The detail button must read exactly "Easy Apply" (anything else = off-site, skipped).
 * - Easy Apply modal: up to MAX_STEPS steps, each filled from CV / QA_BANK (text, numeric,
 *   select, radio, required consent checkboxes, typeahead); resume preselected → go on,
 *   else live asks the runner to attach RESUME_FILE (📎 UPLOAD_RESUME).
 * - Dry run: walks Next / Review, STOPS at "Submit application" (never clicks it),
 *   logs it, then Dismiss → Discard. Live: clicks Submit and counts the job only when
 *   LinkedIn confirms "Your application was sent".
 * - One tab, no popups, 2-6 s jitter after every card click, 90-180 s between applies.
 */
(async function linkedinAutoApply() {
  'use strict';

  const __CFG = (typeof window !== 'undefined' && window.__APPLY_CONFIG) || {};

  // ======================= CONFIG =======================
  const CONFIG = {
    DRY_RUN: true,             // runner flips via --live; true = fill the modal, never submit
    MAX_APPLICATIONS: 3,       // runner overrides with perRun / what is left of the daily cap
    // LinkedIn restricts accounts for automation: keep a slow, human pace.
    MIN_DELAY_MS: 90000,
    MAX_DELAY_MS: 180000,
    MAX_STEPS: 8,              // Easy Apply modal steps before giving up on a job
    MAX_PAGES: 3,              // result pages per search before handing back to the runner
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
  // First pattern that matches the question text wins. References ONLY CV (check-setup
  // evaluates this array on its own). Numeric inputs keep just the digits of the answer.
  const QA_BANK = [
    [/company name|current (company|employer)|organi[sz]ation/i, CV.company],
    // "Notice period (in days)" is a numeric field on LinkedIn: digits of CV.noticePeriod
    [/notice period.{0,20}(days|number)|how many days.{0,30}(notice|join)/i, (String(CV.noticePeriod || '').match(/\d+/) || ['0'])[0]],
    [/notice period|when can you (start|join)|start date|joining|how soon/i, CV.noticePeriod],
    [/current .{0,15}(ctc|salary|compensation|annual)/i, CV.currentCTC],
    [/(expected|desired) .{0,15}(ctc|salary|compensation|pay)|salary expectation/i, CV.expectedCTC],
    // "How many years of work experience do you have with Java / Spring Boot / Kafka?"
    [/years? of (work |professional |total |relevant )?experience|how (long|many years)|total experience|relevant experience|experience (do you have )?(with|in)/i, CV.yearsNumber || '1'],
    [/remote|work from home|wfh/i, CV.remoteOk],
    [/reloc|move to|shift to|based out of|work from (our )?office|commut|on-?site|hybrid/i, CV.relocate],
    [/e-?mail/i, CV.email], // before location: "Email address" must not hit /address/
    [/mobile phone|phone number|contact number|mobile number|\bphone\b|\bmobile\b/i, CV.phone],
    [/where are you .{0,15}(based|located)|current location|city|address/i, CV.location],
    [/visa|sponsorship|work authorization|legally authorized|right to work|citizen/i, CV.workAuth],
    [/\blinkedin\b/i, CV.linkedin],
    [/\bgithub\b/i, CV.github],
    [/portfolio|personal website/i, CV.portfolio],
    [/linkedin|github|portfolio|website|link/i, CV.links],
    [/why (do you want|are you interested|this role|this company|us|join)/i,
      `I build and run production backend systems end to end. ${CV.highlights[0] || ''}. This role matches the stack I work in every day.`],
    [/tell (us|me) about yourself|introduce yourself|about you|summary|cover letter/i,
      `I'm ${CV.name}, ${CV.currentRole}. ${CV.highlights[0] || ''}. ${CV.highlights[1] || ''}. ${CV.highlights[2] || ''}.`],
    [/skill|tech(nology)? stack|tools|framework|java|spring|microservice|backend|back-end|api/i,
      `Hands-on with ${CV.skills.split(',').slice(0, 10).join(',').trim()}. ${CV.highlights[0] || ''}.`],
    [/education|degree|university|college|qualification/i, CV.education],
    [/^name$|your name|full name|candidate name|first name/i, CV.name],
  ];

  const GENERIC_ANSWER = `I'm ${CV.name}, ${CV.currentRole}. ` + (CV.highlights[0] || '') + '.';

  // ======================= HELPERS =======================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => sleep(min + Math.random() * (max - min));
  const humanDelay = () => sleep(CONFIG.MIN_DELAY_MS + Math.random() * (CONFIG.MAX_DELAY_MS - CONFIG.MIN_DELAY_MS));
  const log = (...a) => console.log('%c[auto-apply]', 'color:#0a66c2;font-weight:bold', ...a);
  const txt = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.disabled;

  // React/Ember-controlled inputs ignore plain .value writes: native setter + input/change.
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function labelTextOf(el) {
    return (
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
      el.closest('label')?.textContent ||
      el.getAttribute('aria-label') ||
      el.closest('fieldset')?.querySelector('legend')?.textContent ||
      el.getAttribute('placeholder') ||
      el.parentElement?.textContent || ''
    ).replace(/\s+/g, ' ').trim();
  }

  async function waitFor(fn, timeoutMs = 10000, pollMs = 300) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      let res = null;
      try { res = fn(); } catch (e) { /* SPA mid-render */ }
      if (res) return res;
      await sleep(pollMs);
    }
    return null;
  }

  async function answerQuestion(questionText) {
    for (const [pattern, answer] of QA_BANK) {
      if (pattern.test(questionText) && String(answer ?? '').trim()) return String(answer);
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

  // ======================= SELECTORS =======================
  const SELECTORS = {
    // list + detail: confirmed by the FEAT-004 probe (logged-in two-pane search page)
    card: 'li[data-occludable-job-id]',
    cardTitle: 'a.job-card-container__link, .artdeco-entity-lockup__title',
    cardCompany: '.artdeco-entity-lockup__subtitle',
    cardLocation: '.artdeco-entity-lockup__caption',
    cardFooter: '.job-card-container__footer-wrapper, .job-card-list__footer-wrapper',
    detailTitle: '.job-details-jobs-unified-top-card__job-title',
    detailCompany: '.job-details-jobs-unified-top-card__company-name',
    detailJD: '#job-details, .jobs-description__content',
    applyButton: 'button.jobs-apply-button',          // two copies (top card + sticky header)
    nextPage: 'button[aria-label="View next page"]',
    // Easy Apply modal: plan's documented selectors (not opened by the probe) — the step
    // loop below is defensive about every one of them.
    modal: '.jobs-easy-apply-modal, [data-test-modal][role="dialog"], [role="dialog"]',
    nextBtn: 'button[aria-label="Continue to next step"]',
    reviewBtn: 'button[aria-label="Review your application"]',
    submitBtn: 'button[aria-label="Submit application"]',
    fieldError: '.artdeco-inline-feedback--error',
    dismiss: 'button[aria-label="Dismiss"]',
    resumeSelected: '.jobs-document-upload-redesign-card__container--selected, [class*="document-upload"][aria-checked="true"], [class*="resume"] input[type="radio"]:checked',
    sentText: /your application was sent|application sent|application submitted/i,
  };

  // ======================= CROSS-PAGE STATE =======================
  const STORE_KEY = 'autoApplyLinkedin';
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
  // Never fought: report and stop; the runner writes the 24 h block marker and tells
  // the user to run `... linkedin login`. NOT keyed on iframes in general: every
  // logged-in jobs page embeds an invisible reCAPTCHA-enterprise anchor (probe).
  function blocked() {
    if (/\/(checkpoint|authwall|uas\/login|login)\b/.test(location.pathname)) return 'checkpoint';
    if ([...document.querySelectorAll('iframe')].some((f) => /arkoselabs|funcaptcha/i.test(f.src || '') && visible(f))) return 'captcha';
    const body = (document.body?.innerText || '').slice(0, 3000);
    if (/let.s do a quick security check|security verification|verify it.s you/i.test(body)) return 'checkpoint';
    return null;
  }

  // ======================= LIST =======================
  // The results list scrolls inside its own (obfuscated-class) container; find it as
  // the scrollable ancestor of the first card.
  function listScroller() {
    let p = document.querySelector(SELECTORS.card)?.parentElement;
    while (p && p !== document.body) {
      const oy = getComputedStyle(p).overflowY;
      if (/(auto|scroll)/.test(oy) && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return null;
  }
  // Occluded cards are empty until scrolled into view: scroll down like a person.
  async function loadAllCards() {
    const sc = listScroller();
    if (!sc) return;
    for (let i = 0; i < 14 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 5; i++) {
      sc.scrollBy({ top: 250 + Math.random() * 250, behavior: 'smooth' });
      await jitter(400, 900);
    }
    await jitter(600, 1200);
    sc.scrollTo({ top: 0, behavior: 'smooth' });
    await jitter(500, 1000);
  }

  function readCards() {
    return [...document.querySelectorAll(SELECTORS.card)].map((li) => {
      const a = li.querySelector(SELECTORS.cardTitle);
      // aria-label of the title link is the clean title (the visible text repeats it
      // inside a visually-hidden <strong>)
      const title = (a && (a.getAttribute('aria-label') || '').replace(/ with verification$/i, '').trim()) ||
        txt(li.querySelector('.artdeco-entity-lockup__title strong')) || txt(a);
      return {
        el: li,
        id: li.getAttribute('data-occludable-job-id'),
        title,
        company: txt(li.querySelector(SELECTORS.cardCompany)),
        location: txt(li.querySelector(SELECTORS.cardLocation)),
        footer: txt(li.querySelector(SELECTORS.cardFooter)) || txt(li),
      };
    }).filter((c) => c.id && c.title);
  }

  // ======================= EASY APPLY MODAL =======================
  const activeModal = () => [...document.querySelectorAll(SELECTORS.modal)]
    .find((m) => visible(m) && (m.matches('.jobs-easy-apply-modal') ||
      m.querySelector(`${SELECTORS.nextBtn}, ${SELECTORS.reviewBtn}, ${SELECTORS.submitBtn}, form`)));
  const btnIn = (root, sel) => [...root.querySelectorAll(sel)].find(visible);

  // Close without sending: Dismiss → "Discard" in the confirm dialog (never "Save").
  async function discard() {
    const m = activeModal() || document;
    const x = btnIn(m, SELECTORS.dismiss);
    if (x) x.click();
    const d = await waitFor(() => [...document.querySelectorAll('button')]
      .find((b) => visible(b) && (/^discard$/i.test(txt(b)) || b.matches('[data-control-name="discard_application_confirm_btn"]'))), 5000);
    if (d) d.click();
    await sleep(1200);
  }

  const YES = /^(yes|willing|open to|agree|immediate|i am able|i can)/i;

  // Fill every unanswered control on the current step. Never touches Submit.
  async function fillStep(modal) {
    // text / number / textarea / typeahead
    for (const el of [...modal.querySelectorAll('input, textarea')]) {
      if (!visible(el) || /hidden|file|submit|button|radio|checkbox/i.test(el.type || '')) continue;
      if (String(el.value || '').trim()) continue; // prefilled from the LinkedIn profile
      const q = labelTextOf(el);
      let answer = await answerQuestion(q);
      const numeric = el.type === 'number' || /numeric/i.test(el.id || '') || /numeric/i.test(el.className || '');
      if (numeric) answer = (answer.match(/\d+(\.\d+)?/) || [CV.yearsNumber || '1'])[0];
      setValue(el, answer);
      log(`  ✍ Q: "${q.slice(0, 60)}" → "${answer.slice(0, 40)}"`);
      // typeahead (city etc.): LinkedIn only accepts a picked suggestion
      if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) {
        const opt = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find(visible), 3000);
        if (opt) opt.click();
      }
      await jitter(400, 1000);
    }
    // selects
    for (const el of [...modal.querySelectorAll('select')]) {
      if (!visible(el)) continue;
      const opts = [...el.options].filter((o) => o.value && !/select an option/i.test(o.text));
      if (!opts.length || opts.some((o) => o.selected && o.index > 0)) continue;
      const q = labelTextOf(el);
      const answer = (await answerQuestion(q)).toLowerCase();
      const pick = opts.find((o) => answer && o.text.toLowerCase() === answer) ||
                   opts.find((o) => answer.startsWith(o.text.toLowerCase())) ||
                   opts.find((o) => YES.test(o.text)) || opts[0];
      setValue(el, pick.value);
      log(`  ☑ select "${q.slice(0, 50)}" → "${pick.text.slice(0, 40)}"`);
      await jitter(300, 800);
    }
    // radio groups (fieldsets): QA answer if it starts with yes/no, sponsorship → No, else Yes
    const groups = new Map();
    for (const r of modal.querySelectorAll('input[type="radio"]')) {
      if (!groups.has(r.name)) groups.set(r.name, []);
      groups.get(r.name).push(r);
    }
    for (const [, group] of groups) {
      if (group.some((r) => r.checked)) continue;
      const q = txt(group[0].closest('fieldset')?.querySelector('legend')) || labelTextOf(group[0]);
      if (/resume|cv/i.test(q)) continue; // resume picker handled by the resume step
      const answer = (await answerQuestion(q)).trim().toLowerCase();
      const wantNo = /require|need/i.test(q) && /sponsor|visa/i.test(q) ? true : /^no\b/.test(answer);
      const lbl = (r) => labelTextOf(r);
      const pick = group.find((r) => (wantNo ? /^no\b/i : YES).test(lbl(r))) || group[0];
      (document.querySelector(`label[for="${CSS.escape(pick.id)}"]`) || pick).click();
      log(`  ☑ "${q.slice(0, 50)}" → "${lbl(pick).slice(0, 30)}"`);
      await jitter(300, 800);
    }
    // required consent checkboxes; never the "Follow <company>" one
    for (const c of modal.querySelectorAll('input[type="checkbox"]')) {
      const l = labelTextOf(c);
      if (c.checked || /follow/i.test(l) || !/agree|terms|consent|acknowledge|confirm|certify/i.test(l)) continue;
      (document.querySelector(`label[for="${CSS.escape(c.id)}"]`) || c).click();
      log(`  ☑ checked "${l.slice(0, 50)}"`);
    }
  }

  // Resume step: preselected resume → nothing to do. Otherwise live asks the runner.
  async function handleResume(modal) {
    const file = modal.querySelector('input[type="file"]');
    if (!file || modal.querySelector(SELECTORS.resumeSelected)) return true;
    if (!/resume|cv/i.test(txt(modal))) return true; // a cover-letter-only upload is optional
    if (CONFIG.DRY_RUN) { log('  📎 would upload resume (dry run)'); return true; }
    window.__aaResumeUploaded = false;
    log('  📎 UPLOAD_RESUME');
    const ok = await waitFor(() => window.__aaResumeUploaded, 20000, 500);
    if (!ok) log('  ⚠ resume upload did not complete');
    await sleep(2000);
    return !!ok;
  }

  const stepSignature = (m) => txt(m.querySelector('h3, h2')) + '|' +
    [...m.querySelectorAll('label, legend')].map(txt).join('|').slice(0, 400) + '|' +
    (m.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') || '');

  // Returns true (applied / would apply), false (skipped or failed) or 'stop'.
  async function easyApply(btn) {
    btn.click();
    let modal = await waitFor(activeModal, 12000);
    if (!modal) { log('  ⚠ Easy Apply modal did not open — skipping.'); return false; }
    for (let step = 1; step <= CONFIG.MAX_STEPS; step++) {
      await jitter(1200, 2500);
      if (blocked()) { log(`🔒 BLOCKED: ${blocked()}`); return 'stop'; }
      modal = activeModal();
      if (!modal) { log('  ⚠ Easy Apply modal vanished — skipping.'); return false; }

      // The final step: decide BEFORE touching anything else on it.
      const submit = btnIn(modal, SELECTORS.submitBtn) ||
        [...modal.querySelectorAll('button')].find((b) => visible(b) && /^submit application$/i.test(txt(b)));
      if (submit) {
        if (CONFIG.DRY_RUN) {
          log('  🔍 DRY_RUN — would click: "Submit application". Nothing was sent.');
          await discard();
          return true;
        }
        // keep the feed clean: untick "Follow <company>" on the review step
        const follow = [...modal.querySelectorAll('input[type="checkbox"]')]
          .find((c) => c.checked && /follow/i.test(labelTextOf(c) + ' ' + (c.id || '')));
        if (follow) (document.querySelector(`label[for="${CSS.escape(follow.id)}"]`) || follow).click();
        await jitter(800, 1600);
        submit.click();
        const sent = await waitFor(() => SELECTORS.sentText.test(txt(activeModal() || document.querySelector('[role="dialog"]'))), 15000);
        if (!sent) { log('  ⚠ could not confirm "application sent" — not counting it.'); await discard(); return false; }
        log('  ✅ application submitted (linkedin)');
        await sleep(1500);
        const done = [...document.querySelectorAll('[role="dialog"] button')].find((b) => visible(b) && /^(done|dismiss)$/i.test(txt(b) || b.getAttribute('aria-label') || ''));
        if (done) done.click();
        return true;
      }

      await fillStep(modal);
      if (!(await handleResume(modal))) { await discard(); return false; }

      const next = btnIn(modal, SELECTORS.reviewBtn) || btnIn(modal, SELECTORS.nextBtn) ||
        [...modal.querySelectorAll('button')].find((b) => visible(b) && /^(next|review|continue)$/i.test(txt(b)));
      if (!next || /submit/i.test(txt(next) + (next.getAttribute('aria-label') || ''))) {
        log('  ⚠ no Next/Review button on this step — skipping.');
        await discard();
        return false;
      }
      const before = stepSignature(modal);
      await jitter(600, 1400);
      next.click();
      const moved = await waitFor(() => {
        const m = activeModal();
        if (!m) return 'gone';
        if ([...m.querySelectorAll(SELECTORS.fieldError)].some(visible)) return 'error';
        return stepSignature(m) !== before ? 'moved' : null;
      }, 6000);
      if (moved !== 'moved') {
        const m = activeModal();
        const bad = m ? [...m.querySelectorAll(SELECTORS.fieldError)].filter(visible)
          .map((e) => labelTextOf(e.closest('[class*="form-element"], fieldset, div')?.querySelector('input, select, textarea') || e).slice(0, 60)) : [];
        log(`  ⚠ step ${step} would not advance (${moved || 'no change'}) — unanswered: ${JSON.stringify(bad)}`);
        await discard();
        return false;
      }
    }
    log(`  ⚠ more than ${CONFIG.MAX_STEPS} steps — skipping.`);
    await discard();
    return false;
  }

  // ======================= MAIN LOOP =======================
  log(`Starting. DRY_RUN=${CONFIG.DRY_RUN}, max=${CONFIG.MAX_APPLICATIONS}, threshold=${RELEVANCE_THRESHOLD}`);
  if (!/linkedin\.com$/.test(location.hostname)) { log('⚠ Open a LinkedIn job search first.'); return; }

  const ready = await waitFor(() => blocked() || readCards().length || null, 30000, 500);
  const b0 = blocked();
  if (b0) { log(`🔒 BLOCKED: ${b0}`); return; }
  if (!ready) { log('No job cards rendered after 30s — not logged in, or the search page changed.'); return; }

  let applied = 0;   // dry + live this injection; the runner enforces the run/day totals
  let pages = 1;
  const rejected = new Set(); // not persisted: a better scorer may accept them later
  while (applied < CONFIG.MAX_APPLICATIONS) {
    await loadAllCards();
    let didSomething = false;
    for (const c of readCards()) {
      if (applied >= CONFIG.MAX_APPLICATIONS) break;
      if (state[SEEN_KEY].includes(c.id) || rejected.has(c.id)) continue;
      if (!/easy apply/i.test(c.footer) || /\bapplied\b/i.test(c.footer)) { rejected.add(c.id); continue; }
      if (blocklisted(c.title)) {
        rejected.add(c.id);
        log(`  ✗ skip "${c.title.slice(0, 50)}" — score 0 < ${RELEVANCE_THRESHOLD} [blocklist: title blocklisted]`);
        continue;
      }

      c.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await jitter(500, 1200);
      (c.el.querySelector(SELECTORS.cardTitle) || c.el).click();
      await jitter(2000, 6000);
      const pane = await waitFor(() => {
        const cur = new URL(location.href).searchParams.get('currentJobId');
        const t = txt(document.querySelector(SELECTORS.detailTitle));
        return (cur === c.id || (t && c.title.startsWith(t.slice(0, 20)))) && document.querySelector(SELECTORS.detailJD) ? true : null;
      }, 15000);
      const bx = blocked();
      if (bx) { log(`🔒 BLOCKED: ${bx}`); return; }
      if (!pane) { rejected.add(c.id); log(`  ⚠ detail pane did not load for "${c.title.slice(0, 50)}"`); continue; }
      didSomething = true;

      const title = txt(document.querySelector(SELECTORS.detailTitle)) || c.title;
      const company = txt(document.querySelector(SELECTORS.detailCompany)) || c.company;
      const jd = txt(document.querySelector(SELECTORS.detailJD)).slice(0, 4000);
      const rel = await relevantEnough(title, jd);
      if (!rel.ok) {
        rejected.add(c.id);
        log(`  ✗ skip "${title.slice(0, 50)}" @ ${company} — score ${rel.score} < ${RELEVANCE_THRESHOLD} [${rel.via}: ${String(rel.reason).slice(0, 60)}]`);
        continue;
      }
      log(`  ✓ relevant "${title.slice(0, 50)}" @ ${company} (${c.location}) — score ${rel.score} >= ${RELEVANCE_THRESHOLD} [${rel.via}: ${String(rel.reason).slice(0, 60)}]`);

      const btn = [...document.querySelectorAll(SELECTORS.applyButton)].find(visible);
      if (!btn || !/^easy apply$/i.test(txt(btn))) {
        rejected.add(c.id);
        log(`  ⏭ off-site apply — skipping ("${txt(btn).slice(0, 30) || 'no apply button'}")`);
        continue;
      }
      state[SEEN_KEY].push(c.id);
      saveState();
      log(`▶ Applying: ${title} @ ${company || '?'} | https://www.linkedin.com/jobs/view/${c.id}/`);

      const ok = await easyApply(btn);
      if (ok === 'stop') return;
      if (ok === true) {
        applied++;
        if (!CONFIG.DRY_RUN) { state.applied++; saveState(); }
        log(`  progress: ${applied}/${CONFIG.MAX_APPLICATIONS} this injection`);
        if (applied < CONFIG.MAX_APPLICATIONS) await humanDelay();
      } else {
        await jitter(4000, 9000);
      }
    }
    if (applied >= CONFIG.MAX_APPLICATIONS) break;
    if (didSomething) continue; // re-read: cards may have re-rendered mid-pass

    // page exhausted: SPA pager (no reload, so this injection keeps going)
    const next = document.querySelector(SELECTORS.nextPage);
    if (!next || !visible(next) || pages >= CONFIG.MAX_PAGES) {
      log('All search pages exhausted — handing back to the runner for the next search.');
      break;
    }
    const firstId = readCards()[0]?.id;
    log(`🌐 Next results page (${pages + 1})`);
    next.click();
    pages++;
    await waitFor(() => readCards()[0]?.id && readCards()[0].id !== firstId, 15000);
    await jitter(2000, 4000);
  }

  log(CONFIG.DRY_RUN
    ? `DRY RUN finished — ${applied} jobs walked to the Submit step, nothing was sent.`
    : `Finished. ${applied} applications this injection, ${state.applied} today.`);
})();
