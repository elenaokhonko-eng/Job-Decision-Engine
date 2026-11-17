/**
 * Read-only score-variant experiments on the replay branch (no production code, no writes).
 *
 * Recomputes alternative job scores from the stored per-requirement matches and scores each with
 * the measuring tool's separation (AUC-style) over saved jobs vs title-class non-fits, using
 * 5-fold cross-validation (folds by SHA-256 of the job id) and a bootstrap 95% interval.
 *
 *   npx tsx scripts/experiments/score_variants.ts
 */
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import pg from 'pg';
import { pgConnectionConfig } from '../../src/db/pgSsl.js';
import { requireApprovedReplayTarget } from '../../src/reporting/replayGuard.js';
import { LINKEDIN_SAVED_SOURCE_NAME } from '../../src/ingestion/linkedInSavedExport.js';
import { resolveWorkspaceContext } from '../../src/workspace/context.js';
import { classifyNonFitTitle, separation } from '../../src/reporting/rankingMeasurement.js';
import { loadCandidateJobs, loadSavedObservations } from '../../src/reporting/rankingMeasurementQueries.js';

dotenv.config({ path: '.env.local' });

interface Req { type: string; importance: string; matchType: string; score: number; semantic: number | null; lexical: number | null; weighted: number | null }
interface Job { id: string; saved: boolean; base: number; lane: string; reqs: Req[]; fold: number }

const FOLDS = 5;
const foldOf = (id: string) => createHash('sha256').update(id).digest().readUInt32BE(0) % FOLDS;
const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
const topK = (v: number[], k: number) => mean([...v].sort((a, b) => b - a).slice(0, k));

function auc(jobs: Job[], score: (j: Job) => number): number | null {
  return separation(jobs.filter((j) => j.saved).map(score), jobs.filter((j) => !j.saved).map(score));
}

function bootstrap(jobs: Job[], score: (j: Job) => number, rounds = 400): [number, number] {
  const pos = jobs.filter((j) => j.saved).map(score);
  const neg = jobs.filter((j) => !j.saved).map(score);
  const draws: number[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let r = 0; r < rounds; r++) {
    const p = pos.map(() => pos[Math.floor(rnd() * pos.length)]);
    const n = neg.map(() => neg[Math.floor(rnd() * neg.length)]);
    const s = separation(p, n);
    if (s !== null) draws.push(s);
  }
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(draws.length * 0.025)], draws[Math.floor(draws.length * 0.975)]];
}

function topN(jobs: Job[], score: (j: Job) => number, n: number): number {
  return [...jobs].sort((a, b) => score(b) - score(a)).slice(0, n).filter((j) => j.saved).length;
}

type Variant = { name: string; score: (j: Job, train: Job[]) => number };

/** Target-encoded role fit: share of saved jobs in this lane among the training folds (smoothed). */
function laneRate(train: Job[]): Map<string, number> {
  const prior = train.filter((j) => j.saved).length / Math.max(1, train.length);
  const counts = new Map<string, { s: number; n: number }>();
  for (const j of train) {
    const c = counts.get(j.lane) ?? { s: 0, n: 0 };
    c.n += 1;
    if (j.saved) c.s += 1;
    counts.set(j.lane, c);
  }
  const out = new Map<string, number>();
  for (const [lane, c] of counts) out.set(lane, (c.s + prior * 5) / (c.n + 5));
  out.set('__prior', prior);
  return out;
}

