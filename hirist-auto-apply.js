/**
 * Hirist Auto-Apply — injected by auto-apply-runner.js (`node auto-apply-runner.js hirist`).
 * Personal data comes from .env via window.__APPLY_CONFIG; nothing PII is hard-coded.
 *
 * The runner signs in by itself (site-login.js: header "Login" → "Use Password to Login"
 * → HIRIST_EMAIL / HIRIST_PASSWORD) and injects this script on search/list pages only.
 *
 * WHAT IT DOES (DOM confirmed by the FEAT-002 live probe):
 * - Reads the job cards of the current list page (a[href*="/j/"] wrapping
 *   [data-testid="job-list-1"]: job_title / job_experience / job_location / job_tag_N /
 *   date_posted). Hirist has NO sort control, so the cards of each page are processed
 *   newest-first by their "Posted today / N days ago / N weeks ago" text, and the
 *   runner's search URLs carry posting=7 (last week) + minexp/maxexp.
 * - Relevance gate per card: title blocklist, then the shared resume scorer
 *   (relevance.js, globalThis.__relevance) on title + card text.
 * - Opens each relevant job (/j/<slug>-<id>) in ONE same-origin popup it drives, reads
 *   company + JD, skips already-applied and company-site jobs, and locates the
 *   "Apply" button (button[data-track="apply-job"]).
 * - Dry run: logs the button it would click and clicks nothing that can submit.
 *   Live: clicks Apply (assumed one-click: the probe never clicked it), answers a
 *   questionnaire dialog from QA_BANK if one appears, and counts the job only when the
 *   clicked button turns "Applied" or a success toast shows.
 * - When a page is exhausted it follows the pagination "Next" link (up to page 5; the
 *   reload kills this script and the runner re-injects it), else it returns so the
 *   runner rotates to the next search.
 */
