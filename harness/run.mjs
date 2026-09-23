#!/usr/bin/env node
import { profileOptions } from './lib/profiles.mjs';
import { addFailureTraces } from './lib/failure-traces.mjs';
import { loadExperiment, SIMPLE_SCENARIOS } from './lib/experiment.mjs';
// MidBrain multi-client behavioral harness — CLI.
//   node harness/run.mjs doctor
//   node harness/run.mjs freeze
//   node harness/run.mjs run --clients claude,codex [--scenarios s01,s06] [--keep]
//   node harness/run.mjs report <runDir>
import path from 'node:path';
import os from 'node:os';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { loadDotEnv, collectSecrets } from './lib/env.mjs';
import { createRunContext, defaultRoot, HARNESS_DIR, HARNESS_VERSION } from './lib/context.mjs';
import { freezeCandidate, assertCandidate } from './lib/candidate.mjs';
import { selectManifests, clientPairs, ORDER, MANIFESTS } from './clients/index.mjs';
import { selectScenarios, SCENARIOS } from './scenarios/index.mjs';
import { HarnessApi, DEFAULT_API_BASE } from './lib/api.mjs';
import { snapshot, diff, keyCollidesWithRealHome } from './lib/tripwire.mjs';
import { seedDetectionFixtures, writeGlobalKey, writeGlobalHostConfig, initProject, installCandidate, inspectInstall } from './lib/home.mjs';
import { configShapeSnapshot, cacheSpoolCounts } from './lib/evidence.mjs';
import { attentionText, requestedModel } from './lib/report-copy.mjs';
import { renderMarkdown } from './lib/report.mjs';
import { renderRunHtml } from './lib/report-html.mjs';
import { withFailureContext } from './lib/saved-reports.mjs';
import { recordedCosts } from './lib/costs.mjs';
import { check, BlockedError, isMidbrainTool, runExitCode, runOutcome } from './lib/checks.mjs';
import { whichSync, runSync, stopChildProcesses } from './lib/proc.mjs';
import { cell, blockedCells } from './scenarios/_shared.mjs';
import { prepareRegistry } from './lib/registry.mjs';
import { runUpgradePrelude } from './lib/upgrade.mjs';
import { runJobs, parseConcurrency, scenarioConcurrency, scenarioResources } from './lib/scheduler.mjs';
import { loadBaseline, validateBaseline, validateClientVersion, reusePreparedTools, followupScenarios, modelCheckOptions } from './lib/followup.mjs';

const log = (msg) => console.error(`[harness ${new Date().toISOString().slice(11, 19)}] ${msg}`);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) { flags[a.slice(2)] = rest[i + 1]; i += 1; }
      else flags[a.slice(2)] = true;
    } else {
      flags._.push(a);
    }
  }
  return { cmd, flags };
}

function list(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined ? n : dflt;
}

function apiBaseUrl() {
  return (process.env.MIDBRAIN_HARNESS_API_URL || '').trim() || DEFAULT_API_BASE;
}

