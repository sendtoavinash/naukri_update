/**
 * relevance.js — ONE shared, site-agnostic resume-relevance scorer.
 * ================================================================
 * Replaces the old hard-coded title ALLOWLIST (TITLE_KEYWORDS filtering) with a
 * resume-relevance score. A job is applied to only if it passes the cheap
 * TITLE_BLOCKLIST guardrail (still enforced per-site) AND scores
 * >= RELEVANCE_THRESHOLD here. Used by naukri / wellfound / hirist / instahyre /
 * linkedin, and by any future site with no copy-paste: a new site is just
 * a new SITES entry in the runner that reuses this module.
 *
 * ---- WHERE EACH PATH RUNS (the architectural constraint) ----
 * The site scripts are injected INTO THE PAGE (inside an IIFE) by
 * auto-apply-runner.js, which inlines each file's raw text after setting
 * window.__APPLY_CONFIG. Code running in the page cannot make Node network calls,
 * and the runner already serializes the CV into the page the same way.
 *
 *   - keywordScore(job, cv) -> {score, reason}
 *     PURE, synchronous, NO network. Safe to run IN-PAGE (injected) or Node-side.
 *     This is the deterministic scorer and the live path when no Gemini key is set.
 *
 *   - geminiScore(job, cv, apiKey) -> Promise<{score, reason} | null>
 *     Needs network (fetch to generativelanguage.googleapis.com). Intended to run
 *     Node-side in auto-apply-runner.js (Node 20 has global fetch) OR in-page (the
 *     site scripts already call this endpoint for chatbot answers). Resolves to
 *     null on ANY error/parse failure so scoreJob falls back to keywordScore.
 *     It NEVER throws into the apply loop.
 *
 *   - scoreJob(job, cv, {apiKey, threshold}) -> Promise<{score, reason, via}>
 *     Prefers Gemini when apiKey is truthy, else uses the deterministic keyword
 *     scorer. Always resolves (falls back to keyword on Gemini failure). `via` is
 *     'gemini' or 'keyword'. `threshold` is informational (callers compare the
 *     returned score themselves); it is attached to the result for logging.
 *
 * WIRING CHOSEN HERE: the deterministic keywordScore runs IN-PAGE (injected via
 * window.__relevance, same mechanism the runner uses for the CV) because that is
 * the live no-Gemini-key path and the CV is already in the page. geminiScore is
 * exported for Node-side scoring and is the dormant path until a GEMINI_KEY is set.
 *
 * ---- DUAL ENVIRONMENT (Node require AND in-page inline) ----
 * In Node this file is a normal CommonJS module (module.exports). When the runner
 * inlines its source into the page there is no `module`, so it also attaches the
 * same functions to globalThis.__relevance. Both environments get identical code.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node: require('./relevance')
  }
  // Always expose in-page too (harmless in Node): the injected site scripts read
  // globalThis.__relevance.
  try { root.__relevance = api; } catch (e) { /* frozen global, ignore */ }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Multi-word skills/terms we want matched as whole phrases (higher signal than a
  // lone token). Kept lowercase; matched as substrings of the lower-cased job text.
  const PHRASE_TERMS = [
    'spring boot', 'react native', 'next.js', 'node.js', 'full stack', 'full-stack',
    'back end', 'front end', 'machine learning', 'generative ai', 'gen ai',
    'event-driven', 'event driven', 'ci/cd', 'rest api', 'web developer',
    'software engineer', 'software developer', 'member of technical staff',
    'microservices', 'distributed systems', 'message queue',
  ];

  // Generic developer-role terms derived from a typical backend/full-stack CV. These
  // let a bare title like "Backend Developer" with an empty JD still carry signal.
  const ROLE_TERMS = [
    'developer', 'engineer', 'backend', 'frontend', 'fullstack', 'full stack',
    'software', 'web', 'api', 'cloud', 'microservices', 'sde',
  ];

  // CORE skills that make a title genuinely relevant to the user's real profile
  // (Senior Java/Spring backend + full-stack). A title needs at least one of these
  // to earn the baseline title-floor (see keywordScore). A bare generic role word
  // ("developer"/"engineer"/"software"/"data engineer") is NOT enough on its own —
  // that generic-only path is how firmware/BI/data-eng titles used to slip through.
  const CORE_TITLE_SKILLS = [
    'java', 'spring', 'spring boot', 'microservices', 'kafka', 'node', 'node.js',
    'backend', 'back end', 'full stack', 'fullstack', 'full-stack', 'react',
    'next.js', 'rest', 'sde', 'software engineer', 'software developer',
    'web developer', 'member of technical staff',
  ];

  // Hard-negative disqualifiers: disciplines outside the user's profile. A NEGATIVE
  // term in the TITLE disqualifies outright; a NEGATIVE term only in the body
  // disqualifies ONLY when the title carries no CORE skill (so a real Java role whose
  // JD mentions an adjacent tech like "some Golang" is not killed, but "Golang
  // Developer" is). Defined ONCE here and reused by every site via scoreJob — the
  // per-site TITLE_BLOCKLIST arrays are only the cheap title-level mirror of this.
  const NEGATIVE_TERMS = [
    // firmware / embedded / hardware
    'firmware', 'embedded', 'rtos', 'verilog', 'fpga', 'vlsi', 'microcontroller',
    'c++', 'c/c++', ' vc++', 'robotics', 'perception', 'hardware',
    // BI / analytics tooling
    'power bi', 'powerbi', 'looker', 'tableau', 'qlik', 'cognos', ' bi developer',
    // data engineering / ETL
    'data engineer', 'data engineering', 'etl', 'informatica', 'abinitio',
    'datastage', 'snowflake', 'databricks',
    // PLM / enterprise platforms
    'teamcenter', 'plm', 'bmide', 'curam', 'seismic', 'sap ', 'salesforce',
    'servicenow', 'appian', 'uipath', 'rpa', 'oracle apex', 'pl/sql', 'temenos',
    'avaloq', 'saviynt', 'nexthink', 'mainframe', 'cobol',
    // other-language-primary / non-backend-java
    '.net', 'c#', ' php', ' ruby', 'golang developer', 'go developer',
    'ios developer', 'android developer', 'flutter',
    // ops-only / qa / specialist
    'sdet', 'site reliability', ' sre ', 'performance engineer', 'quant',
    'opengl', 'vulkan', 'graphics', 'compiler', 'digital imaging',
  ];

  /**
   * hardNegative(title, text) -> {hit:boolean, term:string}
   * PURE. Returns the first disqualifier found. A NEGATIVE term in the TITLE is an
   * immediate disqualify. A NEGATIVE term appearing ONLY in the body disqualifies
   * only when the title has NO core-skill signal, so a genuine Java/backend title is
   * protected from a body-only mention of an adjacent/unrelated technology.
   */
  function hardNegative(title, text) {
    const t = lower(title);
    const body = lower(text);
    for (const term of NEGATIVE_TERMS) {
      if (t.includes(term)) return { hit: true, term };
    }
    const titleHasCore = CORE_TITLE_SKILLS.some((c) => t.includes(c));
    if (!titleHasCore) {
      for (const term of NEGATIVE_TERMS) {
        if (body.includes(term)) return { hit: true, term };
      }
    }
    return { hit: false, term: '' };
  }

  // Common English/stop tokens we never want to treat as a skill signal.
  const STOP = new Set([
    'and', 'the', 'with', 'for', 'you', 'your', 'our', 'are', 'from', 'that',
    'this', 'will', 'have', 'has', 'all', 'any', 'etc', 'experience', 'years',
    'year', 'work', 'team', 'role', 'job', 'strong', 'good', 'plus', 'using',
    'use', 'knowledge', 'skills', 'skill', 'tools', 'tech', 'stack',
  ]);

  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }

  // Break a free-text string into single-word tokens (letters/digits, 2+ chars,
  // keeping things like c++ -> "c" dropped by length but js/go kept).
  function tokenize(s) {
    return lower(s)
      .split(/[^a-z0-9+#.]+/)
      .map((t) => t.replace(/^[.+#]+|[.+#]+$/g, '')) // trim stray punctuation
      .filter((t) => t.length >= 2 && !STOP.has(t));
  }

  /**
   * Build the weighted CV term set once per score call. Phrases carry more weight
   * than single tokens. Derived from skills (comma string), highlights (array),
   * currentRole and a light nudge from yearsOfExperience being present.
   */
  function buildCvTerms(cv) {
    cv = cv || {};
    const phrases = new Map(); // term -> weight
    const tokens = new Map();

    // Core skills are worth more: a Java/Spring/backend match is a far stronger
    // relevance signal than a generic token, so weight it higher. This widens the gap
    // between a real match and incidental noise so the threshold separates them cleanly.
    const coreW = (term, base) => (CORE_TITLE_SKILLS.includes(lower(term).trim()) ? base + 2 : base);
    const addPhrase = (p, w) => { p = lower(p).trim(); if (p.length >= 3) phrases.set(p, Math.max(phrases.get(p) || 0, coreW(p, w))); };
    const addToken = (t, w) => { if (t && !STOP.has(t)) tokens.set(t, Math.max(tokens.get(t) || 0, coreW(t, w))); };

    const skillsStr = lower(cv.skills || '');
    const highlightsStr = Array.isArray(cv.highlights) ? lower(cv.highlights.join(' ')) : lower(cv.highlights || '');
    const roleStr = lower(cv.currentRole || '');
    const corpus = [skillsStr, highlightsStr, roleStr].join(' ');

    // 1. Known multi-word phrases present anywhere in the CV corpus -> strong signal.
    for (const p of PHRASE_TERMS) if (corpus.includes(p)) addPhrase(p, 2);

    // 2. Each comma-separated skill: the whole skill as a phrase (if multi-word) and
    //    its individual tokens.
    for (const raw of skillsStr.split(',')) {
      const skill = raw.trim();
      if (!skill) continue;
      if (/\s/.test(skill)) addPhrase(skill, 2);
      for (const t of tokenize(skill)) addToken(t, 2);
    }

    // 3. Tokens from highlights + current role (weaker — descriptive prose).
    for (const t of tokenize(highlightsStr)) addToken(t, 1);
    for (const t of tokenize(roleStr)) addToken(t, 1);

    // 4. Generic role terms the CV supports (only those actually implied by the CV).
    for (const r of ROLE_TERMS) {
      if (corpus.includes(r)) { if (/\s/.test(r)) addPhrase(r, 1); else addToken(r, 1); }
    }

    return { phrases, tokens };
  }

  /**
   * keywordScore(job, cv) -> {score:0-100, reason}
   * PURE. job = {title, text}. Title matches weigh ~2x body matches. A floor bump
   * applies when the title itself contains a strong role term, so a bare
   * "Backend Developer" with an empty JD still clears a sane threshold.
   */
  function keywordScore(job, cv) {
    job = job || {};
    const title = lower(job.title);
    const text = lower(job.text);
    const haystackTitle = title;
    const haystackAll = title + ' \n ' + text;

    const { phrases, tokens } = buildCvTerms(cv);
    const totalWeight = [...phrases.values()].reduce((a, b) => a + b, 0) +
                        [...tokens.values()].reduce((a, b) => a + b, 0);

    if (totalWeight === 0) {
      // No CV signal at all (unconfigured). Fall back to a neutral-ish score driven
      // only by whether the title looks like a dev role, so the pipeline still runs.
      const roleHit = ROLE_TERMS.some((r) => haystackTitle.includes(r));
      return { score: roleHit ? 55 : 20, reason: roleHit ? 'title looks like a dev role (no CV skills configured)' : 'no CV skills configured and title has no dev-role term' };
    }

    let matched = 0;         // weighted CV signal found in the job text
    const hits = [];         // for the human-readable reason

    const scan = (term, weight) => {
      const inTitle = haystackTitle.includes(term);
      const inBody = !inTitle && haystackAll.includes(term);
      if (!inTitle && !inBody) return;
      // Title matches count double — the title is the strongest relevance signal.
      matched += weight * (inTitle ? 2 : 1);
      hits.push(term + (inTitle ? '(title)' : ''));
    };
    for (const [p, w] of phrases) scan(p, w);
    for (const [t, w] of tokens) scan(t, w);

    // Normalize: matched can exceed totalWeight because title matches are doubled.
    // Scale so that matching ~45% of the CV's weighted terms already clears 50.
    const coverage = matched / totalWeight; // 0 .. ~2
    let score = Math.round(Math.min(1, coverage / 0.9) * 100);

    // Title floor: a CORE-skill term in the TITLE guarantees baseline relevance even
    // when the card/JD snippet is empty (common on search result cards). This is
    // deliberately a CORE-skill signal, NOT a generic role word: a bare
    // "Developer"/"Engineer"/"Software"/"Data Engineer" title with no core skill gets
    // NO floor and keeps its (low) computed coverage, so generic/irrelevant titles
    // fall below the threshold. The floor is set to 60 (== default threshold) so a
    // legitimate core-title card with an empty JD still passes the gate. The title is
    // separator-normalized first so punctuation variants like "Full - Stack" /
    // "Full_Stack" still match the core term "full stack".
    const normTitle = haystackTitle.replace(/[\s._/\\-]+/g, ' ').trim();
    const coreTitle = CORE_TITLE_SKILLS.some((c) => {
      const nc = c.replace(/[\s._/\\-]+/g, ' ').trim();
      return haystackTitle.includes(c) || normTitle.includes(nc);
    });
    if (coreTitle && score < 60) score = 60;

    score = Math.max(0, Math.min(100, score));
    const topHits = hits.slice(0, 6).join(', ') || 'no CV terms matched';
    return { score, reason: `matched: ${topHits}` };
  }

  /**
   * geminiScore(job, cv, apiKey) -> Promise<{score, reason} | null>
   * Node-only on the default hot path (needs network). Resolves to null on any
   * failure so scoreJob falls back to keyword. Never throws into the apply loop.
   */
  async function geminiScore(job, cv, apiKey) {
    if (!apiKey) return null;
    try {
      const f = (typeof fetch !== 'undefined') ? fetch : null;
      if (!f) return null;
      const prompt =
        'You are scoring how well a job matches a candidate resume. ' +
        'Return ONLY strict minified JSON: {"score": <integer 0-100>, "reason": "<short phrase>"}. ' +
        'Score 0 = irrelevant, 100 = perfect fit. Consider skills, role, and seniority.\n\n' +
        'Candidate:\n' + JSON.stringify({
          skills: (cv && cv.skills) || '',
          highlights: (cv && cv.highlights) || [],
          currentRole: (cv && cv.currentRole) || '',
          yearsOfExperience: (cv && cv.yearsOfExperience) || '',
        }) + '\n\n' +
        'Job title: ' + String((job && job.title) || '') + '\n' +
        'Job description: ' + String((job && job.text) || '').slice(0, 4000);

      const res = await f(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      const data = await res.json();
      const raw = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      if (!raw) return null;
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      let score = Number(parsed.score);
      if (!isFinite(score)) return null;
      score = Math.max(0, Math.min(100, Math.round(score)));
      return { score, reason: String(parsed.reason || 'gemini score').slice(0, 120) };
    } catch (e) {
      return null; // any failure → caller falls back to keywordScore
    }
  }

  /**
   * scoreJob(job, cv, opts) -> Promise<{score, reason, via, threshold}>
   * Prefers Gemini when opts.apiKey is set; falls back to the deterministic keyword
   * scorer on no key or any Gemini failure. Always resolves.
   */
  async function scoreJob(job, cv, opts) {
    opts = opts || {};
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 60;
    job = job || {};

    // Hard-negative gate FIRST, applied to both the Gemini and keyword branches: a job
    // centered on a disqualifying discipline is REJECTED regardless of score by forcing
    // the score to 0, so the existing `score >= threshold` gate in every site script
    // drops it with no per-site logic.
    const neg = hardNegative(job.title, job.text);
    if (neg.hit) {
      return { score: 0, reason: `hard-negative: ${neg.term}`, via: 'negative', threshold };
    }

    if (opts.apiKey) {
      const g = await geminiScore(job, cv, opts.apiKey);
      if (g && Number.isFinite(g.score)) {
        return { score: g.score, reason: g.reason, via: 'gemini', threshold };
      }
    }
    const k = keywordScore(job, cv);
    return { score: k.score, reason: k.reason, via: 'keyword', threshold };
  }

  return { keywordScore, geminiScore, scoreJob, hardNegative };
});
