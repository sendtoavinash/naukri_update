/**
 * node relevance-replay.test.js — OFFLINE regression harness.
 * =========================================================
 * Replays every DISTINCT historical job title from applications.csv through the
 * live scorer (scoreJob with the REAL CV, no Gemini key -> deterministic keyword
 * path) and reports how many would now be REJECTED vs KEPT under the current
 * RELEVANCE_THRESHOLD. It is READ-ONLY on the CSV and makes NO network/browser
 * calls — it only proves the scoring change behaves as intended on real data.
 *
 * Assertions:
 *   - every KNOWN-BAD title (firmware/embedded/BI/data-eng/robotics/Teamcenter/
 *     Curam/Golang-security/SRE/performance/seismic) present in the CSV now FAILS
 *     the gate (score < threshold, typically via hard-negative), and
 *   - a representative set of Java/Spring/backend/full-stack titles still PASS.
 * Throws (non-zero exit) on the first failing assertion; green line + exit 0 otherwise.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scoreJob } = require('./relevance');
const { CV, relevanceThreshold } = require('./config');

const THRESHOLD = Number.isFinite(relevanceThreshold) ? relevanceThreshold : 60;

// Same merged CV as relevance.test.js so the harness is meaningful even if the local
// .env is sparse; the real CV is layered on top.
const BASE_CV = {
  skills: 'Java, Spring Boot, Spring WebFlux, Node.js, React, TypeScript, JavaScript, MongoDB, PostgreSQL, Redis, Kafka, Docker, Kubernetes, AWS, Microservices, REST API',
  highlights: ['Built event-driven backend microservices with Java, Spring Boot and Kafka', 'Shipped React/Next.js frontend'],
  currentRole: 'Senior Software Engineer',
  yearsOfExperience: '7 years',
};
const cv = Object.assign({}, BASE_CV, {
  skills: (CV && CV.skills) ? CV.skills + ', ' + BASE_CV.skills : BASE_CV.skills,
});

// ---- minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF) ----
function parseCsv(t) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvPath = path.join(__dirname, 'applications.csv');
const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\ufeff/, '');
const rows = parseCsv(raw);
const header = rows[0];
const roleIdx = header.indexOf('Role');
const jdIdx = header.indexOf('Job Description');
assert.ok(roleIdx >= 0, 'CSV must have a Role column');

// distinct (title -> representative JD) from the history
const distinct = new Map();
for (let i = 1; i < rows.length; i++) {
  const title = (rows[i][roleIdx] || '').trim();
  if (!title) continue;
  const jd = jdIdx >= 0 ? (rows[i][jdIdx] || '') : '';
  if (!distinct.has(title) || (!distinct.get(title) && jd)) distinct.set(title, jd);
}

// Substrings that mark a title as KNOWN-BAD (must now be rejected). Case-insensitive.
const BAD_MARKERS = [
  'firmware', 'embedded', 'power bi', 'looker', 'tableau', 'data engineer',
  'site reliability', 'teamcenter', 'curam', 'seismic', 'robotics',
  'performance engineer', 'golang developer', 'go developer', 'datastage',
  'informatica', 'snowflake data engineer', 'c++',
];
// Substrings that mark a title as KNOWN-GOOD (should still pass) — only when the title
// ALSO is not a known-bad (a title can contain both, e.g. "Java ... Data Engineer").
const GOOD_MARKERS = [
  'java', 'spring', 'backend', 'back end', 'full stack', 'fullstack',
  'microservices', 'sde', 'software engineer', 'software developer',
];

(async () => {
  let kept = 0, rejected = 0;
  const keptSamples = [], rejectedSamples = [];
  const badFailures = [];     // known-bad titles that wrongly PASSED
  const goodFailures = [];    // clearly-good titles that wrongly FAILED
  let badCount = 0, goodCount = 0;

  for (const [title, jd] of distinct) {
    const r = await scoreJob({ title, text: jd }, cv, { threshold: THRESHOLD });
    const passes = r.score >= THRESHOLD;
    const low = title.toLowerCase();
    const isBad = BAD_MARKERS.some((m) => low.includes(m));
    const isGood = !isBad && GOOD_MARKERS.some((m) => low.includes(m));

    if (passes) { kept++; if (keptSamples.length < 12) keptSamples.push(`${title} [${r.score}]`); }
    else { rejected++; if (rejectedSamples.length < 12) rejectedSamples.push(`${title} [${r.score}; ${r.via}]`); }

    if (isBad) { badCount++; if (passes) badFailures.push(`${title} [${r.score}; ${r.via}]`); }
    if (isGood) { goodCount++; if (!passes) goodFailures.push(`${title} [${r.score}; ${r.via}: ${r.reason}]`); }
  }

  console.log(`\nrelevance-replay: scored ${distinct.size} distinct historical titles @ threshold ${THRESHOLD}`);
  console.log(`  KEPT:     ${kept}`);
  console.log(`  REJECTED: ${rejected}`);
  console.log(`\n  known-bad markers matched: ${badCount}  (all must now REJECT)`);
  console.log(`  clearly-good markers matched: ${goodCount}  (must still KEEP)`);

  console.log('\n  sample KEPT:');
  for (const s of keptSamples) console.log(`    ✓ ${s}`);
  console.log('\n  sample REJECTED:');
  for (const s of rejectedSamples) console.log(`    ✗ ${s}`);

  if (badFailures.length) {
    console.log('\n  !! known-bad titles that still PASSED:');
    for (const s of badFailures) console.log(`    ! ${s}`);
  }
  if (goodFailures.length) {
    console.log('\n  !! clearly-good titles that now FAIL:');
    for (const s of goodFailures) console.log(`    ! ${s}`);
  }

  assert.strictEqual(badFailures.length, 0, `every known-bad historical title must now be rejected (${badFailures.length} leaked)`);
  // Guardrail: the Java/backend history must overwhelmingly still pass. Allow a tiny
  // margin for odd title strings (e.g. a role column polluted with office/location text).
  assert.ok(goodFailures.length <= Math.max(2, Math.floor(goodCount * 0.1)),
    `too many clearly-good titles now fail (${goodFailures.length} of ${goodCount})`);

  console.log(`\nrelevance-replay: all checks passed (0 bad leaks, ${goodFailures.length} good misses of ${goodCount})`);
})().catch((e) => { console.error('relevance-replay FAILED:', e.message); process.exit(1); });
