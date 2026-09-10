import { runExitCode } from './checks.mjs';
import { attentionText, findingContext } from './report-copy.mjs';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { loadBaseline, parseSweep, modelCheckOptions } from './followup.mjs';
import { runJobs, parseConcurrency } from './scheduler.mjs';
import { spawnCapture } from './proc.mjs';
import { defaultRoot, HARNESS_DIR, newRunId } from './context.mjs';
import { renderSweepHtml } from './report-html.mjs';
import { failureSummary } from './saved-reports.mjs';
import { costLabel, combineCosts } from './costs.mjs';

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
  const abort = () => { console.error('[sweep] cancelling active rounds; waiting for cleanup …'); controller.abort(); };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const jobs = rounds.map(round => ({ resources: [], run: async () => {
    const roundRoot = path.join(root, round.name);
    mkdirSync(roundRoot, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    for (const [id, model] of Object.entries(round.models)) env[`MIDBRAIN_HARNESS_${id.toUpperCase()}_MODEL`] = model;
    const profile = baseline ? ['--follow-up', baseline.dir] : ['--model-checks'];
    const args = [path.join(HARNESS_DIR, 'run.mjs'), 'run', ...profile, '--clients', Object.keys(round.models).join(','), '--root', roundRoot, '--concurrency', String(perRun), '--keep'];
    console.error(`[sweep] starting ${round.name}: ${Object.entries(round.models).map(([id, model]) => `${id} (${model})`).join(', ')} (${perRun} workers)`);
    const logFile = path.join(roundRoot, 'runner.log');
    writeFileSync(logFile, '', { mode: 0o600 });
    const result = controller.signal.aborted ? { code: 130, stderr: 'Sweep cancelled before this round', durationMs: 0 } : await spawnCapture(process.execPath, args, { env, timeoutMs: 3600000, killGraceMs: 30000, signal: controller.signal, onStderrLine: line => {
      appendFileSync(logFile, line + '\n');
      if (line.startsWith('[harness ')) console.error(`[${round.name}] ${line}`);
    } });
    writeFileSync(logFile, result.stderr, { mode: 0o600 });
    let report;
    try {
      const [runId] = readdirSync(path.join(roundRoot, 'runs'));
      report = JSON.parse(readFileSync(path.join(roundRoot, 'runs', runId, 'results.json'), 'utf8'));
    } catch { /* An incomplete round is always a failed round. */ }
    const counts = {};
    for (const cell of report?.cells || []) counts[cell.status] = (counts[cell.status] || 0) + 1;
    const ok = result.code === 0 && Boolean(report) && runExitCode(report.cells, report.isolation?.ok === true) === 0;
    console.error(`[sweep] ${round.name}: ${ok ? counts.BLOCKED ? 'BLOCKED (incomplete coverage)' : 'PASS' : 'FAIL'} (${Math.round(result.durationMs / 1000)} s)`);
    return { name: round.name, models: round.models, ok, counts, isolation: report?.isolation?.ok ?? null, costs: report?.run.costs ?? null, failures: report ? failureSummary(report) : [], durationMs: result.durationMs, prompts: report?.run.promptCount ?? null, report: report ? path.join(report.run.runDir, 'report.md') : null, log: logFile };
  } }));
  let results;
  try { results = await runJobs(jobs, parallelRuns); }
  finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  const summary = { baseline: baseline?.results.run.runId ?? null, infrastructureVerified: Boolean(baseline), totalWorkers: workers, workersPerRound: perRun, parallelRuns, durationMs: Date.now() - started, ok: results.every(r => r.ok), rounds: results, costs: combineCosts(results.map(r => r.costs)) };
  writeFileSync(path.join(root, 'costs.json'), JSON.stringify(summary.costs, null, 2) + '\n');
  writeFileSync(path.join(root, 'sweep.json'), JSON.stringify(summary, null, 2) + '\n');
  const coverage = baseline ? `Infrastructure evidence is reused from verified baseline ${summary.baseline}.` : 'Model checks only: project isolation, upgrade and client-specific behavior are unverified. This is not release sign-off.';
  const lines = ['# Model sweep', '', `Elapsed: ${(summary.durationMs / 60000).toFixed(1)} minutes.`, '', `${coverage} Each round uses a fresh home and fresh markers.`, '', '| Round | Result | Returned turns | Minutes | Report |', '|---|---|---|---|---|', ...results.map(r => `| ${r.name} | ${r.ok ? r.counts.BLOCKED ? 'BLOCKED (incomplete coverage)' : 'PASS' : 'FAIL'} | ${r.prompts ?? 'incomplete'} | ${(r.durationMs / 60000).toFixed(1)} | [evidence](${r.report || r.log}) |`)];
  writeFileSync(path.join(root, 'report.md'), lines.join('\n') + '\n\n## What needs attention\n\n' + attentionText(results.flatMap(r => r.failures.map(f => findingContext({ ...f, round: r.name }, r.models))), { markdown: true }) + '\n');
  appendFileSync(path.join(root, 'report.md'), '\n## Model cost accounting\n\nTotal: ' + costLabel(summary.costs) + '\n\n' + results.map(r => `- ${r.name}: ${costLabel(r.costs)}`).join('\n') + '\n\nUnreported usage, runner and backend costs are excluded.\n');
  writeFileSync(path.join(root, 'report.html'), renderSweepHtml(summary));
  console.error(`[sweep] HTML results: ${path.join(root, 'report.html')}`);
  console.log(path.join(root, 'report.md'));
  process.exitCode = summary.ok ? 0 : 1;
}
