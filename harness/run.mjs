#!/usr/bin/env node
// MidBrain multi-client behavioral harness — CLI.
//   node harness/run.mjs doctor
//   node harness/run.mjs freeze
//   node harness/run.mjs run --clients claude,codex [--scenarios s01,s06] [--keep]
//   node harness/run.mjs report <runDir>
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { loadDotEnv, collectSecrets } from './lib/env.mjs';
import { createRunContext, defaultRoot, HARNESS_DIR, HARNESS_VERSION } from './lib/context.mjs';
import { freezeCandidate } from './lib/candidate.mjs';
import { selectManifests, ORDER, MANIFESTS } from './clients/index.mjs';
import { selectScenarios, SCENARIOS } from './scenarios/index.mjs';
import { HarnessApi, DEFAULT_API_BASE } from './lib/api.mjs';
import { snapshot, diff, keyCollidesWithRealHome } from './lib/tripwire.mjs';
import { seedDetectionFixtures, writeGlobalKey, writeGlobalHostConfig, initProject, installCandidate, inspectInstall } from './lib/home.mjs';
import { configShapeSnapshot, cacheSpoolCounts } from './lib/evidence.mjs';
import { renderMarkdown } from './lib/report.mjs';
import { check, BlockedError, isMidbrainTool } from './lib/checks.mjs';
import { whichSync, runSync } from './lib/proc.mjs';
import { cell, blockedCells } from './scenarios/_shared.mjs';
import { prepareRegistry } from './lib/registry.mjs';
import { runUpgradePrelude } from './lib/upgrade.mjs';

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
  const who = args.client ? args.client.id : `${args.writer.id}→${args.reader.id}`;
  log(`▶ ${sc.id} [${who}]`);
  try {
    const out = await sc.run(args);
    for (const c of out) { c.durationMs = Date.now() - started; cells.push(c); }
    log(`  ${sc.id} [${who}] → ${out.map((c) => `${c.row}=${c.status}`).join(', ')} (${Math.round((Date.now() - started) / 1000)} s)`);
  } catch (e) {
    if (e && e.blocked) {
      cells.push(...blockedCells(sc.rows, sc.id, creditClient, e.message));
      log(`  ${sc.id} [${who}] → BLOCKED: ${e.message}`);
    } else {
      cells.push(...sc.rows.map((row) => cell({ row, scenario: sc.id, client: creditClient, checks: [check('scenario completed without harness error', false, (e && e.stack ? e.stack : String(e)).slice(0, 800))] })));
      log(`  ${sc.id} [${who}] → harness error: ${e && e.message ? e.message : e}`);
    }
  }
}

