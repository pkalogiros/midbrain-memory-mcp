import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { createRunContext, defaultRoot, HARNESS_VERSION } from './context.mjs';
import { freezeCandidate, assertCandidate } from './candidate.mjs';
import { seedDetectionFixtures, writeGlobalKey, writeGlobalHostConfig, initProject, installCandidate, inspectInstall } from './home.mjs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parse as jsonc } from 'jsonc-parser';
import { scriptedClient, scriptedClientConfig, scriptedArgs, scriptedNativeEvent, scriptedNativeEnv, collectScriptedNative } from './scripted-smoke-clients.mjs';
import { snapshot, diff } from './tripwire.mjs';
import { spawnCapture, whichSync, stopChildProcesses } from './proc.mjs';
import { cell, blockedCells } from '../scenarios/_shared.mjs';
import { check, BlockedError } from './checks.mjs';
import { smokeEnv } from './dry-smoke-policy.mjs';
import { installedSmokeEntry, instrumentSmokeEntry } from './dry-smoke-config.mjs';
import { startSmokeApi, SMOKE_KEYS, SMOKE_TOOLS, redactSmoke } from './dry-smoke-fixture.mjs';
import { readLiveTrace, redactLiveDirectory } from './live-smoke-evidence.mjs';
import { SCRIPTED_ROWS, SCRIPTED_SCOPE, validateScriptedFlags, scriptedPlan, startScriptedProvider, scoreScripted, scriptedOutcome } from './scripted-smoke-policy.mjs';
import { renderScriptedHtml, renderScriptedMarkdown, renderScriptedJUnit } from './scripted-smoke-report.mjs';

