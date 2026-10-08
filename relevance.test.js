/**
 * node relevance.test.js — proves the deterministic keyword scorer separates a
 * highly-relevant dev job from an irrelevant one, using the REAL CV from ./config.
 * Throws (non-zero exit) on the first failing assertion; prints a green line + exit 0.
 */
const assert = require('assert');
const { keywordScore, scoreJob } = require('./relevance');
const { CV } = require('./config');

const THRESHOLD = 50; // the config default; the gate is score >= THRESHOLD

// A CV guaranteed to carry backend/full-stack signal even if the real .env is sparse,
// so the test is meaningful regardless of local .env contents. We merge the real CV
// on top so we also exercise whatever is configured.
const BASE_CV = {
  skills: 'Java, Spring Boot, Node.js, React, TypeScript, JavaScript, Python, MongoDB, PostgreSQL, Docker, AWS, Microservices, REST API, GraphQL',
  highlights: ['Built event-driven backend microservices', 'Shipped React/Next.js frontend'],
  currentRole: 'Backend Developer',
  yearsOfExperience: '2 years',
};
const cv = Object.assign({}, BASE_CV, {
  // keep real CV values when present, else the base ones
  skills: (CV && CV.skills) ? CV.skills + ', ' + BASE_CV.skills : BASE_CV.skills,
});

let passed = 0;
const ok = (cond, label) => { assert.ok(cond, label); passed++; console.log(`  ok  ${label}`); };

// 1. Highly relevant job scores >= threshold.
const relevant = keywordScore({
  title: 'Backend Developer',
  text: 'We need Java, Spring Boot, Node.js, React, microservices, Kafka, AWS, REST APIs and PostgreSQL. Build distributed backend systems.',
}, cv);
ok(relevant.score >= THRESHOLD, `relevant Java/Spring/Node/React job scores >= ${THRESHOLD} (got ${relevant.score}; ${relevant.reason})`);

// 2. Irrelevant job scores below threshold (it carries essentially no CV signal).
const irrelevant = keywordScore({
  title: 'Senior .NET Sales Manager',
  text: 'Lead a sales team selling .NET consulting. Quota ownership, CRM, cold calling, territory management.',
}, cv);
ok(irrelevant.score < THRESHOLD, `irrelevant ".NET Sales Manager" scores < ${THRESHOLD} (got ${irrelevant.score}; ${irrelevant.reason})`);

// 3. Title-floor: a plain dev title with an EMPTY card/JD snippet still clears threshold.
const bareTitle = keywordScore({ title: 'Frontend Engineer', text: '' }, cv);
ok(bareTitle.score >= THRESHOLD, `bare "Frontend Engineer" (empty JD) clears threshold via title-floor (got ${bareTitle.score})`);

// 4. The relevant job out-scores the irrelevant one (ordering sanity).
ok(relevant.score > irrelevant.score, `relevant (${relevant.score}) out-scores irrelevant (${irrelevant.score})`);

(async () => {
  // 5. scoreJob with NO apiKey uses the deterministic keyword path — the live no-key state.
  const viaKeyword = await scoreJob({ title: 'Backend Developer', text: 'Node.js, Java, React' }, cv, { threshold: THRESHOLD });
  ok(viaKeyword.via === 'keyword', `scoreJob with no apiKey returns via:'keyword' (got '${viaKeyword.via}')`);
  ok(Number.isFinite(viaKeyword.score), `scoreJob returns a numeric score (got ${viaKeyword.score})`);

  console.log(`\nrelevance.test: all ${passed} checks passed`);
})().catch((e) => { console.error('relevance.test FAILED:', e.message); process.exit(1); });
