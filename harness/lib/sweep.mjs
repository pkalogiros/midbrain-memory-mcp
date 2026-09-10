import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { loadBaseline, parseSweep, modelCheckOptions } from './followup.mjs';
import { runJobs, parseConcurrency } from './scheduler.mjs';
import { spawnCapture } from './proc.mjs';
import { defaultRoot, HARNESS_DIR, newRunId } from './context.mjs';

export async function runSweep(flags) {
  flags = modelCheckOptions(flags);
  const baseline = flags['model-checks'] ? null : loadBaseline(flags['follow-up']);
  if (typeof flags.models !== 'string') throw new Error('sweep requires --models FILE');
  const rounds = parseSweep(JSON.parse(readFileSync(path.resolve(flags.models), 'utf8')));
  const workers = parseConcurrency(flags.concurrency ?? 4, 10);
  const parallelRuns = parseConcurrency(flags['parallel-runs'] ?? 1);
  if (parallelRuns > workers) throw new Error('--parallel-runs cannot exceed the total --concurrency budget');
  const perRun = Math.min(5, Math.floor(workers / Math.min(parallelRuns, rounds.length)));
  const root = path.join(flags.root ? path.resolve(flags.root) : defaultRoot(), 'sweeps', newRunId());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const jobs = rounds.map(round => ({ resources: [], run: async () => {
    const roundRoot = path.join(root, round.name);
    mkdirSync(roundRoot, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    for (const [id, model] of Object.entries(round.models)) env[`MIDBRAIN_HARNESS_${id.toUpperCase()}_MODEL`] = model;
    const profile = baseline ? ['--follow-up', baseline.dir] : ['--model-checks'];
    const args = [path.join(HARNESS_DIR, 'run.mjs'), 'run', ...profile, '--clients', Object.keys(round.models).join(','), '--root', roundRoot, '--concurrency', String(perRun), '--keep'];
    console.error(`[sweep] starting ${round.name}: ${Object.keys(round.models).join(', ')} (${perRun} workers)`);
    const result = controller.signal.aborted ? { code: 130, stderr: 'Sweep cancelled before this round', durationMs: 0 } : await spawnCapture(process.execPath, args, { env, timeoutMs: 3600000, signal: controller.signal });
    writeFileSync(path.join(roundRoot, 'runner.log'), result.stderr, { mode: 0o600 });
    let report;
    try {
      const [runId] = readdirSync(path.join(roundRoot, 'runs'));
      report = JSON.parse(readFileSync(path.join(roundRoot, 'runs', runId, 'results.json'), 'utf8'));
    } catch { /* An incomplete round is always a failed round. */ }
    const counts = {};
    for (const cell of report?.cells || []) counts[cell.status] = (counts[cell.status] || 0) + 1;
    const ok = result.code === 0 && Boolean(report?.isolation.ok) && report.cells.length > 0 && report.cells.every(c => c.status === 'PASS');
    console.error(`[sweep] ${round.name}: ${ok ? 'PASS' : 'FAIL/BLOCKED'} (${Math.round(result.durationMs / 1000)} s)`);
    return { name: round.name, models: round.models, ok, counts, durationMs: result.durationMs, prompts: report?.run.promptCount ?? null, report: report ? path.join(report.run.runDir, 'report.md') : null, log: path.join(roundRoot, 'runner.log') };
  } }));
  let results;
  try { results = await runJobs(jobs, parallelRuns); }
  finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  const summary = { baseline: baseline?.results.run.runId ?? null, infrastructureVerified: Boolean(baseline), totalWorkers: workers, workersPerRound: perRun, parallelRuns, durationMs: Date.now() - started, ok: results.every(r => r.ok), rounds: results };
  writeFileSync(path.join(root, 'sweep.json'), JSON.stringify(summary, null, 2) + '\n');
  const coverage = baseline ? `Infrastructure evidence is reused from verified baseline ${summary.baseline}.` : 'Model checks only: project isolation, upgrade and client-specific behavior are unverified. This is not release sign-off.';
  const lines = ['# Model sweep', '', `Elapsed: ${(summary.durationMs / 60000).toFixed(1)} minutes.`, '', `${coverage} Each round uses a fresh home and fresh markers.`, '', '| Round | Result | Prompts | Minutes | Report |', '|---|---|---|---|---|', ...results.map(r => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL/BLOCKED'} | ${r.prompts ?? 'incomplete'} | ${(r.durationMs / 60000).toFixed(1)} | [evidence](${r.report || r.log}) |`)];
  writeFileSync(path.join(root, 'report.md'), lines.join('\n') + '\n');
  console.log(path.join(root, 'report.md'));
  process.exitCode = summary.ok ? 0 : 1;
}