async function run(flags) {
  loadDotEnv(path.join(HARNESS_DIR, '.env'));
  const secrets = collectSecrets();
  const key = secrets.MIDBRAIN_HARNESS_API_KEY;
  if (!key) throw new Error('MIDBRAIN_HARNESS_API_KEY is required (harness/.env or environment). Run `node harness/run.mjs doctor`.');
  const collide = keyCollidesWithRealHome(key);
  if (collide) throw new Error(`refusing to run: MIDBRAIN_HARNESS_API_KEY matches the real-home key file ${collide}`);

  const mode = flags.mode || 'dev';
  const upgrade = Boolean(flags.upgrade);
  if (upgrade && mode !== 'registry') throw new Error('--upgrade requires --mode registry');
  const root = flags.root ? path.resolve(flags.root) : defaultRoot();
  if (insideTmp(root)) throw new Error(`run root ${root} is inside the temp dir; the product skips self-repair there`);
  const ctx = createRunContext({
    root,
    options: {
      readbackTimeoutMs: num(flags['readback-timeout-ms'], num(process.env.MIDBRAIN_HARNESS_READBACK_TIMEOUT_MS, 90000)),
      indexGraceMs: num(flags['index-grace-ms'], num(process.env.MIDBRAIN_HARNESS_INDEX_GRACE_MS, 20000)),
      pollIntervalMs: num(flags['poll-interval-ms'], 5000),
      keep: Boolean(flags.keep),
      upgrade,
    },
  });
  ctx.secrets = secrets;
  const candidate = await freezeCandidate({ mode });
  if (mode === 'registry') {
    log('starting loopback registry (verdaccio) …');
    await prepareRegistry(ctx, candidate, { publish: !upgrade });
    log(`loopback ${candidate.registry.url} · publish version ${candidate.registry.publishVersion}${candidate.registry.exact ? ' (exact tarball)' : ' (rc, version already on npm)'}${upgrade ? ' · publish deferred until after the previous-release install' : ''}`);
  }
  ctx.writeJson(path.join(ctx.dirs.run, 'candidate.json'), candidate);
  log(`run ${ctx.runId} · marker ${ctx.marker} · candidate ${candidate.version}@${candidate.shortSha}${candidate.dirty ? ' (dirty)' : ''} · ${mode} mode · ${ctx.dirs.run}`);

  const before = snapshot();
  ctx.writeJson(path.join(ctx.dirs.run, 'isolation-before.json'), before);

  const manifests = selectManifests(list(flags.clients));
  const scenarios = selectScenarios(list(flags.scenarios));
  const api = new HarnessApi({ baseUrl: apiBaseUrl(), key });
  const probe = await api.probe();
  if (!probe.ok) throw new Error(`MidBrain API probe failed: ${apiBaseUrl()} HTTP ${probe.status} ${probe.error || ''}`);
  writeGlobalHostConfig(ctx, (process.env.MIDBRAIN_HARNESS_API_URL || '').trim() || null);

  const clientStates = [];
  for (const m of manifests) {
    const st = { manifest: m, id: m.id, displayName: m.displayName, runnable: false, blockedReason: null, version: null, knownExceptions: m.knownExceptions, mechanism: m.mechanism, configShape: null };
    try {
      const missing = m.requiredSecrets.filter((s) => !secrets[s]);
      if (missing.length) throw new BlockedError(`missing secret(s): ${missing.join(', ')}`);
      await m.preflight(ctx);
      st.version = await m.version(ctx);
      st.runnable = true;
    } catch (e) {
      st.blockedReason = e.message;
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
    log(`installing candidate (dev mode) into ${ctx.dirs.home} for ${runnable.map((m) => m.id).join(', ')}`);
    installResult = await installCandidate(ctx, candidate, { cwd: projA });
    log(`installer exit ${installResult.code}`);
  }
  const installOk = Boolean(installResult && installResult.code === 0);
  for (const st of clientStates) {
    const m = st.manifest;
    if (!st.runnable) { cells.push(...blockedCells(['Clean install'], 'install', m, st.blockedReason)); continue; }
    if (typeof m.afterInstall === 'function') await m.afterInstall(ctx, { projects: [projA, projB, projC] });
    const insp = await inspectInstall(ctx, candidate, m.id);
    st.configShape = configShapeSnapshot(ctx, m);
    const missing = Object.entries(st.configShape).filter(([, v]) => v === 'ABSENT').map(([k]) => k);
    cells.push(cell({
      row: 'Clean install', scenario: 'install', client: m,
      expected: 'installer exits 0; the product adapter reports the client installed and fresh; every declared config surface exists',
      evidence: ['evidence/_install/install-global.stdout.txt', 'evidence/_install/install-global.stderr.txt'],
      notes: `adapter inspect: ${JSON.stringify(insp).slice(0, 500)}`,
      checks: [
        check('installer exited 0', installOk, installResult ? `exit=${installResult.code}` : 'not run'),
        check('adapter reports client installed', insp.installed === true, `installed=${insp.installed}`),
        check('adapter reports install fresh (hooks/plugins/shim canonical)', insp.fresh === true || insp.fresh === null, `fresh=${insp.fresh}`),
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
      for (const m of active) cells.push(cell({ row: 'Upgrade and self-repair', scenario: 's09-upgrade-continuity', client: m, checks: [check('upgrade prelude completed without harness error', false, (e.stack || String(e)).slice(0, 800))] }));
    }
  }
  for (const sc of scenarios) {
    if (sc.kind === 'pair') {
      if (active.length < 2) {
        for (const m of active) cells.push(...blockedCells(['Cross-client recall'], sc.id, m, 'fewer than two runnable clients in this run'));
      } else {
        for (const writer of active) {
          for (const reader of active) {
            if (writer.id === reader.id) continue;
            await runScenario(sc, { ctx, api, writer, reader, project: projA, candidate }, cells, reader);
          }
        }
      }
      for (const st of inactive) cells.push(...blockedCells(sc.rows, sc.id, st.manifest, st.blockedReason));
    } else {
      for (const st of clientStates) {
        if (!st.runnable) { cells.push(...blockedCells(sc.rows, sc.id, st.manifest, st.blockedReason)); continue; }
        await runScenario(sc, { ctx, api, client: st.manifest, project: projA, candidate }, cells, st.manifest);
      }
    }
    ctx.writeJson(path.join(ctx.dirs.run, 'results.partial.json'), { cells });
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
    const successfulCall = turns.some((t) => (t.toolCalls || []).some((c) => isMidbrainTool(c) && c.ok !== false && c.result));
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

  if (ctx.registry) { await ctx.registry.stop(); log('loopback registry stopped'); }
  const after = snapshot();
  const drift = diff(before, after);
  ctx.writeJson(path.join(ctx.dirs.run, 'isolation.json'), { before: before.takenAt, after: after.takenAt, drift });

  const results = {
    harnessVersion: HARNESS_VERSION,
    run: {
      runId: ctx.runId, marker: ctx.marker, platform: ctx.platform, arch: ctx.arch, osRelease: ctx.osRelease, node: ctx.node,
      startedAt: ctx.startedAt, finishedAt: new Date().toISOString(),
      readbackTimeoutMs: ctx.options.readbackTimeoutMs, indexGraceMs: ctx.options.indexGraceMs,
      apiBase: apiBaseUrl(), runDir: ctx.dirs.run, cacheSpool: cacheSpoolCounts(ctx),
      models: { claude: process.env.MIDBRAIN_HARNESS_CLAUDE_MODEL || 'client default', codex: process.env.MIDBRAIN_HARNESS_CODEX_MODEL || 'client default' },
    },
    candidate,
    clients: clientStates.map(({ manifest: _m, ...rest }) => rest),
    cells,
    isolation: { ok: drift.length === 0, drift },
  };
  ctx.writeJson(path.join(ctx.dirs.run, 'results.json'), results);
  writeFileSync(path.join(ctx.dirs.run, 'report.md'), renderMarkdown(results));
  if (existsSync(path.join(ctx.dirs.run, 'results.partial.json'))) rmSync(path.join(ctx.dirs.run, 'results.partial.json'));

  const counts = {};
  for (const c of cells) counts[c.status] = (counts[c.status] || 0) + 1;
  log(`done: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')} · isolation ${drift.length ? `DRIFT(${drift.length})` : 'ok'}`);
  log(`report: ${path.join(ctx.dirs.run, 'report.md')}`);
  console.log(path.join(ctx.dirs.run, 'report.md'));
  process.exitCode = (counts.FAIL || 0) === 0 && drift.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// report / freeze / help
// ---------------------------------------------------------------------------
function report(flags) {
  const dir = flags._[0];
  if (!dir) throw new Error('usage: report <runDir>');
  const results = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
  const out = path.join(dir, 'report.md');
  writeFileSync(out, renderMarkdown(results));
  console.log(out);
}

async function freeze(flags) {
  const c = await freezeCandidate({ mode: flags.mode || 'dev' });
  console.log(JSON.stringify(c, null, 2));
}

function help() {
  console.log(`midbrain multi-client harness v${HARNESS_VERSION}

commands
  doctor   [--clients a,b]          readiness of this machine (clients, secrets, API, run root)
  freeze   [--mode dev]             print the frozen candidate identity (registry mode is prepared inside run)
  run      [--clients a,b] [--scenarios s01,s06] [--mode dev|registry] [--upgrade] [--keep]
           [--readback-timeout-ms N] [--index-grace-ms N] [--root DIR]
  report   <runDir>                 re-render report.md from results.json

clients:   ${ORDER.join(', ')}
scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}

secrets (harness/.env or environment): MIDBRAIN_HARNESS_API_KEY, MIDBRAIN_HARNESS_PROJECT_API_KEY (optional),
  ${[...new Set(Object.values(MANIFESTS).flatMap((m) => m.requiredSecrets))].join(', ')}
`);
}

const { cmd, flags } = parseArgs(process.argv.slice(2));
const commands = { doctor, freeze, run, report, help };
const fn = commands[cmd || 'help'];
if (!fn) { help(); process.exitCode = 2; }
else {
  try { await fn(flags); } catch (e) { log(`error: ${e.message}`); if (process.env.MIDBRAIN_HARNESS_DEBUG) console.error(e.stack); process.exitCode = 1; }
}
