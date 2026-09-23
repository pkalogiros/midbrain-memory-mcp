import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { createRunContext, defaultRoot, HARNESS_DIR, HARNESS_VERSION, childEnv } from './context.mjs';
import { loadDotEnv, collectSecrets } from './env.mjs';
import { freezeCandidate, assertCandidate } from './candidate.mjs';
import { seedDetectionFixtures, writeGlobalKey, writeGlobalHostConfig, initProject, installCandidate, inspectInstall } from './home.mjs';
import { selectManifests } from '../clients/index.mjs';
import { snapshot, diff } from './tripwire.mjs';
import { spawnCapture, whichSync, stopChildProcesses } from './proc.mjs';
import { cell, blockedCells } from '../scenarios/_shared.mjs';
import { check, BlockedError } from './checks.mjs';
import { smokeEnv } from './dry-smoke-policy.mjs';
import { installedSmokeEntry, instrumentSmokeEntry } from './dry-smoke-config.mjs';
import { buildLivePlan, LIVE_ROWS, LIVE_SCOPE, scoreLiveScenario, liveSmokeOutcome, liveOpenCodeConfig } from './live-smoke-policy.mjs';
import { startLiveSmokeApi } from './live-smoke-fixture.mjs';
import { readLiveTrace, redactLive, redactLiveDirectory } from './live-smoke-evidence.mjs';
import { renderLiveSmokeHtml, renderLiveSmokeMarkdown, renderLiveSmokeJUnit } from './live-smoke-report.mjs';

const worker = fileURLToPath(new URL('./live-smoke-worker.mjs', import.meta.url));
const proxy = fileURLToPath(new URL('./live-smoke-proxy.mjs', import.meta.url));
const log = message => console.error(`[live-smoke] ${message}`);