async function main() {
  const url = process.env.REPLAY_DATABASE_URL!.trim();
  const client = new pg.Client(pgConnectionConfig(url));
  await client.connect();
  await client.query('BEGIN READ ONLY');
  try {
    const id = await client.query(`SELECT current_database() AS d, current_setting('neon.branch_id', TRUE) AS b`);
    requireApprovedReplayTarget(url, { databaseName: id.rows[0].d, branchId: id.rows[0].b }, process.env.REPLAY_BRANCH_ID);
    const ws = await resolveWorkspaceContext(client as never);
    const saved = await loadSavedObservations(client as never, ws.workspaceId, LINKEDIN_SAVED_SOURCE_NAME);
    const candidates = await loadCandidateJobs(client as never, ws.workspaceId);

    const pool = new Map<string, { saved: boolean; base: number }>();
    for (const o of saved) if (o.job && o.hasCompletedMatch && o.hasDecision) pool.set(o.job.jobId, { saved: true, base: o.job.matchScore });
    for (const c of candidates) if (!pool.has(c.jobId) && classifyNonFitTitle(c.title) !== null) pool.set(c.jobId, { saved: false, base: c.matchScore });

    const ids = [...pool.keys()];
    const { rows } = await client.query(
      `SELECT cj.id AS job_id, COALESCE(cj.primary_lane, 'NONE') AS lane,
              r.requirement_type, r.importance, m.match_type, m.match_score,
              (m.evidence->>'semantic_score')::float AS semantic, (m.evidence->>'lexical_score')::float AS lexical,
              (m.evidence->>'weighted_score')::float AS weighted
       FROM canonical_jobs cj
       JOIN requirement_evidence_matches m ON m.match_run_id = cj.latest_match_run_id
       JOIN job_requirements r ON r.id = m.requirement_id
       WHERE cj.id = ANY($1::uuid[])`,
      [ids],
    );
    const jobs = new Map<string, Job>();
    for (const [jobId, p] of pool) jobs.set(jobId, { id: jobId, saved: p.saved, base: p.base, lane: 'NONE', reqs: [], fold: foldOf(jobId) });
    for (const r of rows) {
      const j = jobs.get(r.job_id)!;
      j.lane = r.lane;
      j.reqs.push({ type: r.requirement_type, importance: r.importance, matchType: r.match_type, score: Number(r.match_score), semantic: r.semantic, lexical: r.lexical, weighted: r.weighted });
    }
    const all = [...jobs.values()].filter((j) => j.reqs.length > 0);
    console.log(`pool: ${all.filter((j) => j.saved).length} saved, ${all.filter((j) => !j.saved).length} non-fit (${all.length} with requirement matches); median requirements/job ${[...all.map((j) => j.reqs.length)].sort((a, b) => a - b)[Math.floor(all.length / 2)]}`);
    const laneShare = new Map<string, [number, number]>();
    for (const j of all) { const c = laneShare.get(j.lane) ?? [0, 0]; c[j.saved ? 0 : 1] += 1; laneShare.set(j.lane, c); }
    console.log('lane (saved/non-fit):', JSON.stringify([...laneShare.entries()]));

    const typeCounts = new Map<string, number>();
    for (const j of all) for (const r of j.reqs) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
    console.log('requirement types:', JSON.stringify([...typeCounts.entries()].sort((x, y) => y[1] - x[1])));
    const NON_RANKING = new Set(['EXPERIENCE_YEARS', 'DEGREE', 'CREDENTIAL', 'OFFICE_DAYS', 'WORK_MODE', 'EMPLOYMENT_TYPE', 'TRAVEL', 'WORK_AUTH', 'ON_CALL', 'SHIFT_WORK']);
    const cap = (j: Job) => j.reqs.filter((r) => !NON_RANKING.has(r.type));
    const variants: Variant[] = [
      { name: 'V0 current score', score: (j) => j.base },
      { name: 'V2 semantic-only mean', score: (j) => mean(j.reqs.map((r) => r.semantic ?? 0)) },
      { name: 'V2b lexical-only mean', score: (j) => mean(j.reqs.map((r) => r.lexical ?? 0)) },
      { name: 'V3 top-5 match score', score: (j) => topK(j.reqs.map((r) => r.score), 5) },
      { name: 'V3b top-5 capability only', score: (j) => topK(cap(j).map((r) => r.score), 5) },
      { name: 'V3c top-5 semantic', score: (j) => topK(j.reqs.map((r) => r.semantic ?? 0), 5) },
      { name: 'V3d top-10 semantic', score: (j) => topK(j.reqs.map((r) => r.semantic ?? 0), 10) },
      { name: 'V3e MUST-only mean', score: (j) => mean(j.reqs.filter((r) => r.importance === 'MUST').map((r) => r.score)) },
    ];
    variants.push(
      { name: 'V3f top-3 capability only', score: (j) => topK(cap(j).map((r) => r.score), 3) },
      { name: 'V3g top-8 capability only', score: (j) => topK(cap(j).map((r) => r.score), 8) },
      { name: 'V3h top-12 capability only', score: (j) => topK(cap(j).map((r) => r.score), 12) },
      { name: 'V3i top-5 capability semantic', score: (j) => topK(cap(j).map((r) => r.semantic ?? 0), 5) },
      { name: 'V3j capability mean (no top-K)', score: (j) => mean(cap(j).map((r) => r.score)) },
    );
    // Fixed design candidates (K fixed at 7, the middle of the 3-12 plateau; no further tuning).
    const K = 7;
    const must = (j: Job) => cap(j).filter((r) => r.importance === 'MUST');
    const unmatchedMustShare = (j: Job) => { const m = must(j); return m.length ? m.filter((r) => r.matchType !== 'EXACT' && r.matchType !== 'SEMANTIC').length / m.length : 0; };
    variants.push(
      { name: 'D1 top-7 capability semantic (simple)', score: (j) => topK(cap(j).map((r) => r.semantic ?? 0), K) },
      { name: 'D2 top-7 MUST-only semantic', score: (j) => topK(must(j).map((r) => r.semantic ?? 0), K) },
      { name: 'D3 top-7 semantic - 0.10 x unmatched-MUST share', score: (j) => topK(cap(j).map((r) => r.semantic ?? 0), K) - 0.1 * unmatchedMustShare(j) },
      { name: 'D4 top-7 semantic - 0.20 x unmatched-MUST share', score: (j) => topK(cap(j).map((r) => r.semantic ?? 0), K) - 0.2 * unmatchedMustShare(j) },
      { name: 'D5 top-7 MUST semantic - 0.20 x unmatched-MUST share', score: (j) => topK(must(j).map((r) => r.semantic ?? 0), K) - 0.2 * unmatchedMustShare(j) },
    );
    const roleFit = (j: Job, train: Job[]) => { const t = laneRate(train); return t.get(j.lane) ?? t.get('__prior')!; };
    const zs = (f: (j: Job) => number, jobsIn: Job[]) => { const v = jobsIn.map(f); const m = mean(v); const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2))) || 1; return (j: Job) => (f(j) - m) / sd; };
    variants.push({ name: 'V5 role-fit (lane) alone', score: (j, train) => roleFit(j, train) });
    for (const w of [0.25, 0.5]) {
      variants.push({
        name: `V3c+V5 top-5 semantic + ${w} role-fit (z)`,
        score: (j, train) => zs((x) => topK(x.reqs.map((r) => r.semantic ?? 0), 5), train)(j) + w * zs((x) => roleFit(x, train), train)(j),
      });
    }
    for (const w of [0.25, 0.5]) {
      variants.push({
        name: `V3b+V5 top-5 capability + ${w} role-fit (z)`,
        score: (j, train) => zs((x) => topK(cap(x).map((r) => r.score), 5), train)(j) + w * zs((x) => roleFit(x, train), train)(j),
      });
    }
    variants.push({
      name: 'V3c+V3e+V5 top-5 sem + MUST mean + 0.5 role-fit',
      score: (j, train) => zs((x) => topK(x.reqs.map((r) => r.semantic ?? 0), 5), train)(j) + zs((x) => mean(x.reqs.filter((r) => r.importance === 'MUST').map((r) => r.score)), train)(j) + 0.5 * zs((x) => roleFit(x, train), train)(j),
    });

    console.log('\nvariant'.padEnd(58) + 'CV-AUC  95% CI          Top10  Top50  (pooled out-of-fold, 5 folds)');
    for (const v of variants) {
      const oof = new Map<string, number>();
      for (let f = 0; f < FOLDS; f++) {
        const train = all.filter((j) => j.fold !== f);
        for (const j of all.filter((x) => x.fold === f)) oof.set(j.id, v.score(j, train));
      }
      const sc = (j: Job) => oof.get(j.id)!;
      const a = auc(all, sc);
      const [lo, hi] = bootstrap(all, sc);
      const perFold = Array.from({ length: FOLDS }, (_, f) => auc(all.filter((j) => j.fold === f), sc)!.toFixed(2)).join(' ');
      console.log(`${v.name.padEnd(56)}${a!.toFixed(3)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]   ${String(topN(all, sc, 10)).padStart(2)}/10  ${String(topN(all, sc, 50)).padStart(2)}/50   folds: ${perFold}`);
    }
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}
main().catch((e) => { console.error('FAILED', e?.message); process.exit(1); });
