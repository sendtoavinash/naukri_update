/**
 * node relevance.test.js — proves the deterministic keyword scorer + hard-negative
 * gate separate the user's REAL profile (Senior Java/Spring backend + full-stack)
 * from irrelevant disciplines, using the REAL CV from ./config.
 * Throws (non-zero exit) on the first failing assertion; prints a green line + exit 0.
 */
const assert = require('assert');
const { keywordScore, scoreJob, hardNegative } = require('./relevance');
const { CV } = require('./config');

const THRESHOLD = 60; // the config default; the gate is score >= THRESHOLD

// A CV guaranteed to carry backend/full-stack signal even if the real .env is sparse,
// so the test is meaningful regardless of local .env contents. We merge the real CV
// on top so we also exercise whatever is configured.
const BASE_CV = {
  skills: 'Java, Spring Boot, Spring WebFlux, Node.js, React, TypeScript, JavaScript, MongoDB, PostgreSQL, Redis, Kafka, Docker, Kubernetes, AWS, Microservices, REST API',
  highlights: ['Built event-driven backend microservices with Java, Spring Boot and Kafka', 'Shipped React/Next.js frontend'],
  currentRole: 'Senior Software Engineer',
  yearsOfExperience: '7 years',
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
  title: 'Sales Manager',
  text: 'Lead a sales team. Quota ownership, CRM, cold calling, territory management.',
}, cv);
ok(irrelevant.score < THRESHOLD, `irrelevant "Sales Manager" scores < ${THRESHOLD} (got ${irrelevant.score}; ${irrelevant.reason})`);

// 3. Title-floor requires a CORE skill: a CORE dev title with an EMPTY JD still clears
//    threshold via the floor...
const coreBare = keywordScore({ title: 'Backend Developer', text: '' }, cv);
ok(coreBare.score >= THRESHOLD, `bare CORE "Backend Developer" (empty JD) clears threshold via core-skill title-floor (got ${coreBare.score})`);

// 3b. ...but a bare generic/irrelevant title with NO core skill no longer floors.
const genericBare = keywordScore({ title: 'Data Engineer', text: '' }, cv);
ok(genericBare.score < THRESHOLD, `bare "Data Engineer" (empty JD) no longer floors — scores < ${THRESHOLD} (got ${genericBare.score})`);
const sreBare = keywordScore({ title: 'Site Reliability Engineer', text: '' }, cv);
ok(sreBare.score < THRESHOLD, `bare "Site Reliability Engineer" (empty JD) no longer floors — scores < ${THRESHOLD} (got ${sreBare.score})`);

// 4. The relevant job out-scores the irrelevant one (ordering sanity).
ok(relevant.score > irrelevant.score, `relevant (${relevant.score}) out-scores irrelevant (${irrelevant.score})`);

// 5. Hard-negative helper: title-level disqualifier hits; a body-only negative is
//    ignored when the title carries a core skill.
ok(hardNegative('Data Engineer', '').hit === true, `hardNegative("Data Engineer") hits`);
ok(hardNegative('Senior Java Backend Developer', 'needs some golang too').hit === false,
  `hardNegative: a Java/backend TITLE protects against a body-only negative`);

// 6. Table-driven SHOULD-KEEP: real/representative Java/Spring/full-stack titles with a
//    short Java-stack JD must pass the gate via scoreJob (the live path).
const KEEP = [
  { title: 'Senior Java Backend Developer - Microservices', text: 'Java, Spring Boot, microservices, Kafka, REST APIs, PostgreSQL, AWS.' },
  { title: 'Backend Software Engineer - Java/Node.js - Fintech', text: 'Build backend services in Java and Node.js. Spring Boot, REST, microservices, Kafka.' },
  { title: 'Full Stack Developer - Java/React.js', text: 'Java Spring Boot backend, React frontend, REST APIs, PostgreSQL, Docker.' },
  { title: 'Senior Software Engineer (Java Full Stack)', text: 'Java, Spring, microservices, React, Next.js, AWS, Kubernetes.' },
  { title: '[Java] Software Engineer', text: 'Core Java, Spring Boot, REST APIs, microservices, SQL.' },
  { title: 'Software Engineer - Backend', text: 'Backend services with Java/Spring Boot, Kafka event-driven, REST, PostgreSQL, Redis.' },
  { title: 'Senior Fullstack Engineer', text: 'Java/Spring and Node.js backend, React frontend, microservices, AWS.' },
];
for (const j of KEEP) {
  // scoreJob is async; collect below in the async block.
}

// 7. Table-driven SHOULD-REJECT: the real wrongly-applied titles must fail the gate
//    (hard-negative OR score < threshold). Give each a short realistic JD so the test
//    reflects a real card, not just a bare title.
const REJECT = [
  { title: 'Sr. Engineer Firmware', text: 'Firmware development in C for microcontrollers, RTOS, device drivers.' },
  { title: 'Embedded C++ Developer - UAV Aerospace Flight Controller', text: 'Embedded C++ on flight controllers, RTOS, sensors, DO-178C.' },
  { title: 'Associate Power BI Developer', text: 'Build Power BI dashboards, DAX, data modeling, reporting.' },
  { title: 'Data Engineer', text: 'ETL pipelines, Spark, Snowflake, data warehousing, Airflow.' },
  { title: 'Site Reliability Engineer', text: 'SRE: on-call, Terraform, observability, incident response, Kubernetes ops.' },
  { title: 'Looker Developer', text: 'Build Looker explores and dashboards, LookML, BI reporting.' },
  { title: 'Golang Developer - Cloud Security', text: 'Golang services for cloud security tooling, gRPC, Kubernetes.' },
  { title: 'Senior Teamcenter Developer', text: 'Siemens Teamcenter PLM customization, BMIDE, ITK, SOA.' },
  { title: 'Curam Developer', text: 'IBM Curam SPM development, CER rules, social program management.' },
  { title: 'Senior Seismic Application Developer', text: 'Seismic data processing applications, geophysics, signal processing.' },
  { title: 'Robotics Perception and Edge AI Engineer', text: 'Robotics perception, SLAM, computer vision, edge AI on devices.' },
  { title: 'Performance Engineer', text: 'Performance testing, JMeter, load testing, profiling, tuning.' },
];

(async () => {
  // SHOULD-KEEP assertions (live scoreJob path, no apiKey -> keyword).
  for (const j of KEEP) {
    const r = await scoreJob(j, cv, { threshold: THRESHOLD });
    ok(r.score >= THRESHOLD, `KEEP "${j.title}" passes gate (score ${r.score} >= ${THRESHOLD}; via ${r.via}; ${r.reason})`);
  }

  // SHOULD-REJECT assertions.
  for (const j of REJECT) {
    const r = await scoreJob(j, cv, { threshold: THRESHOLD });
    ok(r.score < THRESHOLD, `REJECT "${j.title}" fails gate (score ${r.score} < ${THRESHOLD}; via ${r.via}; ${r.reason})`);
  }

  // scoreJob with NO apiKey uses the deterministic keyword path — the live no-key state.
  const viaKeyword = await scoreJob({ title: 'Backend Developer', text: 'Node.js, Java, React' }, cv, { threshold: THRESHOLD });
  ok(viaKeyword.via === 'keyword', `scoreJob with no apiKey returns via:'keyword' (got '${viaKeyword.via}')`);
  ok(Number.isFinite(viaKeyword.score), `scoreJob returns a numeric score (got ${viaKeyword.score})`);

  console.log(`\nrelevance.test: all ${passed} checks passed`);
})().catch((e) => { console.error('relevance.test FAILED:', e.message); process.exit(1); });