export async function runLiveSmoke(flags) {
  if (typeof flags.config !== 'string') throw new Error('Usage: live-smoke --config models.json [--execute]. Without --execute, only a zero-prompt plan is produced.');
  const plan = buildLivePlan(flags, JSON.parse(readFileSync(path.resolve(flags.config), 'utf8')));
  if (!plan.execute) { console.log(JSON.stringify({ ...plan, promptsSent: 0, note: 'Plan only. No clients launched, credentials loaded, dependencies installed or model requests made. Add --execute to run.' }, null, 2)); return; }
  loadDotEnv(path.join(HARNESS_DIR, '.env'));
  const available = collectSecrets();
  const selectedSecrets = Object.fromEntries([...new Set(Object.values(plan.credentials))].filter(k => available[k]).map(k => [k, available[k]]));
  const ctx = createRunContext({ root: flags.root ? path.resolve(flags.root) : defaultRoot(), options: { drySmoke: true, liveSmoke: true } });
  const manifests = selectManifests(plan.clients);
  const before = snapshot();
  const results = { schemaVersion: 1, harnessVersion: HARNESS_VERSION, run: { kind: 'live-smoke', scope: LIVE_SCOPE, runId: ctx.runId, runDir: ctx.dirs.run, startedAt: ctx.startedAt, platform: ctx.platform, arch: ctx.arch, node: ctx.node,
    models: plan.models, plan, complete: false, promptAttempts: 0, providerRequests: null }, candidate: {}, clients: manifests.map(m => ({ id: m.id, displayName: m.displayName, version: null })), cells: [], liveScenarios: [], isolation: { ok: false, drift: [] } };
  let api; let interrupted = false; let closing;
  const secrets = () => [...Object.values(selectedSecrets), api?.key];
  const save = () => {
    const report = JSON.parse(redactLive(results, secrets()));
    writeFileSync(path.join(ctx.dirs.run, 'results.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(ctx.dirs.run, 'report.html'), renderLiveSmokeHtml(report));
    writeFileSync(path.join(ctx.dirs.run, 'report.md'), renderLiveSmokeMarkdown(report));
    writeFileSync(path.join(ctx.dirs.run, 'junit.xml'), renderLiveSmokeJUnit(report));
  };
  const close = () => closing ||= (async () => { await stopChildProcesses(); if (api) await api.close(); })();
  const interrupt = () => { interrupted = true; void close(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const heartbeat = globalThis.setInterval(() => log(`${results.run.promptAttempts}/${plan.scenarios} native session attempts; ${results.cells.length} result rows saved`), 30000);
  try {
    save();
    // All selected prerequisites must pass before spending on any client.
    for (const m of manifests) {
      const state = results.clients.find(c => c.id === m.id);
      try {
        if (!m.os.includes(process.platform)) throw new BlockedError(`${m.displayName} driver does not support ${process.platform}`);
        const credential = plan.credentials[m.id];
        if (!selectedSecrets[credential]) throw new BlockedError(`Missing ${credential}`);
        let binary = whichSync(m.binary, childEnv(ctx));
        if (!binary && flags['install-clients'] && ['npm', 'uv-tool'].includes(m.install.kind)) { await m.preflight(ctx); binary = whichSync(m.binary, childEnv(ctx)); }
        if (!binary) throw new BlockedError(`Missing ${m.binary}; install it or use --install-clients where supported`);
        const version = await spawnCapture(binary, ['--version'], { env: smokeEnv(ctx), timeoutMs: 30000 });
        if (version.code !== 0) throw new BlockedError(`${m.binary} --version failed`);
        state.version = version.stdout.trim() || version.stderr.trim();
      } catch (error) { state.blockedReason = error.message; }
    }
    if (results.clients.some(c => c.blockedReason)) {
      for (const m of manifests) results.cells.push(...blockedCells(LIVE_ROWS, 'live-smoke', m, results.clients.find(c => c.id === m.id).blockedReason || 'Another selected client failed preflight; no model sessions were started. Narrow --clients to run independently.'));
      results.run.complete = !interrupted;
      return results;
    }
    if (interrupted) return results;
    log('Preparing the frozen package and local synthetic backend.');
    api = await startLiveSmokeApi(); ctx.apiUrl = api.url;
    results.candidate = ctx.candidate = await freezeCandidate({ mode: 'dev', directory: path.join(ctx.dirs.run, 'candidate'), env: smokeEnv(ctx) });
    ctx.writeJson(path.join(ctx.dirs.run, 'candidate.json'), ctx.candidate);
    seedDetectionFixtures(ctx, manifests);
    writeGlobalKey(ctx, api.key); writeGlobalHostConfig(ctx, api.url);
    writeFileSync(path.join(ctx.dirs.tmp, '.midbrain-update-check.json'), JSON.stringify({ lastCheck: Date.now() }));
    for (const m of manifests) {
      if (interrupted) break;
      const project = await initProject(ctx, `live-${m.id}`);
      const install = await installCandidate(ctx, ctx.candidate, { cwd: project, label: `live-install-${m.id}` });
      const inspection = await inspectInstall(ctx, ctx.candidate, m.id);
      const installChecks = [check('Frozen candidate installer exits successfully', install.code === 0), check('Product adapter recognizes a fresh install', inspection.installed === true && inspection.fresh === true)];
      results.cells.push(cell({ row: 'Installation', scenario: 'live-smoke', client: m, checks: installChecks, evidence: [`evidence/_install/live-install-${m.id}.stdout.txt`, `evidence/_install/live-install-${m.id}.stderr.txt`] }));
      if (!installChecks.every(c => c.ok)) { results.cells.push(...blockedCells(LIVE_ROWS.slice(1), 'live-smoke', m, 'Installation failed; model sessions were not started.')); save(); continue; }
      if (m.id === 'opencode') {
        const file = path.join(ctx.dirs.home, '.config/opencode/opencode.jsonc');
        const errors = []; const config = parseJsonc(readFileSync(file, 'utf8'), errors);
        if (errors.length || !config || typeof config !== 'object') throw new Error('Invalid installed OpenCode configuration');
        ctx.writeJson(file, liveOpenCodeConfig(config, plan.models[m.id]));
      }
      for (const id of ['round-trip', 'recovery']) {
        if (interrupted) break;
        assertCandidate(ctx.candidate);
        const evidenceDir = ctx.evidenceDir(m.id, id);
        const traceDir = path.join(evidenceDir, 'mcp-events'); mkdirSync(traceDir);
        const entry = installedSmokeEntry(ctx, m.id);
        if (entry.command !== process.execPath || entry.args?.[0] !== path.join(ctx.candidate.repoRoot, 'index.js')) throw new Error('Installed MCP no longer points at the frozen candidate');
        const spec = path.join(evidenceDir, 'proxy.json');
        ctx.writeJson(spec, { entry, traceDir, maxMcpCalls: plan.maxMcpCalls });
        const restore = instrumentSmokeEntry(ctx, m.id, process.execPath, [proxy, spec]);
        const scenario = api.activate(id);
        const start = api.requests.length; const unexpectedStart = api.unexpected.length; const incidentalStart = api.incidental.length;
        const row = id === 'recovery' ? 'Error and recovery' : 'Call and consume';
        const relative = file => path.relative(ctx.dirs.run, file);
        const attempt = { client: m.id, id, row, model: plan.models[m.id], prompt: scenario.prompt, startedAt: new Date().toISOString(), status: 'INCOMPLETE', evidence: relative(path.join(evidenceDir, 'receipt.json')) };
        results.liveScenarios.push(attempt);
        ctx.writeJson(path.join(evidenceDir, 'prompt.json'), { prompt: scenario.prompt, model: plan.models[m.id] });
        try {
          results.run.promptAttempts++; save();
          log(`${m.displayName}: ${row} · ${plan.models[m.id]} · ${plan.timeoutMs / 1000}s deadline`);
          const credential = plan.credentials[m.id];
          const workerContext = { dirs: ctx.dirs, options: ctx.options, apiUrl: api.url, secrets: { [credential]: selectedSecrets[credential] } };
          const processResult = await spawnCapture(process.execPath, [worker], { cwd: project, env: smokeEnv(ctx), timeoutMs: plan.timeoutMs,
            input: JSON.stringify({ id: m.id, model: plan.models[m.id], timeoutMs: Math.max(5000, plan.timeoutMs - 10000), ctx: workerContext, project, prompt: scenario.prompt, evidenceDir }) });
          const file = path.join(evidenceDir, 'worker-turn.json');
          let turn = { client: m.id, exitCode: processResult.code, isError: true, finalText: '', toolCalls: [], errorDetail: 'Native worker did not produce a complete receipt' };
          if (existsSync(file)) { try { turn = JSON.parse(readFileSync(file, 'utf8')); } catch { /* Keep the incomplete receipt. */ } }
          turn.workerTimedOut = processResult.timedOut; turn.workerExitCode = processResult.code;
          if (processResult.code !== 0) turn.isError = true;
          const trace = readLiveTrace(traceDir);
          const receipt = { scenario, turn, trace, requests: api.requests.slice(start), unexpected: api.unexpected.slice(unexpectedStart), incidental: api.incidental.slice(incidentalStart) };
          const checks = scoreLiveScenario(scenario, receipt, plan.maxMcpCalls);
          assertCandidate(ctx.candidate);
          const result = cell({ row, scenario: id, client: m, checks, prompt: scenario.prompt, evidence: [attempt.evidence] });
          results.cells.push(result);
          Object.assign(attempt, { status: result.status, checks, durationMs: processResult.durationMs, finishedAt: new Date().toISOString(), turn, trace, requests: receipt.requests, incidentalCount: receipt.incidental.filter(r => r.kind === 'capture-discarded').length });
          writeFileSync(path.join(evidenceDir, 'receipt.json'), redactLive(receipt, secrets()), { mode: 0o600 });
          writeFileSync(path.join(evidenceDir, 'worker.stderr.txt'), redactLive(processResult.stderr, secrets()), { mode: 0o600 });
        } finally { restore(); redactLiveDirectory(evidenceDir, secrets()); save(); }
        // A broken first session is diagnostic evidence, not a reason to pay for a retry.
        if (attempt.status !== 'PASS' && id === 'round-trip') { results.cells.push(...blockedCells(['Error and recovery'], 'recovery', m, 'First native scenario did not pass; the second paid scenario was not started.')); save(); break; }
      }
    }
    results.run.complete = !interrupted;
  } catch (error) { results.run.error = error.message; }
  finally {
    globalThis.clearInterval(heartbeat);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await close();
    const drift = diff(before, snapshot()); results.isolation = { ok: drift.length === 0, drift };
    results.run.finishedAt = new Date().toISOString();
    if (interrupted) results.run.complete = false;
    if (api) writeFileSync(path.join(ctx.dirs.evidence, 'fixture-requests.json'), redactLive({ requests: api.requests, unexpected: api.unexpected, incidental: api.incidental }, secrets()));
    redactLiveDirectory(ctx.dirs.evidence, secrets());
    ctx.writeJson(path.join(ctx.dirs.run, 'isolation.json'), results.isolation);
    save();
    process.exitCode = liveSmokeOutcome(results) === 'PASS' ? 0 : 1;
    log(`${liveSmokeOutcome(results)} · Report: ${path.join(ctx.dirs.run, 'report.html')}`);
  }
  return results;
}
