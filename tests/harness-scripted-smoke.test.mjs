import { describe, it, expect } from 'vitest';
import { startScriptedProvider, scriptedPlan, scoreScripted, validateScriptedFlags, scriptedOutcome, SCRIPTED_ROWS, scriptedCheckInventory } from '../harness/lib/scripted-smoke-policy.mjs';
import { TOOL_CONTRACTS } from '../harness/lib/tool-contracts.mjs';
import { renderScriptedHtml, renderScriptedMarkdown, renderScriptedJUnit } from '../harness/lib/scripted-smoke-report.mjs';

const catalog = TOOL_CONTRACTS.map(t => ({ type: 'function', function: { name: `midbrain_${t.name}`, parameters: { type: 'object', properties: t.properties, required: t.required } } }));
const post = (server, body) => fetch(`${server.url}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mcp-script', tools: catalog, messages: [], ...body }) });

describe('scripted native provider', () => {
  it('records and caps Claude startup probes without consuming a completion', async () => {
    const server = await startScriptedProvider([], () => {}, 'claude');
    try {
      for (let i = 0; i < 4; i++) expect((await fetch(`${server.url.replace(/\/v1$/, '')}/api/hello`, { method: 'HEAD' })).status).toBe(200);
      expect(server.requests).toHaveLength(0); expect(server.complete).toBe(false);
      expect((await fetch(`${server.url.replace(/\/v1$/, '')}/api/hello`, { method: 'HEAD' })).status).toBe(400);
      expect(server.issues).toHaveLength(1);
    } finally { await server.close(); }
  });
  it('plans every tool and a bounded error/recovery pair without model credentials', () => {
    const plan = scriptedPlan('/throwaway/project');
    expect(new Set(plan.map(s => s.name))).toEqual(new Set(TOOL_CONTRACTS.map(s => s.name)));
    expect(plan).toHaveLength(14);
    expect(() => validateScriptedFlags({ clients: 'unknown' })).toThrow(/client/i);
    expect(() => validateScriptedFlags({ model: 'paid' })).toThrow(/model/);
  });
  it('requires exact tool result correlation and content before advancing', async () => {
    const server = await startScriptedProvider([{ name: 'list_files', args: {}, contains: 'guide.md' }]);
    try {
      const response = await post(server, {}); expect(response.status).toBe(200);
      const call = (await response.json()).choices[0].message.tool_calls[0];
      expect(call.function.name).toBe('midbrain_list_files');
      const next = await post(server, { messages: [{ role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'guide.md' }] });
      expect((await next.json()).choices[0].message.content).toBe('SCRIPTED_MCP_COMPLETE');
      expect(server.complete).toBe(true);
      expect(server.receipts).toHaveLength(1);
    } finally { await server.close(); }
  });
  it.each(['wrong-id', 'missing-result', 'wrong-content', 'missing-catalog'])('fails closed on %s', async fault => {
    const server = await startScriptedProvider([{ name: 'list_files', args: {}, contains: 'guide.md' }]);
    try {
      const call = (await (await post(server, {})).json()).choices[0].message.tool_calls[0];
      const response = await post(server, { tools: fault === 'missing-catalog' ? [] : catalog, messages: fault === 'missing-result' ? [] : [{ role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: fault === 'wrong-id' ? 'wrong' : call.id, content: fault === 'wrong-content' ? 'fabricated' : 'guide.md' }] });
      expect(response.status).toBe(400); expect(server.complete).toBe(false); expect(server.issues).toHaveLength(1);
    } finally { await server.close(); }
  });
  it('counts and records malformed requests and retries after failure', async () => {
    const events = [];
    const server = await startScriptedProvider([], event => events.push(event));
    try {
      const bad = await fetch(`${server.url}/chat/completions`, { method: 'POST', body: '{invalid' });
      expect(bad.status).toBe(400);
      expect((await post(server, {})).status).toBe(400);
      expect(server.attempts).toHaveLength(2);
      expect(server.requests).toHaveLength(0);
      expect(server.attempts.every(a => a.status === 'rejected' && a.error)).toBe(true);
      expect(events.filter(e => e.type === 'provider.attempt').map(e => e.attempt.index)).toEqual([1, 2]);
      expect(events.filter(e => e.type === 'provider.issue').map(e => e.attemptIndex)).toEqual([1, 2]);
    } finally { await server.close(); }
  });
  it('records excess attempts after successful completion without advancing the script', async () => {
    const server = await startScriptedProvider([]);
    try {
      expect((await post(server, {})).status).toBe(200);
      expect((await post(server, {})).status).toBe(400);
      expect(server.attempts.map(a => a.status)).toEqual(['accepted', 'rejected']);
      expect(server.requests).toHaveLength(1);
      expect(server.issues).toHaveLength(1);
    } finally { await server.close(); }
  });
  it('streams tool calls and final text as OpenAI-compatible SSE', async () => {
    const server = await startScriptedProvider([{ name: 'list_files', args: {}, contains: 'guide.md' }]);
    try {
      const response = await post(server, { stream: true }); const text = await response.text();
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('midbrain_list_files'); expect(text).toContain('data: [DONE]');
    } finally { await server.close(); }
  });
  it('does not accept a final answer without independent native, MCP and HTTP evidence', () => {
    const checks = scoreScripted({ plan: scriptedPlan('/project'), provider: { complete: true, issues: [], receipts: [] }, trace: { calls: [], issues: [] }, turn: { exitCode: 0, finalText: 'SCRIPTED_MCP_COMPLETE', toolCalls: [] }, requests: [], unexpected: [] });
    expect(checks.some(c => !c.ok)).toBe(true);
  });
  it('records request attempts incrementally, including a rejected envelope', async () => {
    const events = [];
    const server = await startScriptedProvider([{ name: 'list_files', args: {}, contains: 'guide.md' }], event => events.push(event));
    try {
      await post(server, { tools: [] });
      expect(events.map(e => e.type)).toEqual(['provider.attempt', 'provider.request', 'provider.issue']);
      expect(events[1].request.body.tools).toEqual([]);
    } finally { await server.close(); }
  });
});

function evidence() {
  const plan = scriptedPlan('/project');
  const calls = plan.map((step, i) => ({ name: step.name, args: step.args, result: { ...(i === 12 ? { isError: true } : {}), content: [{ type: 'text', text: step.contains }] }, status: 'returned', connection: 42, startedAt: new Date(i * 10).toISOString(), completedAt: new Date(i * 10 + 5).toISOString() }));
  const http = (method, path, query = {}, body = null, key = 'global', status = 200) => ({ method, path: `/api/v1${path}`, query, body, key, status });
  return { plan, trace: { calls, issues: [], discoveries: [{ connection: 42, tools: TOOL_CONTRACTS.map(t => ({ name: t.name, inputSchema: { type: 'object', properties: t.properties, required: t.required } })) }] }, turn: { exitCode: 0, finalText: 'SCRIPTED_MCP_COMPLETE', toolCalls: calls.map((c, i) => ({ id: `script-call-${i + 1}`, name: `midbrain_${c.name}`, input: c.args, result: c.result, ok: i !== 12 })) }, provider: { complete: true, issues: [], receipts: calls.map((c, i) => ({ id: `script-call-${i + 1}`, content: c.result.content[0].text })) }, unexpected: [], requests: [
    http('GET', '/memories/search/semantic', { query: 'DRY_SMOKE_SCRIPTED', limit: '9' }),
    http('GET', '/memories/search/lexical', { pattern: 'fixture.*', limit: '2' }),
    http('GET', '/memories/episodic', { start_date: '2026-01-01T00:00:00.000Z', end_date: '2026-01-03T00:00:00.000Z' }),
    http('GET', '/memories/semantic/files'), http('GET', '/memories/semantic/files/guide.md', { start_line: '2', num_lines: '1' }),
    http('GET', '/account/agents', {}, null, 'user'), http('POST', '/account/agents', {}, { name: 'Dry smoke agent' }, 'user'), http('POST', '/account/keys', {}, { agent_id: 'dry-agent' }, 'user'),
    http('GET', '/memories/search/semantic', { query: 'DRY_SMOKE_UNAVAILABLE' }, null, 'global', 503), http('GET', '/memories/search/semantic', { query: 'DRY_SMOKE_SCRIPTED_RECOVERED' }),
  ] };
}

describe('scripted evidence gate', () => {
  it('accepts agreeing evidence at every boundary', () => expect(scoreScripted(evidence()).every(c => c.ok)).toBe(true));
  it.each([
    ['native arguments', e => { e.turn.toolCalls[0].input = { query: 'wrong' }; }],
    ['native tool name', e => { e.turn.toolCalls[0].name = 'other_memory_search'; }],
    ['provider correlation', e => { e.provider.receipts[0].id = 'wrong'; }],
    ['provider content', e => { e.provider.receipts[0].content = 'invented'; }],
    ['MCP result', e => { e.trace.calls[0].result = { content: [{ type: 'text', text: 'wrong' }] }; }],
    ['MCP schema drift', e => { e.trace.discoveries[0].tools = []; }],
    ['MCP trace integrity', e => { e.trace.issues.push('orphan event'); }],
    ['missing error envelope', e => { delete e.trace.calls[12].result.isError; }],
    ['native success for failed MCP call', e => { e.turn.toolCalls[12].ok = true; }],
    ['positive error envelope', e => { e.trace.calls[0].result.isError = true; }],
    ['HTTP receipt', e => { e.requests.shift(); }],
    ['native timeout', e => { e.turn.timedOut = true; }],
    ['recovery connection', e => { e.trace.calls[13].connection = 43; }],
    ['recovery order', e => { e.trace.calls[13].startedAt = e.trace.calls[12].startedAt; }],
  ])('rejects damaged %s evidence', (_label, mutate) => { const e = evidence(); mutate(e); expect(scoreScripted(e).some(c => !c.ok)).toBe(true); });
  it('renders honest reports and fails missing coverage and host drift', () => {
    const report = { run: { kind: 'scripted-smoke', runId: '<script>', complete: true, platform: 'darwin', arch: 'arm64' }, candidate: {}, clients: [{ id: 'pi' }], cells: SCRIPTED_ROWS.map(row => ({ row, client: 'pi', status: 'PASS', checks: [{ name: 'check', ok: true }] })), isolation: { ok: true }, scriptedEvidence: evidence() };
    report.scriptedEvidence.provider.requests = [{ index: 1, receivedAt: 'now', body: null }];
    report.scriptedEvidence.provider.attempts = [{ index: 1, status: 'rejected', error: 'Invalid envelope' }];
    expect(scriptedOutcome(report)).toBe('PASS');
    expect(renderScriptedHtml(report)).toContain('&lt;script&gt;');
    expect(renderScriptedMarkdown(report)).toContain('Zero LLM inference');
    expect(renderScriptedJUnit(report)).toContain('failures="0"');
    report.cells.pop(); expect(scriptedOutcome(report)).toBe('BLOCKED');
    report.isolation.ok = false; expect(scriptedOutcome(report)).toBe('FAIL');
  });
  it.each([1, 2])('requires every uniquely identified assertion in version %s reports', version => {
    const inventory = scriptedCheckInventory('pi', version);
    const report = { assertionSchemaVersion: version, run: { complete: true }, isolation: { ok: true }, clients: [{ id: 'pi' }], cells: SCRIPTED_ROWS.map(row => ({ row, client: 'pi', status: 'PASS', checks: inventory.filter(c => c.row === row).map(c => ({ ...c, ok: true })) })) };
    expect(scriptedOutcome(report)).toBe('PASS');
    for (const corrupt of [
      r => r.cells[0].checks.pop(),
      r => r.cells[0].checks.push(r.cells[0].checks[0]),
      r => { r.cells[0].checks[0].id = 'invented'; },
      r => { r.cells[0].checks[0].ok = 'true'; },
      r => r.cells.push(r.cells[0]),
      r => { r.assertionSchemaVersion = 99; },
    ]) { const r = globalThis.structuredClone(report); corrupt(r); expect(scriptedOutcome(r)).not.toBe('PASS'); }
  });
  it('requires independent peer receipts and rejects cross-server routing', () => {
    const make = () => {
      const e = evidence(); e.client = 'opencode'; e.plan = scriptedPlan('/project', 'opencode');
      e.turn.toolCalls.forEach(c => { c.name = c.name.replace('midbrain_', 'midbrain-memory_'); c.result = c.result.content[0].text; });
      const args = { query: 'SCRIPTED_PEER_ONLY' }; const result = { content: [{ type: 'text', text: 'SCRIPTED_PEER_RESPONSE' }] };
      e.trace.calls.push({ name: 'memory_search', args, result, status: 'returned', connection: 99 });
      e.turn.toolCalls.push({ id: 'script-call-15', name: 'scripted-peer_memory_search', input: args, result: 'SCRIPTED_PEER_RESPONSE', ok: true });
      e.provider.receipts.push({ id: 'script-call-15', content: 'SCRIPTED_PEER_RESPONSE' });
      e.peerRequests = [{ args, result }]; return e;
    };
    expect(scoreScripted(make()).every(c => c.ok)).toBe(true);
    for (const damage of [e => { e.peerRequests = []; }, e => { e.trace.calls[14].connection = 42; }, e => { e.turn.toolCalls[14].name = 'midbrain-memory_memory_search'; }, e => { e.requests.push({ query: 'SCRIPTED_PEER_ONLY' }); }]) {
      const e = make(); damage(e); expect(scoreScripted(e).some(c => !c.ok)).toBe(true);
    }
  });
});