const identifiedCheck = (id, ...args) => ({ id, ...check(...args) });
const log = text => console.error(`[scripted-smoke] ${text}`);
const proxy = fileURLToPath(new URL('./live-smoke-proxy.mjs', import.meta.url));
const peerScript = fileURLToPath(new URL('./scripted-smoke-peer.mjs', import.meta.url));
export async function runScriptedSmoke(flags) {
  validateScriptedFlags(flags);
  const client = scriptedClient(flags.clients || 'pi');
  const ctx = createRunContext({ root: flags.root ? path.resolve(flags.root) : defaultRoot(), options: { drySmoke: true } });
  const before = snapshot();
  const report = { schemaVersion: 1, assertionSchemaVersion: 1, harnessVersion: HARNESS_VERSION, run: { kind: 'scripted-smoke', scope: SCRIPTED_SCOPE, runId: ctx.runId, runDir: ctx.dirs.run, startedAt: ctx.startedAt, platform: ctx.platform, arch: ctx.arch, node: ctx.node, complete: false, llmCalls: 0, localProviderRequests: 0, toolCallCap: scriptedPlan('', client.id).length, timeoutMs: 90000 }, candidate: {}, clients: [{ id: client.id, displayName: client.displayName, version: null }], cells: [], scriptedEvidence: null, isolation: { ok: false, drift: [] } };
  let api; let provider; let restore; let interrupted = false; let closing;
  const save = () => {
    const safe = JSON.parse(redactSmoke(report));
    ctx.writeJson(path.join(ctx.dirs.run, 'results.json'), safe);
    writeFileSync(path.join(ctx.dirs.run, 'report.html'), renderScriptedHtml(safe));
    writeFileSync(path.join(ctx.dirs.run, 'report.md'), renderScriptedMarkdown(safe));
    writeFileSync(path.join(ctx.dirs.run, 'junit.xml'), renderScriptedJUnit(safe));
  };
  const close = () => closing ||= (async () => { await stopChildProcesses(); if (provider) await provider.close(); if (api) await api.close(); })();
  const interrupt = () => { interrupted = true; void close(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const heartbeat = globalThis.setInterval(() => log(`${provider?.receipts.length || 0}/${report.run.toolCallCap} tool results returned by ${client.displayName}; ${provider?.attempts.length || 0}/${report.run.toolCallCap + 1} local provider requests`), 30000);
  try {
    save();
    if (!client.os.includes(process.platform)) throw new BlockedError(`${client.displayName} native harness driver does not support ${process.platform}`);
    let binary = whichSync(client.binary, smokeEnv(ctx));
    if (!binary && flags['install-clients']) { await client.preflight(ctx); binary = whichSync(client.binary, smokeEnv(ctx)); }
    if (!binary) throw new BlockedError(`${client.displayName} is missing; install it or use --install-clients for a run-local installation`);
    const version = await spawnCapture(binary, ['--version'], { env: smokeEnv(ctx), timeoutMs: 30000 });
    if (version.code !== 0) throw new BlockedError(`${client.displayName} --version failed`);
    report.clients[0].version = version.stdout.trim();
    log(`Preparing the frozen candidate and isolated ${client.displayName} installation. No model credentials are loaded.`);
    api = await startSmokeApi({ allowCapture: true }); ctx.apiUrl = api.url;
    report.candidate = ctx.candidate = await freezeCandidate({ mode: 'dev', directory: path.join(ctx.dirs.run, 'candidate'), env: smokeEnv(ctx) });
    ctx.writeJson(path.join(ctx.dirs.run, 'candidate.json'), ctx.candidate);
    seedDetectionFixtures(ctx, [client]); writeGlobalKey(ctx, SMOKE_KEYS.global); writeGlobalHostConfig(ctx, api.url);
    writeFileSync(path.join(ctx.dirs.tmp, '.midbrain-update-check.json'), JSON.stringify({ lastCheck: Date.now() }));
    const project = await initProject(ctx, `scripted-${client.id}`);
    const evidenceDir = ctx.evidenceDir(client.id, 'scripted-smoke'); const traceDir = path.join(evidenceDir, 'mcp-events'); mkdirSync(traceDir);
    const peerLog = path.join(evidenceDir, 'peer-events.ndjson');
    const configFile = path.join(ctx.dirs.home, client.id === 'pi' ? '.pi/agent/models.json' : client.id === 'hermes' ? '.hermes/config.yaml' : '.config/opencode/opencode.jsonc');
    let peerEntry;
    if (client.id === 'opencode') {
      const initial = jsonc(readFileSync(configFile, 'utf8'));
      peerEntry = { type: 'local', command: [process.execPath, peerScript, peerLog], enabled: true };
      initial.mcp ||= {}; initial.mcp['scripted-peer'] = peerEntry;
      ctx.writeJson(configFile, initial);
    }
    mkdirSync(path.join(project, 'selected-agent')); mkdirSync(path.join(project, 'setup-project'));
    const installed = await installCandidate(ctx, ctx.candidate, { cwd: project });
    const inspection = await inspectInstall(ctx, ctx.candidate, client.id);
    const entry = installedSmokeEntry(ctx, client.id);
    const checks = [identifiedCheck('install', 'Frozen candidate installs successfully', installed.code === 0), identifiedCheck('integration', `Product recognizes a fresh ${client.displayName} integration`, inspection.installed === true && inspection.fresh === true), identifiedCheck('candidate', 'Installed MCP points at the frozen candidate', entry.command === process.execPath && entry.args?.[0] === path.join(ctx.candidate.repoRoot, 'index.js'))];
    report.cells.push(cell({ row: 'Installation', scenario: 'scripted-smoke', client, checks }));
    if (!checks.every(c => c.ok)) throw new Error(`${client.displayName} installation failed; inspect installer evidence`);
    const plan = scriptedPlan(project, client.id); provider = await startScriptedProvider(plan, event => appendFileSync(path.join(evidenceDir, 'provider-events.ndjson'), `${JSON.stringify(JSON.parse(redactSmoke(event)))}\n`, { mode: 0o600 }), client.id);
    const currentConfig = client.id === 'opencode' ? jsonc(readFileSync(configFile, 'utf8')) : client.id === 'hermes' ? parseYaml(readFileSync(configFile, 'utf8')) : {};
    if (peerEntry) {
      const preserved = JSON.stringify(currentConfig.mcp?.['scripted-peer']) === JSON.stringify(peerEntry);
      report.cells[0].checks.push(identifiedCheck('peer-preserved', 'Installer preserves the independent same-name MCP server', preserved));
      if (!preserved) { report.cells[0].status = 'FAIL'; throw new Error('Installer changed the peer MCP configuration'); }
      const peerSpec = path.join(evidenceDir, 'peer-proxy.json');
      ctx.writeJson(peerSpec, { entry: { command: process.execPath, args: [peerScript, peerLog] }, traceDir, maxMcpCalls: plan.length, allowedTools: ['memory_search'] });
      currentConfig.mcp['scripted-peer'].command = [process.execPath, proxy, peerSpec];
    }
    const configured = scriptedClientConfig(client.id, provider.url, currentConfig);
    if (client.id === 'hermes') writeFileSync(configFile, stringifyYaml(configured));
    else ctx.writeJson(configFile, configured);
    const spec = path.join(evidenceDir, 'proxy.json'); ctx.writeJson(spec, { entry, traceDir, maxMcpCalls: plan.length, allowedTools: SMOKE_TOOLS });
    restore = instrumentSmokeEntry(ctx, client.id, process.execPath, [proxy, spec]);
    const prompt = 'Run this controlled MCP integration test. Execute the scripted tool requests, including account and setup tools, only against the provided synthetic backend and throwaway project directories. All credentials and data are fixtures.';
    const turn = { toolCalls: [], nativeAssistantMessages: [], finalText: '', isError: false };
    assertCandidate(ctx.candidate); save();
    log(`Launching native ${client.displayName}: all 12 tools, then a 503 and recovery. Provider endpoint is loopback only.`);
    const nativeEnv = smokeEnv(ctx, { MIDBRAIN_DEV: '1', MIDBRAIN_API_URL: api.url, ...scriptedNativeEnv(client.id, provider.url) });
    const result = await spawnCapture(binary, scriptedArgs(client.id, project, prompt), {
      cwd: project, env: nativeEnv, timeoutMs: report.run.timeoutMs, stdoutFile: path.join(evidenceDir, 'native.ndjson'),
      onStdoutLine: line => { try { scriptedNativeEvent(client.id, turn, JSON.parse(line), ctx, evidenceDir); } catch { /* Raw output retained; missing receipts fail the gate. */ } },
    });
    Object.assign(turn, { exitCode: result.code, timedOut: result.timedOut, durationMs: result.durationMs, stderr: result.stderr });
    await collectScriptedNative(client.id, binary, result, turn, { project, env: nativeEnv, evidenceDir, prompt });
    const peerRequests = existsSync(peerLog) ? readFileSync(peerLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const receipt = { client: client.id, peerRequests, plan, prompt, provider: { complete: provider.complete, issues: provider.issues, attempts: provider.attempts, requests: provider.requests, receipts: provider.receipts }, turn, trace: readLiveTrace(traceDir), requests: api.requests, unexpected: api.unexpected };
    report.scriptedEvidence = receipt; report.run.localProviderRequests = provider.attempts.length;
    const scored = scoreScripted(receipt);
    let keysMatch = false;
    try { keysMatch = readFileSync(path.join(project, 'selected-agent/.midbrain/.midbrain-key'), 'utf8').trim() === SMOKE_KEYS.minted && readFileSync(path.join(project, 'setup-project/.midbrain/.midbrain-key'), 'utf8').trim() === SMOKE_KEYS.project; } catch { /* Missing output is a failed assertion; preserve every other receipt. */ }
    scored.push(identifiedCheck('project-keys', 'Setup and account tools wrote the expected synthetic project keys', keysMatch));
    assertCandidate(ctx.candidate); scored.push(identifiedCheck('candidate-unchanged', 'Frozen candidate and harness inputs remained unchanged', true));
    for (const [row, recovery] of [['Native tool round trips', false], ['Failure recovery', true]]) report.cells.push(cell({ row, scenario: 'scripted-smoke', client, checks: scored.filter(c => Boolean(c.recovery) === recovery), evidence: [`evidence/${client.id}/scripted-smoke/receipt.json`] }));
    report.run.complete = !interrupted;
  } catch (error) {
    report.run.error = error.message;
    if (error.blocked) { report.cells.push(...blockedCells(SCRIPTED_ROWS, 'scripted-smoke', client, error.message)); report.run.complete = !interrupted; }
  } finally {
    globalThis.clearInterval(heartbeat); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await close(); if (restore) restore();
    if (provider && !report.scriptedEvidence) report.scriptedEvidence = { provider: { complete: provider.complete, attempts: provider.attempts, requests: provider.requests, receipts: provider.receipts, issues: provider.issues }, requests: api?.requests || [] };
    report.run.localProviderRequests = provider?.attempts.length || 0;
    if (report.scriptedEvidence) { const dir = ctx.evidenceDir(client.id, 'scripted-smoke'); writeFileSync(path.join(dir, 'receipt.json'), redactSmoke(report.scriptedEvidence)); }
    redactLiveDirectory(ctx.dirs.evidence, Object.values(SMOKE_KEYS));
    const drift = diff(before, snapshot()); report.isolation = { ok: drift.length === 0, drift }; ctx.writeJson(path.join(ctx.dirs.run, 'isolation.json'), report.isolation);
    report.run.finishedAt = new Date().toISOString(); if (interrupted) report.run.complete = false;
    save(); process.exitCode = scriptedOutcome(report) === 'PASS' ? 0 : 1;
    log(`${scriptedOutcome(report)} · Report: ${path.join(ctx.dirs.run, 'report.html')}`);
  }
  return report;
}