(async function hiristAutoApply() {
  'use strict';

  const __CFG = (typeof window !== 'undefined' && window.__APPLY_CONFIG) || {};

  // ======================= CONFIG =======================
  const CONFIG = {
    DRY_RUN: true,             // runner flips via --live; true = locate Apply, never click it
    MAX_APPLICATIONS: 5,       // runner overrides with perRun / what is left of the daily cap
    // Human pace between applications (randomised between min/max).
    MIN_DELAY_MS: 45000,
    MAX_DELAY_MS: 120000,
    MAX_PAGES: 5,              // pagination depth per search before handing back to the runner
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
  // evaluates this array on its own). Stack answers are built from CV.skills /
  // CV.highlights rather than a hard-coded stack.
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
  const log = (...a) => console.log('%c[auto-apply]', 'color:#ff6b3d;font-weight:bold', ...a);
  const txt = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  // getClientRects, not offsetParent: offsetParent is null for position:fixed nodes
  // (Hirist renders a sticky copy of the Apply button).
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.disabled;

  // React-controlled inputs ignore plain .value writes: native setter + input/change.
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

  // ======================= SELECTORS (from the FEAT-002 probe) =======================
  const SELECTORS = {
    // list pages (/search/<q>, /c/<category>-jobs, /k/<tag>-jobs, /jobfeed)
    cardLink: 'a[href*="/j/"]',                  // whole card is one target=_blank anchor
    cardBody: '[data-testid="job-list-1"]',
    cardTitle: '[data-testid="job_title"]',
    cardExperience: '[data-testid="job_experience"]',
    cardLocation: '[data-testid="job_location"]',
    cardPosted: '[data-testid="date_posted"]',
    nextPage: 'a.MuiPaginationItem-root',        // text "Next"; Mui-disabled on the last page
    // job detail page (/j/<slug>-<id>, inside the popup)
    detailTitle: 'h1',
    detailCompany: '[data-testid="company-name"]',
    detailJD: '[data-testid="job-description-container"]',
    applyButton: 'button[data-track="apply-job"]',
    applyButtonText: /^apply$/i,
    alreadyAppliedText: /^applied/i,
    externalApplyText: /company (site|website)|apply on|external/i,
    appliedToast: /successfully applied|applied successfully|application (sent|submitted)|you have applied/i,
    alreadyAppliedToast: /already applied/i,
    dialog: '[role="dialog"]',
    dialogSubmitText: /^(submit|apply|send|done|save|continue|next)\b/i,
    // logged-in header marker / logged-out header button
    avatar: '[data-testid="header-profile-avatar-container"], img[alt="user_profile"]',
  };

  // ======================= CROSS-PAGE STATE =======================
  const STORE_KEY = 'autoApplyHirist';
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
  // A captcha / Cloudflare challenge is never fought: report it and stop; the runner
  // writes the 24 h block marker and tells the user to run `... hirist login`.
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
  const loggedOut = (doc) => !doc.querySelector(SELECTORS.avatar) &&
    [...doc.querySelectorAll('button')].some((b) => visible(b) && /^login$/i.test(txt(b)));

  // ======================= CARD PARSING =======================
  // "Posted today" → 0, "Posted 3 days ago" → 3, "Posted 2 weeks ago" → 14, months → 30n.
  function postedDays(s) {
    const t = (s || '').toLowerCase();
    if (/today|just now|hour|minute/.test(t)) return 0;
    if (/yesterday/.test(t)) return 1;
    const m = t.match(/(\d+)\s*(day|week|month|year)/);
    if (!m) return 999; // unknown dates sort last but are not skipped
    const n = parseInt(m[1], 10);
    return m[2] === 'day' ? n : m[2] === 'week' ? 7 * n : m[2] === 'month' ? 30 * n : 365 * n;
  }
  const tooOld = (s) => /month|year/i.test(s || '') || (postedDays(s) >= 21 && postedDays(s) < 999);

  // Canonical job link without the ?ref=… tracking params; the numeric id is the key.
  const canonical = (href) => { try { const u = new URL(href, location.href); return u.origin + u.pathname; } catch (e) { return href; } };
  // /j/<slug>-<id>: the trailing number survives a slug rewrite/redirect
  const jobId = (href) => ((canonical(href).match(/\/j\/.*?(\d+)\/?$/) || [])[1] || canonical(href));

  function readCards() {
    const out = [];
    const seenIds = new Set();
    for (const a of document.querySelectorAll(SELECTORS.cardLink)) {
      const body = a.querySelector(SELECTORS.cardBody);
      const titleEl = a.querySelector(SELECTORS.cardTitle);
      if (!body || !titleEl || !visible(a)) continue;
      const link = canonical(a.href);
      // the runner's supervisor closes any non-main tab whose URL contains "/apply",
      // which would kill the popup mid-job: leave such (rare) slugs alone
      if (seenIds.has(link) || /\/apply/i.test(link)) continue;
      seenIds.add(link);
      out.push({
        el: a,
        link,
        title: txt(titleEl),
        experience: txt(a.querySelector(SELECTORS.cardExperience)),
        location: txt(a.querySelector(SELECTORS.cardLocation)),
        posted: txt(a.querySelector(SELECTORS.cardPosted)),
        text: txt(body).slice(0, 1500),
      });
    }
    // Newest first: Hirist has no sort control, so order each page by posted date.
    // Array.sort is stable, so equal dates keep Hirist's own (relevance) order.
    return out.sort((x, y) => postedDays(x.posted) - postedDays(y.posted));
  }

  // ======================= QUESTIONNAIRE (live only, inside popup) =======================
  async function fillQuestionnaire(doc, dlg) {
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
      // page commits, popup.document is still the PREVIOUS job (readyState complete),
      // and reading it attributed job N-1's title/company/button to job N. Only accept
      // the document once it is actually the requested job.
      if (!d || d.readyState !== 'complete' || jobId(d.location.href) !== jobId(job.link)) return null;
      const b = blocked(d);
      if (b) return { kind: 'blocked', b };
      const btns = [...d.querySelectorAll(SELECTORS.applyButton)].filter(visible);
      const ext = findButtonByText(d, SELECTORS.externalApplyText);
      if (ext && (!btns.length || btns.includes(ext))) return { kind: 'external', btn: ext };
      const applied = btns.find((x) => SELECTORS.alreadyAppliedText.test(txt(x))) ||
                      findButtonByText(d, SELECTORS.alreadyAppliedText);
      if (applied) return { kind: 'applied' };
      const btn = btns.find((x) => SELECTORS.applyButtonText.test(txt(x)));
      if (btn) return { kind: 'apply', btn };
      if (loggedOut(d)) return { kind: 'logged-out' };
      return null;
    }, 20000);

    if (!found) { log('  ⚠ no Apply button found on the job page — skipping.'); return false; }
    if (found.kind === 'blocked') { log(`🔒 BLOCKED: ${found.b}`); return 'stop'; }
    if (found.kind === 'logged-out') { log('⚠ job page shows the Login button — session lost. Run: node auto-apply-runner.js hirist login'); return 'stop'; }
    if (found.kind === 'applied') { log('  already applied — skipping.'); return false; }
    if (found.kind === 'external') { log(`  ⏭ external apply — skipping ("${txt(found.btn).slice(0, 40)}")`); return false; }

    const d = doc();
    const company = txt(d.querySelector(SELECTORS.detailCompany)) ||
      (job.title.includes(' - ') ? job.title.split(' - ')[0] : '');
    const title = txt(d.querySelector(SELECTORS.detailTitle)) || job.title;
    log(`▶ Applying: ${title} @ ${company || '?'} | ${job.link}`);

    if (CONFIG.DRY_RUN) {
      log(`  🔍 DRY_RUN — would click: "${txt(found.btn)}". Nothing was sent.`);
      return true;
    }

    const applyBtn = found.btn;
    const dialogsBefore = new Set(d.querySelectorAll(SELECTORS.dialog));
    applyBtn.click();

    // Re-read popup.document on every check: an apply can navigate the popup.
    const confirmed = () => {
      const dd = doc();
      if (!dd || !dd.body) return false;
      return SELECTORS.appliedToast.test(dd.body.innerText || '') ||
        (applyBtn.isConnected && SELECTORS.alreadyAppliedText.test(txt(applyBtn)));
    };
    const outcome = await waitFor(() => {
      const dd = doc();
      if (!dd || !dd.body) return null;
      if (blocked(dd)) return 'blocked';
      if (confirmed()) return 'applied';
      if (SELECTORS.alreadyAppliedToast.test(dd.body.innerText || '')) return 'duplicate';
      const dlg = [...dd.querySelectorAll(SELECTORS.dialog)].find((x) => !dialogsBefore.has(x) && visible(x) &&
        x.querySelector('input:not([type="hidden"]), textarea, select'));
      return dlg ? { dlg } : null;
    }, 12000);
    if (outcome === 'blocked') { log(`🔒 BLOCKED: ${blocked(doc())}`); return 'stop'; }
    if (outcome === 'duplicate') { log('  ↩ already applied to this job — not counting it.'); return false; }
    if (outcome && outcome.dlg) {
      log('  📝 questionnaire dialog — answering from the QA bank');
      if (!(await fillQuestionnaire(doc(), outcome.dlg))) return false;
    }
    const success = outcome === 'applied' || await waitFor(confirmed, 12000);
    if (success) {
      log('  ✅ application submitted (hirist)');
      return true;
    }
    // The confirmation wording could not be verified without a real apply: dump what
    // the page said so SELECTORS.appliedToast can be calibrated.
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
  if (!/hirist\.tech$/.test(location.hostname)) { log('⚠ Open a hirist.tech job list first.'); return; }

  // The list is client-rendered after hydration: wait for cards before deciding anything.
  const ready = await waitFor(() => blocked(document) || readCards().length || null, 30000, 500);
  const b0 = blocked(document);
  if (b0) { log(`🔒 BLOCKED: ${b0}`); return; }
  if (!ready) {
    if (loggedOut(document)) log('⚠ not logged in — run: node auto-apply-runner.js hirist login');
    else log('No job cards rendered after 30s — the list page may have changed.');
    return;
  }
  if (loggedOut(document)) { log('⚠ not logged in — run: node auto-apply-runner.js hirist login'); return; }

  const popup = window.open('about:blank', 'hiristApplyPopup', 'width=1250,height=900');
  if (!popup) { log('🚫 POPUP BLOCKED — allow popups for hirist.tech.'); return; }

  let applied = 0;   // dry + live this injection; the runner enforces the run/day totals
  let stop = false;
  // Cards rejected in this injection: not persisted (a better scorer or a Gemini key
  // may accept them later), but not re-scored and re-logged on every loop pass either.
  const rejected = new Set();
  while (applied < CONFIG.MAX_APPLICATIONS && !stop) {
    const cards = readCards();
    let job = null;
    let nSeen = 0, nOld = 0, nFiltered = 0;
    for (const c of cards) {
      if (state[SEEN_KEY].includes(c.link)) { nSeen++; continue; }
      if (rejected.has(c.link)) { nFiltered++; continue; }
      if (tooOld(c.posted)) { nOld++; continue; }
      const rel = await relevantEnough(c.title, c.text);
      if (!rel.ok) {
        nFiltered++;
        rejected.add(c.link);
        log(`  ✗ skip "${c.title.slice(0, 50)}" (${c.posted}) — score ${rel.score} < ${RELEVANCE_THRESHOLD} [${rel.via}: ${String(rel.reason).slice(0, 60)}]`);
        continue;
      }
      log(`  ✓ relevant "${c.title.slice(0, 50)}" (${c.posted}, ${c.experience}) — score ${rel.score} >= ${RELEVANCE_THRESHOLD} [${rel.via}: ${String(rel.reason).slice(0, 60)}]`);
      job = c;
      break;
    }
    saveState();

    if (!job) {
      log(`(this page: ${cards.length} cards — ${nSeen} already seen, ${nOld} too old, ${nFiltered} filtered out)`);
      const pageNo = parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
      const next = [...document.querySelectorAll(SELECTORS.nextPage)]
        .find((a) => /^next$/i.test(txt(a)) && !/Mui-disabled/.test(a.className) && a.getAttribute('href'));
      if (next && pageNo < CONFIG.MAX_PAGES) {
        log(`🌐 Next results page (${pageNo + 1}) — the page reloads and the runner re-injects.`);
        popup.close();
        location.href = next.href;
        return;
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