function insideTmp(p) {
  const tmp = os.tmpdir();
  const norm = (x) => path.resolve(x).replace(/\/+$/, '');
  return norm(p).startsWith(`${norm(tmp)}${path.sep}`) || norm(p).startsWith('/tmp/') || norm(p).startsWith('/private/tmp/');
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function doctor(flags) {
  loadDotEnv(path.join(HARNESS_DIR, '.env'));
  const secrets = collectSecrets();
  const root = flags.root ? path.resolve(flags.root) : defaultRoot();
  const rows = [];
  let ok = true;
  rows.push(['harness', `v${HARNESS_VERSION}`, `node ${process.version}, ${process.platform}/${process.arch}`]);
  rows.push(['run root', root, insideTmp(root) ? 'FAIL: inside tmpdir (self-repair would be skipped)' : 'ok (durable)']);
  if (insideTmp(root)) ok = false;
  if ((process.env.CI || '').trim()) rows.push(['CI env', 'set', 'note: harness children never inherit CI']);

  const key = secrets.MIDBRAIN_HARNESS_API_KEY;
  if (!key) { rows.push(['MIDBRAIN_HARNESS_API_KEY', 'missing', 'FAIL: dedicated MidBrain agent key required']); ok = false; }
  else {
    const collide = keyCollidesWithRealHome(key);
    if (collide) { rows.push(['MIDBRAIN_HARNESS_API_KEY', 'present', `FAIL: matches real-home key file ${collide}`]); ok = false; }
    else {
      const api = new HarnessApi({ baseUrl: apiBaseUrl(), key });
      const p = await api.probe();
      rows.push(['MIDBRAIN_HARNESS_API_KEY', 'present', p.ok ? `ok: ${apiBaseUrl()} HTTP ${p.status}` : `FAIL: ${apiBaseUrl()} HTTP ${p.status} ${p.error || ''}`]);
      if (!p.ok) ok = false;
    }
  }
  rows.push(['MIDBRAIN_HARNESS_PROJECT_API_KEY', secrets.MIDBRAIN_HARNESS_PROJECT_API_KEY ? 'present' : 'missing', secrets.MIDBRAIN_HARNESS_PROJECT_API_KEY ? 'S4 enabled' : 'S4 (project isolation) will be BLOCKED']);

  const wanted = selectManifests(list(flags.clients));
  const runnable = [];
  for (const m of wanted) {
    const bin = whichSync(m.binary);
    const runLocal = m.install.kind === 'npm' || m.install.kind === 'uv-tool';
    const missingSecrets = m.requiredSecrets.filter((s) => !secrets[s]);
    let verdict;
    if (!bin && !runLocal) verdict = `BLOCKED: ${m.binary} not on PATH (${m.install.hint || m.install.kind})`;
    else if (missingSecrets.length) verdict = `BLOCKED: missing ${missingSecrets.join(', ')}`;
    else {
      try { await m.preflight({ secrets }, { doctor: true }); verdict = runLocal && !bin ? `ready (${m.install.pkg} installed run-locally at run time)` : 'ready'; runnable.push(m.id); } catch (e) { verdict = `BLOCKED: ${e.message}`; }
    }
    let version = '';
    if (bin) {
      const v = runSync(m.binary, ['--version'], { timeout: 20000 });
      version = `${v.stdout || ''}${v.stderr || ''}`.trim().split('\n')[0];
    }
    rows.push([`client ${m.id}`, bin ? `${bin}${version ? ` [${version}]` : ''}` : (runLocal ? 'not on host PATH (run-local)' : 'not installed'), verdict]);
  }
  if (!runnable.length) ok = false;

  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v, note] of rows) console.log(`${k.padEnd(width)}  ${v}\n${''.padEnd(width)}  └ ${note}`);
  console.log('');
  console.log(ok ? `READY: runnable clients → ${runnable.join(', ')}` : 'NOT READY: fix the FAIL/BLOCKED lines above');
  process.exitCode = ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function runScenario(sc, args, cells, creditClient) {
  const started = Date.now();
  const label = client => `${client.displayName || client.id} (${requestedModel(client)})`;
  const who = args.client ? label(args.client) : `${label(args.writer)} → ${label(args.reader)}`;
  const explain = out => {
    if (!out.some(c => ['FAIL', 'BLOCKED', 'FLAKY'].includes(c.status))) return;
    const clients = [args.client, args.writer, args.reader].filter(Boolean);
    const report = { run: { runDir: args.ctx.dirs.run, models: Object.fromEntries(clients.map(c => [c.id, requestedModel(c)])) }, cells: out };
    for (const line of attentionText(withFailureContext(report).cells).split('\n')) if (line) log(line);
  };
  log(`Starting ${sc.title || sc.id} [${who}]`);
  try {
    const out = await sc.run(args);
    for (const c of out) { c.durationMs = Date.now() - started; cells.push(c); }
    log(`  ${sc.title || sc.id} [${who}] → ${out.map((c) => `${c.row}=${c.status}`).join(', ')} (${Math.round((Date.now() - started) / 1000)} s)`);
    explain(out);
  } catch (e) {
    if (e && e.blocked) {
      const out = blockedCells(sc.rows, sc.id, creditClient, e.message);
      cells.push(...out);
      explain(out);
      log(`  ${sc.title || sc.id} [${who}] → BLOCKED: ${e.message}`);
    } else {
      cells.push(...sc.rows.map((row) => cell({ row, scenario: sc.id, client: creditClient, checks: [check('scenario completed without harness error', false, (e && e.stack ? e.stack : String(e)).slice(0, 800))] })));
      log(`  ${sc.title || sc.id} [${who}] → harness error: ${e && e.message ? e.message : e}`);
    }
  }
}

