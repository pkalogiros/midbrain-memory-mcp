import { describe, it, expect } from 'vitest';
import { SMOKE_TOOLS } from '../harness/lib/dry-smoke-fixture.mjs';
import { validateDrySmokeFlags, nativeProbe, drySmokeExitCode, smokeEnv } from '../harness/lib/dry-smoke-policy.mjs';
import { createRunContext } from '../harness/lib/context.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyNativeProbe, verifySmokeRequests } from '../harness/lib/dry-smoke.mjs';
import { renderMarkdown } from '../harness/lib/report.mjs';
import { renderRunHtml } from '../harness/lib/report-html.mjs';

describe('dry-smoke boundaries', () => {
  it('rejects model, live API, upgrade and behavioral scenario options instead of ignoring them', () => {
    for (const key of ['model', 'api-url', 'scenarios', 'required', 'upgrade', 'config', 'simple', 'follow-up']) {
      expect(() => validateDrySmokeFlags({ _: [], [key]: 'anything' })).toThrow(/dry-smoke/);
    }
    expect(() => validateDrySmokeFlags({ _: [], clients: 'pi,codex', root: '/tmp/test', 'install-clients': true })).not.toThrow();
  });

  it('never uses a prompt command, and distinguishes Codex config listing from a connection', () => {
    expect(nativeProbe('codex')).toMatchObject({ args: ['app-server', '--stdio'], level: 'discovery' });
    expect(nativeProbe('claude')).toMatchObject({ args: ['mcp', 'list'], level: 'connection' });
    expect(nativeProbe('hermes')).toMatchObject({ args: ['mcp', 'test', 'midbrain-memory'], level: 'discovery' });
    expect(nativeProbe('opencode')).toMatchObject({ args: ['mcp', 'list'], level: 'connection' });
    expect(nativeProbe('nanoclaw')).toBeNull();
  });

  it('never treats blocked or incomplete coverage as a successful gate', () => {
    expect(drySmokeExitCode([{ status: 'PASS' }], true, true)).toBe(0);
    for (const status of ['FAIL', 'BLOCKED', 'SKIP']) expect(drySmokeExitCode([{ status }], true, true)).toBe(1);
    expect(drySmokeExitCode([], true, true)).toBe(1);
    expect(drySmokeExitCode([{ status: 'PASS' }], true, false)).toBe(1);
    expect(drySmokeExitCode([{ status: 'PASS' }], false, true)).toBe(1);
  });

  it('does not confuse another server being connected with MidBrain being connected', () => {
    for (const id of ['claude', 'opencode']) {
      expect(classifyNativeProbe(id, { code: 0, stdout: 'dry-smoke-peer: Connected\nmidbrain-memory: Failed to connect', stderr: '' }).status).toBe('FAIL');
      expect(classifyNativeProbe(id, { code: 0, stdout: 'midbrain-memory: disconnected', stderr: '' }).status).toBe('FAIL');
      expect(classifyNativeProbe(id, { code: 0, stdout: 'midbrain-memory: Connected', stderr: '' }).status).toBe('PASS');
    }
    expect(classifyNativeProbe('codex', { code: 0, stdout: '[{"name":"midbrain-memory","enabled":true}]', stderr: '' }).status).toBe('BLOCKED');
    expect(classifyNativeProbe('hermes', { code: 0, stdout: 'configured', stderr: '' }).status).toBe('BLOCKED');
  });

  it('handles native output formatting without matching server names in command paths', () => {
    expect(classifyNativeProbe('opencode', { code: 0, stdout: '✓ dry-smoke-peer connected\n /repo/midbrain-memory-mcp/peer.mjs\n\\u001b[90m│\\u001b[39m ✓ midbrain-memory connected', stderr: '' }).status).toBe('PASS');
    expect(classifyNativeProbe('opencode', { code: 0, stdout: '✓ peer connected /repo/midbrain-memory-mcp/peer.mjs', stderr: '' }).status).toBe('BLOCKED');
    expect(classifyNativeProbe('pi', { code: 0, stdout: JSON.stringify({ ok: true, detail: 'all tools exposed', tools: SMOKE_TOOLS.map(t => `midbrain_${t}`) }), stderr: 'MCP started' }).status).toBe('PASS');
    expect(classifyNativeProbe('codex', { code: 0, stdout: JSON.stringify({ kind: 'app-server', ok: true, tools: SMOKE_TOOLS }), stderr: '' }).status).toBe('PASS');
  });

  it('fails the HTTP contract if a parameter or credential is wrong, even with a successful MCP answer', () => {
    const requests = [{ method: 'GET', path: '/api/v1/memories/search/semantic', query: { query: 'DRY_SMOKE Ω & exact', limit: '9' }, key: 'global' }];
    expect(verifySmokeRequests(requests)[0].ok).toBe(true);
    expect(verifySmokeRequests([{ ...requests[0], key: 'user' }])[0].ok).toBe(false);
    expect(verifySmokeRequests([{ ...requests[0], query: { ...requests[0].query, limit: '3' } }])[0].ok).toBe(false);
  });

  it('preserves dry-smoke scope and strict blocked status in both existing report renderers', () => {
    const report = { run: { kind: 'dry-smoke', complete: true, runId: 'test', models: {}, finishedAt: 'now' }, candidate: {}, clients: [{ id: 'codex', displayName: 'Codex' }],
      cells: [{ client: 'codex', row: 'Native client discovery', status: 'BLOCKED', checks: [], notes: 'Configuration only' }], isolation: { ok: true, drift: [] } };
    for (const text of [renderMarkdown(report), renderRunHtml(report)]) {
      expect(text).toContain('BLOCKED');
      expect(text).toContain('zero model prompts');
      expect(text).toContain('Configuration only');
      expect(text).toContain('nonzero');
      expect(text).not.toContain('BLOCKED means incomplete coverage and does not itself fail');
    }
  });

  it('drops provider credentials and explicitly disables optional PK calls', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-smoke-policy-'));
    const old = process.env.ANTHROPIC_API_KEY;
    const pk = process.env.MIDBRAIN_HARNESS_PK;
    try {
      process.env.ANTHROPIC_API_KEY = 'must-not-inherit'; process.env.MIDBRAIN_HARNESS_PK = '1';
      const ctx = createRunContext({ root });
      const env = smokeEnv(ctx);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.MIDBRAIN_ENABLE_PK_INJECTION).toBeUndefined();
      expect(env.HOME).toBe(ctx.dirs.home);
      expect(env.MIDBRAIN_TEST_SANDBOX).toBe(ctx.dirs.home);
    } finally {
      if (old === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old;
      if (pk === undefined) delete process.env.MIDBRAIN_HARNESS_PK; else process.env.MIDBRAIN_HARNESS_PK = pk;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dry-smoke real stdio probe', () => {
  it('exercises every source MCP tool against a recorded local API and fails broken startup', async () => {
    const { startSmokeApi, SMOKE_KEYS } = await import('../harness/lib/dry-smoke-fixture.mjs');
    const { writeGlobalKey, writeGlobalHostConfig } = await import('../harness/lib/home.mjs');
    const { spawnCapture } = await import('../harness/lib/proc.mjs');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-smoke-probe-'));
    let api;
    try {
      const faultFile = path.join(root, 'fixture-faults.json');
      api = await startSmokeApi({ faultFile });
      const ctx = createRunContext({ root });
      writeGlobalKey(ctx, SMOKE_KEYS.global); writeGlobalHostConfig(ctx, api.url);
      fs.writeFileSync(path.join(ctx.dirs.tmp, '.midbrain-update-check.json'), JSON.stringify({ lastCheck: Date.now() }));
      const project = ctx.projectDir('smoke');
      const input = path.join(ctx.dirs.run, 'probe.json');
      const entry = { command: process.execPath, args: [path.resolve('index.js')], env: { MIDBRAIN_DEV: '1', MIDBRAIN_CLIENT: 'generic' } };
      const tracePath = path.join(ctx.dirs.run, 'mcp-events.ndjson');
      ctx.writeJson(input, { entry, project, apiUrl: api.url, tracePath, faultFile });
      const run = () => spawnCapture(process.execPath, [path.resolve('harness/lib/dry-smoke-probe.mjs'), input], { cwd: project, env: smokeEnv(ctx, { MIDBRAIN_PROJECT_DIR: project }), timeoutMs: 25000 });
      const result = await run();
      expect(result.timedOut).toBe(false);
      expect(result.code, result.stderr).toBe(0);
      const evidence = JSON.parse(result.stdout);
      expect(evidence.checks.filter(c => !c.ok)).toEqual([]);
      for (const name of ['grep', 'get_episodic_memories_by_date', 'list_files', 'read_file', 'check_session_status', 'list_agents']) {
        expect(evidence.checks.find(c => c.id === `recovery:${name}`)?.ok).toBe(true);
        const calls = evidence.calls.filter(c => c.caseId === `recovery:${name}`);
        expect(calls[0].result.isError).toBe(true);
        expect(calls[1].result.isError).not.toBe(true);
      }
      expect(evidence.checks.find(c => c.id === 'mint-rollback')?.ok).toBe(true);
      expect(api.requests.some(r => r.method === 'DELETE' && r.path.endsWith('/dry-mint-failure'))).toBe(true);
      expect(new Set(evidence.calls.map(c => c.name)).size).toBe(12);
      expect(evidence.discoveries).toHaveLength(2);
      expect(evidence.protocolAudit).toMatchObject({ schemaVersion: 1, protocolVersion: expect.any(String), capabilities: { tools: expect.any(Object) }, recovered: true });
      expect(evidence.protocolAudit.exchanges.map(e => e.method)).toEqual(['ping', 'tools/list', 'dry-smoke/unsupported', 'tools/call', 'tools/call', 'tools/call', 'ping', 'tools/list']);
      expect(evidence.protocolAudit.exchanges[2].error.code).toBe(-32601);
      expect(evidence.protocolAudit.exchanges[3].result.isError).toBe(true);
      expect(evidence.checks.find(c => c.id === 'protocol').detail).toContain('not full protocol conformance');
      expect(evidence.discoveries[0].tools.every(t => t.description && t.inputSchema)).toBe(true);
      const trace = fs.readFileSync(tracePath, 'utf8');
      expect(trace).not.toContain(SMOKE_KEYS.user);
      const { parseSmokeTrace } = await import('../harness/lib/dry-smoke-trace.mjs');
      expect(parseSmokeTrace(trace).issues).toEqual([]);
      const protocolEvents = fs.readFileSync(path.join(ctx.dirs.run, 'protocol-events.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(protocolEvents.filter(e => e.type === 'protocol.started')).toHaveLength(8);
      expect(protocolEvents.filter(e => e.type === 'protocol.finished')).toHaveLength(8);
      const events = trace.trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(e => e.type === 'call.started')).toHaveLength(evidence.calls.length);
      expect(events.filter(e => e.type === 'call.finished')).toHaveLength(evidence.calls.length);
      expect(verifySmokeRequests(api.requests).filter(c => !c.ok)).toEqual([]);
      expect(api.unexpected).toEqual([]);
      // A server can return valid tool answers while also corrupting stdout.
      const noisyScript = path.join(root, 'noisy-server.mjs');
      const { pathToFileURL } = await import('node:url');
      fs.writeFileSync(noisyScript, `console.log('not JSON-RPC'); const { startMcpServer } = await import(${JSON.stringify(pathToFileURL(path.resolve('index.js')).href)}); await startMcpServer();`);
      fs.rmSync(path.join(project, '.midbrain'), { recursive: true, force: true });
      ctx.writeJson(input, { entry: { ...entry, args: [noisyScript] }, project, apiUrl: api.url, faultFile });
      const noisy = JSON.parse((await run()).stdout);
      expect(noisy.checks.find(c => c.id === 'protocol')?.ok).toBe(false);
      expect(noisy.calls.some(c => c.name === 'memory_search' && !c.result.isError)).toBe(true);
      ctx.writeJson(input, { entry: { ...entry, args: [path.join(root, 'missing-server.mjs')] }, project, apiUrl: api.url, faultFile });
      const broken = JSON.parse((await run()).stdout);
      const { validateProbeEvidence } = await import('../harness/lib/dry-smoke-cases.mjs');
      expect(validateProbeEvidence(broken).ok).toBe(false);
      expect(broken.error).toBeTruthy();
    } finally { if (api) await api.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 40000);
});

describe('dry-smoke evidence integrity', () => {
  it('rejects missing, duplicated, unknown and nonboolean probe results', async () => {
    const { SMOKE_CASES, validateProbeEvidence, probeChecksForRow } = await import('../harness/lib/dry-smoke-cases.mjs');
    const receipt = { schemaVersion: 2, checks: SMOKE_CASES.map(c => ({ id: c.id, ok: true })) };
    expect(validateProbeEvidence(receipt).ok).toBe(true);
    for (const corrupt of [
      {}, { ...receipt, checks: receipt.checks.slice(1) },
      { ...receipt, checks: [...receipt.checks, receipt.checks[0]] },
      { ...receipt, checks: [...receipt.checks, { id: 'made-up', ok: true }] },
      { ...receipt, checks: receipt.checks.map(c => ({ ...c, ok: 'true' })) },
    ]) expect(validateProbeEvidence(corrupt).ok).toBe(false);
    expect(probeChecksForRow({}, 'Configured MCP transport').every(c => c.ok === false)).toBe(true);
  });

  it('requires every selected client and coverage row before passing the gate', async () => {
    const { DRY_SMOKE_ROWS } = await import('../harness/lib/dry-smoke-policy.mjs');
    const complete = DRY_SMOKE_ROWS.map(row => ({ row, client: 'codex', status: 'PASS', checks: [{ ok: true }] }));
    expect(drySmokeExitCode(complete, true, true, ['codex'])).toBe(0);
    expect(drySmokeExitCode(complete.slice(1), true, true, ['codex'])).toBe(1);
    expect(drySmokeExitCode(complete, true, true, ['codex', 'claude'])).toBe(1);
    expect(drySmokeExitCode(complete.map(c => ({ ...c, checks: [] })), true, true, ['codex'])).toBe(1);
    expect(drySmokeExitCode(complete.map(c => ({ ...c, checks: [{ ok: false }] })), true, true, ['codex'])).toBe(1);
  });
});


describe('dry-smoke review artifacts', () => {
  it('does not accept a native success claim without a complete inventory', () => {
    for (const id of ['pi', 'codex']) {
      const result = { code: 0, stdout: JSON.stringify({ kind: 'app-server', ok: true, tools: ['memory_search'] }), stderr: '' };
      expect(classifyNativeProbe(id, result).status).toBe('FAIL');
    }
  });

  it('exports honest counts, escaped evidence and a failing JUnit gate for missing coverage', async () => {
    const { renderDrySmokeJUnit, renderDrySmokeHtml, smokeReportSummary } = await import('../harness/lib/dry-smoke-report.mjs');
    const report = { run: { kind: 'dry-smoke', complete: true, promptCount: 0 }, candidate: {}, clients: [{ id: 'codex', displayName: 'Codex' }], isolation: { ok: true },
      cells: [{ client: 'codex', row: 'MCP tool contracts', status: 'PASS', checks: [{ name: '<unsafe & assertion>', ok: true }], evidence: ['javascript:alert(1)', 'evidence/../private.txt', 'evidence/codex/mcp.json'] }] };
    expect(smokeReportSummary(report)).toMatchObject({ outcome: 'BLOCKED', passed: 1, assertions: 1 });
    const html = renderDrySmokeHtml(report);
    expect(html).toContain('Assertions passed');
    expect(html).toContain('href="evidence/codex/mcp.json"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="evidence/../');
    expect(html).not.toContain('<unsafe & assertion>');
    const xml = renderDrySmokeJUnit(report);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('&lt;unsafe &amp; assertion&gt;');
    expect(xml).toContain('Run outcome: BLOCKED');
  });
});
