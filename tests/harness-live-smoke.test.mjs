import { describe, it, expect } from 'vitest';
import { buildLivePlan, liveSmokeOutcome, scoreLiveScenario, liveOpenCodeConfig } from '../harness/lib/live-smoke-policy.mjs';
import { startLiveSmokeApi } from '../harness/lib/live-smoke-fixture.mjs';
import { redactLive } from '../harness/lib/live-smoke-evidence.mjs';
import { renderLiveSmokeHtml, renderLiveSmokeMarkdown, renderLiveSmokeJUnit } from '../harness/lib/live-smoke-report.mjs';

describe('live-smoke policy', () => {
  it('pins every OpenCode model choice while preserving the installed MCP and plugin', () => {
    const installed = { mcp: { 'midbrain-memory': { command: ['node', 'index.js'] } }, plugin: ['capture'], model: 'other/default' };
    const config = liveOpenCodeConfig(installed, 'openai/gpt-6-luna');
    expect(config.mcp).toEqual(installed.mcp);
    expect(config.plugin).toEqual(installed.plugin);
    expect(config.model).toBe('openai/gpt-6-luna');
    expect(config.small_model).toBe(config.model);
    expect(config.enabled_providers).toEqual(['openai']);
    expect(config.agent.title.disable).toBe(true);
    expect(config.agent.summary.disable).toBe(true);
    expect(config.compaction.auto).toBe(false);
    expect(installed.model).toBe('other/default');
  });
  it('requires explicit model selection and defaults to a zero-prompt plan', () => {
    const plan = buildLivePlan({ _: [] }, { models: { claude: 'test-model' } });
    expect(plan.execute).toBe(false);
    expect(plan.scenarios).toBe(2);
    expect(plan.models.claude).toBe('test-model');
    expect(() => buildLivePlan({ execute: 'false' }, { models: { claude: 'm' } })).toThrow();
    expect(() => buildLivePlan({ clients: 'claude,codex' }, { models: { claude: 'm' } })).toThrow(/codex/);
    expect(() => buildLivePlan({}, { models: { claude: 'latest' } })).toThrow();
    expect(() => buildLivePlan({ 'api-url': 'https://example.com' }, { models: { claude: 'm' } })).toThrow();
    expect(() => buildLivePlan({}, { models: { claude: 'm' }, timeoutMs: 9999999 })).toThrow();
  });

  const scenario = { id: 'round-trip', query: 'opaque-query', value: 'fresh-private-value' };
  const receipt = () => ({
    turn: { exitCode: 0, isError: false, timedOut: false, finalText: scenario.value, toolCalls: [
      { id: 'native-1', name: 'mcp__midbrain-memory__memory_search', input: { query: scenario.query, memory_type: 'semantic', limit: 1 }, result: scenario.value, ok: true },
    ] },
    trace: { issues: [], discoveries: [{ tools: [{ name: 'memory_search', inputSchema: { type: 'object' } }] }], calls: [
      { id: 'wire-1', name: 'memory_search', args: { query: scenario.query, memory_type: 'semantic', limit: 1 }, status: 'returned', result: { content: [{ type: 'text', text: scenario.value }] } },
    ] },
    requests: [{ query: scenario.query, limit: '3', memory_type: null, status: 200, value: scenario.value, key: 'fixture', method: 'GET', path: '/api/v1/memories/search/semantic' }],
  });
  const passes = r => scoreLiveScenario(scenario, r).every(c => c.ok);
  it('requires native, MCP wire, backend and answer evidence to agree', () => {
    expect(passes(receipt())).toBe(true);
    for (const mutate of [r => r.turn.toolCalls = [], r => r.trace.calls = [], r => r.requests = [], r => r.turn.finalText = 'I called it', r => r.trace.issues.push('damaged log'), r => r.turn.toolCalls[0].name = 'unrelated_memory_search', r => r.turn.toolCalls[0].input.limit = 9, r => r.requests[0].status = 401, r => r.turn.timedOut = true]) {
      const r = receipt(); mutate(r); expect(passes(r)).toBe(false);
    }
  });
  it('rejects shell substitutes, duplicate evidence and incomplete MCP results', () => {
    const r = receipt();
    r.turn.toolCalls.push({ id: 'shell', name: 'Bash', input: { command: 'curl localhost' }, result: scenario.value, ok: true });
    expect(passes(r)).toBe(false);
    const duplicate = receipt(); duplicate.trace.calls.push(duplicate.trace.calls[0]);
    expect(passes(duplicate)).toBe(false);
    const pending = receipt(); pending.trace.calls[0].status = 'pending';
    expect(passes(pending)).toBe(false);
  });
  it('requires an observed error followed by success for recovery', () => {
    const s = { ...scenario, id: 'recovery', errorQuery: 'error-query', errorValue: 'fresh-error-value' };
    const r = receipt();
    expect(scoreLiveScenario(s, r).every(c => c.ok)).toBe(false);
    const input = { query: s.errorQuery, memory_type: 'semantic', limit: 1 };
    r.turn.toolCalls.unshift({ id: 'native-error', name: 'mcp__midbrain-memory__memory_search', input, result: `Memory search failed: ${s.errorValue}`, ok: true });
    r.trace.calls.unshift({ id: 'wire-error', name: 'memory_search', args: input, status: 'tool-error', result: { isError: true, content: [{ type: 'text', text: s.errorValue }] } });
    Object.assign(r.trace.calls[0], { startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' });
    Object.assign(r.trace.calls[1], { startedAt: '2026-01-01T00:00:02Z', completedAt: '2026-01-01T00:00:03Z' });
    r.requests.unshift({ ...r.requests[0], query: s.errorQuery, status: 503, value: s.errorValue });
    expect(scoreLiveScenario(s, r).every(c => c.ok)).toBe(true);
    delete r.trace.calls[0].result.isError;
    expect(scoreLiveScenario(s, r).every(c => c.ok)).toBe(false);
    r.trace.calls[0].result.isError = true;
    r.trace.calls[1].startedAt = '2026-01-01T00:00:00Z';
    expect(scoreLiveScenario(s, r).every(c => c.ok)).toBe(false);
    r.trace.calls[1].startedAt = '2026-01-01T00:00:02Z';
    r.trace.calls.reverse();
    expect(scoreLiveScenario(s, r).every(c => c.ok)).toBe(false);
  });
  it('never passes a partial, blocked or fabricated green matrix', () => {
    const report = { run: { complete: true }, isolation: { ok: true }, clients: [{ id: 'claude' }], cells: ['Installation', 'Call and consume', 'Error and recovery'].map(row => ({ client: 'claude', row, status: 'PASS', checks: [{ ok: true }] })) };
    expect(liveSmokeOutcome(report)).toBe('PASS');
    report.cells.pop(); expect(liveSmokeOutcome(report)).not.toBe('PASS');
    report.run.complete = false; expect(liveSmokeOutcome(report)).toBe('INCOMPLETE');
  });
});

describe('live-smoke presentation and privacy', () => {
  it('escapes native output, labels missing costs honestly and makes blocked gates fail', () => {
    const report = { run: { kind: 'live-smoke', complete: true, promptAttempts: 1, plan: { scenarios: 2 }, models: { claude: 'test-model' } }, clients: [{ id: 'claude', displayName: 'Claude' }], candidate: {}, isolation: { ok: true },
      cells: [{ client: 'claude', row: 'Call and consume', status: 'FAIL', checks: [{ name: 'Evidence missing', ok: false }] }],
      liveScenarios: [{ client: 'claude', status: 'FAIL', row: 'Call and consume', prompt: 'test', evidence: 'evidence/receipt.json', turn: { finalText: '<script>bad()</script>', toolCalls: [] } }] };
    const html = renderLiveSmokeHtml(report);
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('Unreported');
    expect(html).toContain('Native sessions are not provider request counts');
    expect(html).toContain('id="live-search"');
    expect(html).toContain('id="session-1"');
    expect(renderLiveSmokeMarkdown(report)).toContain('Evidence missing');
    expect(renderLiveSmokeJUnit(report)).toContain('failures="2"');
  });
  it('redacts provider and fixture credentials in raw and encoded representations', () => {
    const secret = 'test/provider+key';
    const result = redactLive({ raw: secret, encoded: encodeURIComponent(secret), answer: 'VERIFIED_abc' }, [secret]);
    expect(result).not.toContain(secret);
    expect(result).not.toContain(encodeURIComponent(secret));
    expect(result).toContain('VERIFIED_abc');
  });
});

describe('live fixture', () => {
  it('keeps unpredictable values out of prompts, records failures and never stores memory', async () => {
    const api = await startLiveSmokeApi();
    try {
      const scenario = api.activate('recovery');
      expect(scenario.prompt).not.toContain(scenario.value);
      expect(scenario.prompt).not.toContain(scenario.errorValue);
      const get = query => fetch(`${api.url}/api/v1/memories/search/semantic?query=${query}&memory_type=semantic&limit=1`, { headers: { authorization: `Bearer ${api.key}` } });
      expect((await get(scenario.errorQuery)).status).toBe(503);
      expect(await (await get(scenario.query)).text()).toContain(scenario.value);
      expect(api.requests).toHaveLength(2);
      expect((await get('unplanned')).status).toBe(400);
      expect(api.unexpected).toHaveLength(1);
      expect((await fetch(`${api.url}/api/v1/memories`, { method: 'POST' })).status).toBe(401);
    } finally { await api.close(); }
  });
});