async function run(flags) {
  loadDotEnv(path.join(HARNESS_DIR, '.env'));
  const experimentFile = flags.config || process.env.MIDBRAIN_HARNESS_CONFIG;
  const experiment = experimentFile ? loadExperiment(path.resolve(experimentFile), Object.keys(MANIFESTS)) : null;
  if (experiment && (flags.high || flags.xhigh)) throw new Error('Custom experiment config is for --simple.');
  flags = profileOptions(flags);
  if (experiment) {
    if (flags['model-checks'] || flags['follow-up']) throw new Error('Custom experiments use --simple, not the fixed model-check profile.');
    flags = { ...flags, simple: true, clients: flags.clients || experiment.clients.join(',') };
    for (const [id, model] of Object.entries(experiment.models || {})) process.env[`MIDBRAIN_HARNESS_${id.toUpperCase()}_MODEL`] ||= model;
  }
  const quickSimple = Boolean(flags.simple && !flags.high && !flags['model-checks'] && !flags['follow-up']);
  if (quickSimple && flags.required) throw new Error('--simple cannot be combined with --required');
  if (quickSimple && (flags.upgrade || flags.required || flags.scenarios)) throw new Error('Simple uses capture, fresh-session recall and an unrelated question. Use --config to customize it; omit --simple for upgrade/full scenarios.');
  flags = modelCheckOptions(flags);
  const baseline = flags['follow-up'] === undefined ? null : loadBaseline(flags['follow-up']);
  if (baseline) {
    flags = { ...flags, clients: flags.clients ?? baseline.results.clients.map(c => c.id).join(',') };
  }
  if (flags.simple && flags.required) throw new Error('--simple cannot be combined with --required; the required gate checks every ordered client pair');
  const concurrency = parseConcurrency(flags.concurrency);
  loadDotEnv(path.join(HARNESS_DIR, '.env'));
  const secrets = collectSecrets();
  const key = secrets.MIDBRAIN_HARNESS_API_KEY;
  if (!key) throw new Error('MIDBRAIN_HARNESS_API_KEY is required (harness/.env or environment). Run `node harness/run.mjs doctor`.');
  const collide = keyCollidesWithRealHome(key);
  if (collide) throw new Error(`refusing to run: MIDBRAIN_HARNESS_API_KEY matches the real-home key file ${collide}`);

  const mode = flags.mode || 'dev';
  const upgrade = Boolean(flags.upgrade);
  if (upgrade && mode !== 'registry') throw new Error('--upgrade requires --mode registry');
  if (flags.required && (mode !== 'registry' || !upgrade || flags.clients || flags.scenarios)) throw new Error('--required needs --mode registry --upgrade and the full client/scenario matrix');
  const root = flags.root ? path.resolve(flags.root) : defaultRoot();
  if (insideTmp(root)) throw new Error(`run root ${root} is inside the temp dir; the product skips self-repair there`);
  const ctx = createRunContext({
    root,
    options: {
      readbackTimeoutMs: num(flags['readback-timeout-ms'], num(process.env.MIDBRAIN_HARNESS_READBACK_TIMEOUT_MS, 180000)),
      indexGraceMs: num(flags['index-grace-ms'], num(process.env.MIDBRAIN_HARNESS_INDEX_GRACE_MS, 20000)),
      pollIntervalMs: num(flags['poll-interval-ms'], 5000),
      keep: Boolean(flags.keep),
      required: Boolean(flags.required),
      simple: Boolean(flags.simple),
      quickSimple, experiment,
      profile: quickSimple ? 'simple' : flags.high ? 'high' : flags.xhigh ? 'xhigh' : null,
      concurrency,
      interactive: Boolean(flags.interactive),
      upgrade,
      modelChecks: Boolean(baseline || flags['model-checks']),
    },
  });
  ctx.secrets = secrets;
  ctx.log = log;
  ctx.cleanup = [];
  let cleanupPromise;
  const cleanupRun = () => cleanupPromise ||= (async () => {
    const results = await Promise.allSettled(ctx.cleanup.map(fn => fn()));
    if (ctx.registry) await ctx.registry.stop();
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
  })();
  const interrupted = async signal => {
    log(`${signal}: stopping active client processes and cleaning up …`);
    await stopChildProcesses();
    try { await cleanupRun(); } catch (e) { log(`cleanup failed: ${e.message}`); }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onInt = () => interrupted('SIGINT');
  const onTerm = () => interrupted('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  const heartbeat = globalThis.setInterval(() => log(`still running · ${Math.round((Date.now() - Date.parse(ctx.startedAt)) / 1000)} s elapsed · ${ctx.turns.length} completed prompts · Ctrl+C to stop`), 30000);
  try {
  const api = new HarnessApi({ baseUrl: apiBaseUrl(), key });
  log('checking MidBrain API access before candidate build and client setup …');
  const probe = await api.probe();
  if (!probe.ok) throw new Error(`MidBrain API probe failed: ${apiBaseUrl()} HTTP ${probe.status} ${probe.error || ''}`);
  const candidate = await freezeCandidate({ mode, directory: path.join(ctx.dirs.run, 'candidate') });
  ctx.candidate = candidate;
  const manifests = selectManifests(list(flags.clients));
  const scenarios = quickSimple ? (experiment?.scenarios || Object.keys(SIMPLE_SCENARIOS)).map(name => selectScenarios([SIMPLE_SCENARIOS[name]])[0]).sort((a,b) => ['s01','s03','s06'].indexOf(a.id.slice(0,3)) - ['s01','s03','s06'].indexOf(b.id.slice(0,3))) : selectScenarios(ctx.options.modelChecks ? followupScenarios() : list(flags.scenarios));
  let followup = null;
  if (baseline) {
    const reusedChecks = validateBaseline(baseline.results, candidate, manifests, { apiBase: apiBaseUrl(), pk: process.env.MIDBRAIN_HARNESS_PK === '1' });
    followup = { baselineRunId: baseline.results.run.runId, directory: baseline.dir, reportSha256: baseline.reportSha256, reusedChecks };
    reusePreparedTools(ctx, baseline, manifests);
    log(`follow-up: verified baseline ${followup.baselineRunId}; ${reusedChecks.length} infrastructure checks retained as prior evidence (not rerun)`);
  }
  if (mode === 'registry') {
    log('starting loopback registry (verdaccio) …');
    await prepareRegistry(ctx, candidate, { publish: !upgrade });
    log(`loopback ${candidate.registry.url} · publish version ${candidate.registry.publishVersion}${candidate.registry.exact ? ' (exact tarball)' : ' (rc, version already on npm)'}${upgrade ? ' · publish deferred until after the previous-release install' : ''}`);
  }
  ctx.writeJson(path.join(ctx.dirs.run, 'candidate.json'), candidate);
  log(`run ${ctx.runId} · marker ${ctx.marker} · candidate ${candidate.version}@${candidate.shortSha}${candidate.dirty ? ' (dirty)' : ''} · ${mode} mode · ${ctx.dirs.run}`);

  const before = snapshot();
  ctx.writeJson(path.join(ctx.dirs.run, 'isolation-before.json'), before);

  writeGlobalHostConfig(ctx, (process.env.MIDBRAIN_HARNESS_API_URL || '').trim() || null);

  const clientStates = [];
  for (const m of manifests) {
    const st = { manifest: m, id: m.id, displayName: m.displayName, runnable: false, blockedReason: null, version: null, knownExceptions: m.knownExceptions, mechanism: m.mechanism, configShape: null };
    try {
      const missing = m.requiredSecrets.filter((s) => !secrets[s]);
      if (missing.length) throw new BlockedError(`missing secret(s): ${missing.join(', ')}`);
      await m.preflight(ctx);
      st.version = await m.version(ctx);
      if (baseline) validateClientVersion(baseline.results, m.id, st.version);
      st.runnable = true;
    } catch (e) {
      st.blockedReason = e.message;
      if (baseline) throw e; // An incompatible baseline must stop before model calls.
    }
    log(`client ${m.id}: ${st.runnable ? `ready (${st.version || 'version unknown'})` : `BLOCKED: ${st.blockedReason}`}`);
    clientStates.push(st);
  }

  const cells = [];
  const runnable = clientStates.filter((s) => s.runnable).map((s) => s.manifest);
  seedDetectionFixtures(ctx, runnable);
  writeGlobalKey(ctx, key);
  const projA = await initProject(ctx, 'proj-a');
  const projB = await initProject(ctx, 'proj-b');
  const projC = await initProject(ctx, 'proj-c');

  let installResult = null;
  if (runnable.length) {
    log(`installing candidate (${mode} mode) into ${ctx.dirs.home} for ${runnable.map((m) => m.id).join(', ')}`);
    installResult = await installCandidate(ctx, candidate, { cwd: projA });
    log(`installer exit ${installResult.code}`);
  }
  const installOk = Boolean(installResult && installResult.code === 0);
  for (const st of clientStates) {
    const m = st.manifest;
    if (!st.runnable) { cells.push(...blockedCells(['Clean install'], 'install', m, st.blockedReason)); continue; }
    try {
      if (typeof m.afterInstall === 'function') await m.afterInstall(ctx, { projects: [projA, projB, projC] });
    } catch (e) {
      st.runnable = false;
      st.blockedReason = `client setup failed: ${e.message}`;
      cells.push(cell({ row: 'Clean install', scenario: 'install', client: m, checks: [check('client setup completed', false, e.message)] }));
      log(`${m.id}: ${st.blockedReason}`);
      continue;
    }
    const insp = await inspectInstall(ctx, candidate, m.id, { installed: upgrade });
    st.configShape = configShapeSnapshot(ctx, m);
    const missing = Object.entries(st.configShape).filter(([, v]) => v === 'ABSENT').map(([k]) => k);
    cells.push(cell({
      row: 'Clean install', scenario: 'install', client: m,
      expected: `${upgrade ? 'Previous release' : 'Candidate'} installer exits 0; its product adapter reports the client installed and fresh; every declared config surface exists`,
      evidence: ['evidence/_install/install-global.stdout.txt', 'evidence/_install/install-global.stderr.txt'],
      notes: `adapter inspect: ${JSON.stringify(insp).slice(0, 500)}`,
      checks: [
        check('installer exited 0', installOk, installResult ? `exit=${installResult.code}` : 'not run'),
        check('adapter reports client installed', insp.installed === true, `installed=${insp.installed}`),
        check('adapter reports install fresh (hooks/plugins/shim canonical)', insp.fresh === true, `fresh=${insp.fresh}`),
        check('all declared config surfaces present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : ''),
      ],
    }));
    if (!installOk) { st.runnable = false; st.blockedReason = 'installer failed'; }
  }

  const active = clientStates.filter((s) => s.runnable).map((s) => s.manifest);
  const inactive = clientStates.filter((s) => !s.runnable);
  if (upgrade && active.length) {
    log(`upgrade prelude: previous release installed; capturing, publishing candidate, upgrading …`);
    try {
      const ucells = await runUpgradePrelude({ ctx, api, candidate, clients: active, project: projA });
      log(`upgrade prelude → ${Object.entries(ucells).map(([id, c]) => `${id}=${c.status}`).join(', ')}`);
    } catch (e) {
      log(`upgrade prelude failed: ${e.message}`);
      for (const m of active) cells.push(cell({ row: 'Upgrade and self-repair', scenario: 's09-upgrade-continuity', client: m, blockedReason: e.blocked ? e.message : undefined, checks: [check('upgrade prelude completed without harness error', false, (e.stack || String(e)).slice(0, 800))] }));
    }
  }
  // A simple cycle includes unavailable clients so missing coverage stays BLOCKED.
  const pairs = clientPairs(ctx.options.simple ? manifests : active, ctx.options.simple);
  const crossClientPairs = scenarios.some(sc => sc.kind === 'pair') ? pairs.map(({ writer, reader }) => ({ writer: writer.id, reader: reader.id })) : [];
  log(`cross-client coverage: ${ctx.options.simple ? 'simple cycle' : 'all ordered pairs'}; ${crossClientPairs.length} planned link(s)`);
  log(`concurrency: ${concurrency}; cold capture, upgrade and client-specific scenarios remain serial`);
  for (const sc of scenarios) {
    const jobs = [];
    const enqueue = (args, creditClient) => jobs.push({
      resources: scenarioResources(sc, args, ctx),
      run: async () => {
        const result = [];
        await runScenario(sc, args, result, creditClient);
        return result;
      },
    });
    if (sc.kind === 'pair') {
      if (pairs.length === 0) {
        for (const m of active) cells.push(...blockedCells(['Cross-client recall'], sc.id, m, 'fewer than two runnable clients in this run'));
      } else {
        for (const { writer, reader } of pairs) {
          const unavailable = clientStates.find(st => !st.runnable && (st.id === writer.id || st.id === reader.id));
          if (unavailable) {
            cells.push(...blockedCells(sc.rows, sc.id, reader, `${unavailable.id}: ${unavailable.blockedReason}`, { notes: `writer=${writer.id}, reader=${reader.id}` }));
            continue;
          }
          enqueue({ ctx, api, writer, reader, project: projA, candidate }, reader);
        }
      }
      if (!ctx.options.simple || pairs.length === 0) for (const st of inactive) cells.push(...blockedCells(sc.rows, sc.id, st.manifest, st.blockedReason));
    } else {
      for (const st of clientStates) {
        if (!st.runnable) { cells.push(...blockedCells(sc.rows, sc.id, st.manifest, st.blockedReason)); continue; }
        enqueue({ ctx, api, client: st.manifest, project: projA, candidate }, st.manifest);
      }
    }
    const completed = await runJobs(jobs, scenarioConcurrency(sc, concurrency));
    cells.push(...completed.flat());
    ctx.writeJson(path.join(ctx.dirs.run, 'results.partial.json'), { run: { simple: ctx.options.simple, concurrency, crossClientPairs }, cells });
  }

  // Tool availability: prefer init/real tool calls; otherwise probe the client's
  // own `mcp list` so a smoke that never needed a tool call is not a false FAIL.
  for (const st of clientStates) {
    const m = st.manifest;
    if (!st.runnable) { cells.push(...blockedCells(['Tool availability'], 'derived', m, st.blockedReason)); continue; }
    const turns = ctx.turns.filter((t) => t.client === m.id).map((t) => t.turn);
    const inits = turns.map((t) => t.init).filter(Boolean);
    const connectedInit = inits.some((i) => (i.mcpServers || []).some((sv) => /midbrain/i.test(String(sv.name)) && /connected|ready|ok/i.test(String(sv.status || ''))));
    const toolsListed = inits.some((i) => (i.tools || []).some((n) => /midbrain/i.test(String(n))));
    const successfulCall = turns.some((t) => (t.toolCalls || []).some((c) => isMidbrainTool(c) && c.ok === true && c.result));
    let probe = null;
    if (!connectedInit && !successfulCall && typeof m.mcpList === 'function') {
      try { probe = await m.mcpList(ctx); } catch (e) { probe = { code: -1, text: e.message, connected: false }; }
    }
    const probeConnected = probe ? (probe.connected ?? (/midbrain/i.test(probe.text) && /(connected|enabled|✓)/i.test(probe.text))) : false;
    const available = connectedInit || successfulCall || probeConnected;
    const checks = [];
    if (inits.length) checks.push(check('MCP server reported at session init', connectedInit || toolsListed, JSON.stringify(inits[0].mcpServers || []).slice(0, 160)));
    checks.push(check('MidBrain MCP server available to the client (init, live tool call, or mcp-list probe)', available, `init=${connectedInit} call=${successfulCall} probe=${probeConnected}`));
    cells.push(cell({ row: 'Tool availability', scenario: 'derived', client: m, expected: 'MCP server midbrain-memory connected and memory tools callable', checks, notes: probe ? `mcp-list probe: ${probe.text.split('\n')[0]}` : (inits.length ? '' : 'no init event; judged by live tool calls') }));
  }

  for (const m of active) {
    try { await m.evidence(ctx, path.join(ctx.dirs.evidence, m.id)); } catch (e) { log(`evidence collection failed for ${m.id}: ${e.message}`); }
  }

  assertCandidate(candidate);
  for (const st of clientStates.filter(s => s.runnable)) {
    const finalVersion = await st.manifest.version(ctx);
    cells.push(cell({ row: 'Reproducibility', scenario: 'client-version', client: st.manifest, checks: [check('client version remained unchanged', Boolean(st.version) && finalVersion === st.version, `${st.version} → ${finalVersion}`)] }));
  }
  if (ctx.registry) { await ctx.registry.stop(); log('loopback registry stopped'); }
  const after = snapshot();
  const drift = diff(before, after);
  ctx.writeJson(path.join(ctx.dirs.run, 'isolation.json'), { before: before.takenAt, after: after.takenAt, drift });

  const results = {
    harnessVersion: HARNESS_VERSION,
    run: {
      required: ctx.options.required,
      simple: ctx.options.simple,
      quickSimple, experiment,
      profile: quickSimple ? 'simple' : flags.high ? 'high' : flags.xhigh ? 'xhigh' : null,
      concurrency,
      crossClientPairs,
      followup,
      modelChecks: ctx.options.modelChecks,
      promptCount: ctx.turns.length,
      costs: recordedCosts(ctx.dirs.run),
      promptsByClient: Object.fromEntries(manifests.map(m => [m.id, ctx.turns.filter(t => t.client === m.id).length])),
      toolPins: Object.fromEntries(manifests.map(m => [m.id, m.install.version || null])),
      captureSettings: { pk: process.env.MIDBRAIN_HARNESS_PK === '1' },
      runId: ctx.runId, marker: ctx.marker, platform: ctx.platform, arch: ctx.arch, osRelease: ctx.osRelease, node: ctx.node,
      startedAt: ctx.startedAt, finishedAt: new Date().toISOString(),
      readbackTimeoutMs: ctx.options.readbackTimeoutMs, indexGraceMs: ctx.options.indexGraceMs,
      apiBase: apiBaseUrl(), runDir: ctx.dirs.run, cacheSpool: cacheSpoolCounts(ctx),
      models: { pi: process.env.MIDBRAIN_HARNESS_PI_MODEL || 'claude-haiku-4-5', opencode: process.env.MIDBRAIN_HARNESS_OPENCODE_MODEL || 'client default', hermes: MANIFESTS.hermes?.options?.model || process.env.MIDBRAIN_HARNESS_HERMES_MODEL || 'claude-sonnet-4-5', claude: process.env.MIDBRAIN_HARNESS_CLAUDE_MODEL || 'client default', codex: process.env.MIDBRAIN_HARNESS_CODEX_MODEL || 'client default', nanoclaw: process.env.MIDBRAIN_HARNESS_NANOCLAW_MODEL || 'claude-sonnet-4-5' },
    },
    candidate,
    clients: clientStates.map(({ manifest: _m, ...rest }) => rest),
    cells,
    isolation: { ok: drift.length === 0, drift },
  };
  ctx.writeJson(path.join(ctx.dirs.run, 'results.json'), results);
  ctx.writeJson(path.join(ctx.dirs.run, 'costs.json'), results.run.costs);
  writeFileSync(path.join(ctx.dirs.run, 'report.md'), renderMarkdown(withFailureContext(results)));
  writeFileSync(path.join(ctx.dirs.run, 'report.html'), renderRunHtml(withFailureContext(results)));
  addFailureTraces(ctx.dirs.run);
  if (existsSync(path.join(ctx.dirs.run, 'results.partial.json'))) rmSync(path.join(ctx.dirs.run, 'results.partial.json'));

  const counts = {};
  for (const c of cells) counts[c.status] = (counts[c.status] || 0) + 1;
  log(`Finished · ${runOutcome(cells, drift.length === 0)}${counts.BLOCKED ? ' · incomplete coverage' : ''}: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')} · isolation ${drift.length ? `DRIFT(${drift.length})` : 'ok'}`);
  for (const line of attentionText(withFailureContext(results).cells).split('\n')) if (line) log(line);
  log(`report: ${path.join(ctx.dirs.run, 'report.md')}`);
  log(`HTML results: ${path.join(ctx.dirs.run, 'report.html')}`);
  console.log(path.join(ctx.dirs.run, 'report.md'));
  process.exitCode = runExitCode(cells, drift.length === 0);
  } finally {
    globalThis.clearInterval(heartbeat);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    await cleanupRun();
  }
}

// ---------------------------------------------------------------------------
// report / freeze / help
// ---------------------------------------------------------------------------
async function report(flags) {
  const dir = flags._[0];
  if (!dir) throw new Error('usage: report <runDir>');
  const { renderSavedReports } = await import('./lib/saved-reports.mjs');
  console.log(renderSavedReports(path.resolve(dir)));
}

async function freeze(flags) {
  const c = await freezeCandidate({ mode: flags.mode || 'dev' });
  console.log(JSON.stringify(c, null, 2));
}

function help() {
  console.log(`midbrain multi-client harness v${HARNESS_VERSION}

commands
  scripted-smoke [--clients pi|opencode|hermes|claude|codex] [--root DIR] [--install-clients]
    Real Pi, OpenCode, Hermes, Claude Code or Codex tool round trips with a local scripted provider. Zero LLM inference.
  live-smoke --config FILE [--clients a,b] [--execute] [--root DIR] [--install-clients]
           plan by default; --execute runs two bounded real-model tool scenarios against a local fixture
  dry-smoke [--clients a,b] [--root DIR] [--install-clients]
           model-free MCP integration checks; local fixture API and synthetic keys, no .env needed
  doctor   [--clients a,b]          readiness of this machine (clients, secrets, API, run root)
  freeze   [--mode dev]             print the frozen candidate identity (registry mode is prepared inside run)
  run      [--clients a,b] [--scenarios s01,s06] [--mode dev|registry] [--upgrade] [--simple | --high | --xhigh] [--required] [--keep]
           [--readback-timeout-ms N] [--index-grace-ms N] [--root DIR] [--concurrency N]
           [--interactive]
  report   <runDir|sweepDir>        re-render Markdown/HTML results without model calls
  review-bundle <runDir> [runDir...] --output NEW_DIR
           Export selected dry/scripted evidence with an offline overview and hashes.
  verify-review <bundleDir>        verify bundle integrity, not test success or authorship
  sweep    --follow-up RUN --models FILE [--parallel-runs 1] [--concurrency 4]
  sweep    --model-checks --models FILE [--parallel-runs 1] [--concurrency 4]

--follow-up RUN: reuse a verified baseline's infrastructure evidence and prepared tools.
                 Fresh homes and markers; six prompts per client with a cross-client cycle.
                 Candidate, harness, client versions, API and capture settings must match.
--model-checks: six-prompt model profile; infrastructure unverified, no baseline required.

--simple: three prompts per client: capture, fresh-session recall, unrelated question.
          Customize with --config FILE or MIDBRAIN_HARNESS_CONFIG. No upgrade/full cases.
--high: previous broad Simple: all scenarios + upgrades, one cross-client cycle.
--xhigh: full matrix + upgrades, all ordered cross-client pairs.
         Add --required for strict release evidence. High/XHigh use registry mode.
--concurrency: 1–5 concurrent client jobs (default 1; try 3). Each client stays ordered.
               Cold capture, upgrade and client-specific scenarios remain serial.
               Sweeps accept a total budget of 1–10, capped at 5 per round.

Native Codex hook approval is automatic for its S10 case (Python 3, Codex 0.150.1, Linux/macOS).
Use --interactive for manual terminal approval instead. --approve-codex-hooks is accepted for compatibility but no longer needed.

clients:   ${ORDER.join(', ')}
           Pi is opt-in with --clients pi (or a comma-separated list).
scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}

secrets (harness/.env or environment): MIDBRAIN_HARNESS_API_KEY, MIDBRAIN_HARNESS_PROJECT_API_KEY (optional),
  ${[...new Set(Object.values(MANIFESTS).flatMap((m) => m.requiredSecrets))].join(', ')}
`);
}

const { cmd, flags } = parseArgs(process.argv.slice(2));
const commands = { doctor, freeze, run, report, help };
commands['review-bundle'] = async flags => {
  if (Object.keys(flags).some(key => !['_', 'output'].includes(key)) || typeof flags.output !== 'string') throw new Error('Usage: review-bundle <runDir> [runDir...] --output NEW_DIR');
  const { exportReviewBundle } = await import('./lib/review-bundle.mjs');
  const result = exportReviewBundle(flags._, flags.output); console.log(`Review bundle: ${result.index}\n${result.runs.length} runs; ${result.files} verified files. Test outcomes are listed in the overview.`);
};
commands['verify-review'] = async flags => {
  if (Object.keys(flags).some(key => key !== '_') || flags._.length !== 1) throw new Error('Usage: verify-review <bundleDir>');
  const { verifyReviewBundle } = await import('./lib/review-bundle.mjs');
  const result = verifyReviewBundle(flags._[0]); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
};
commands['live-smoke'] = async flags => {
  const { runLiveSmoke } = await import('./lib/live-smoke.mjs');
  await runLiveSmoke(flags);
};
commands['scripted-smoke'] = async flags => {
  const { runScriptedSmoke } = await import('./lib/scripted-smoke.mjs');
  return runScriptedSmoke(flags);
};
commands['dry-smoke'] = async flags => {
  const { runDrySmoke } = await import('./lib/dry-smoke.mjs');
  await runDrySmoke(flags);
};
commands.sweep = async flags => {
  loadDotEnv(path.join(HARNESS_DIR, '.env'));
  const { runSweep } = await import('./lib/sweep.mjs');
  await runSweep(flags);
};
const fn = commands[cmd || 'help'];
if (!fn) { help(); process.exitCode = 2; }
else {
  try { await fn(flags); } catch (e) { log(`error: ${e.message}`); if (process.env.MIDBRAIN_HARNESS_DEBUG) console.error(e.stack); process.exitCode = 1; }
}
