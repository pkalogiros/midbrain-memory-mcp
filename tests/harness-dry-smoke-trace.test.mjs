import { describe, it, expect } from 'vitest';
import { createSmokeRecorder } from '../harness/lib/dry-smoke-trace.mjs';

describe('dry-smoke attempt logging', () => {
  it('records invocation order even when concurrent results return out of order', async () => {
    const recorder = createSmokeRecorder();
    let finishFirst;
    const first = recorder.invoke('memory_search', { query: 'first' }, () => new Promise(resolve => { finishFirst = resolve; }), { caseId: 'parallel', connection: 1 });
    const second = recorder.invoke('memory_search', { query: 'second' }, async () => ({ content: [{ type: 'text', text: 'second result' }] }), { caseId: 'parallel', connection: 1 });
    await second;
    expect(recorder.calls.map(c => c.args.query)).toEqual(['first', 'second']);
    expect(recorder.calls.map(c => c.status)).toEqual(['pending', 'returned']);
    finishFirst({ content: [{ type: 'text', text: 'first result' }] }); await first;
    expect(recorder.calls[0]).toMatchObject({ id: 'call-1', caseId: 'parallel', connection: 1, status: 'returned' });
    expect(recorder.calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps rejected attempts with their arguments and error instead of dropping them', async () => {
    const recorder = createSmokeRecorder();
    await expect(recorder.invoke('memory_search', { limit: 0 }, async () => { throw Object.assign(new Error('Invalid input'), { code: -32602 }); })).rejects.toThrow('Invalid input');
    expect(recorder.calls[0]).toMatchObject({ id: 'call-1', name: 'memory_search', args: { limit: 0 }, status: 'rejected', error: { message: 'Invalid input', code: -32602 } });
    expect(recorder.calls[0].result).toBeUndefined();
  });
});

describe('MCP context preview', () => {
  it('recovers pending attempts and discoveries from an interrupted event log', async () => {
    const { replaySmokeTrace, buildSmokeContextPreview } = await import('../harness/lib/dry-smoke-trace.mjs');
    const recording = replaySmokeTrace([
      { type: 'tools.discovered', discovery: { connection: 1, tools: [{ name: 'memory_search' }] } },
      { type: 'call.started', call: { id: 'call-1', name: 'memory_search', args: { query: 'pending' }, status: 'pending' } },
      { type: 'call.started', call: { id: 'call-2', name: 'memory_search', args: { query: 'done' }, status: 'pending' } },
      { type: 'call.finished', call: { id: 'call-2', name: 'memory_search', args: { query: 'done' }, status: 'returned', result: { content: [] } } },
    ]);
    expect(recording.calls.map(c => c.status)).toEqual(['pending', 'returned']);
    expect(buildSmokeContextPreview('codex', recording, { complete: false }).recordingComplete).toBe(false);
  });

  it('preserves observed schemas and calls without inventing a model request, and redacts keys', async () => {
    const { buildSmokeContextPreview, renderSmokeContextMarkdown } = await import('../harness/lib/dry-smoke-trace.mjs');
    const { SMOKE_KEYS } = await import('../harness/lib/dry-smoke-fixture.mjs');
    const preview = buildSmokeContextPreview('pi', {
      kind: 'installed Pi bridge driven by harness',
      discoveries: [{ connection: 1, tools: [{ name: 'memory_search', exposedName: 'midbrain_memory_search', description: 'Exact tool description', inputSchema: { type: 'object' } }] }],
      calls: [{ id: 'call-1', name: 'set_user_api_key', args: { user_api_key: SMOKE_KEYS.user }, status: 'rejected', error: { message: `bad key ${SMOKE_KEYS.user}` } }],
    });
    expect(preview.modelRequest).toEqual({ created: false, sent: false });
    expect(preview.discoveries[0].tools[0].description).toBe('Exact tool description');
    expect(preview.calls[0].error.message).toContain('[synthetic key]');
    expect(JSON.stringify(preview)).not.toContain(SMOKE_KEYS.user);
    const markdown = renderSmokeContextMarkdown(preview);
    expect(markdown).toContain('not a native model request');
    expect(markdown).toContain('midbrain_memory_search');
    expect(markdown).toContain('set_user_api_key');
    expect(markdown).toContain('rejected');
  });
});

describe('trace validation', () => {
  it('retains valid evidence around a damaged log line and marks recording incomplete', async () => {
    const { parseSmokeTrace, buildSmokeContextPreview } = await import('../harness/lib/dry-smoke-trace.mjs');
    const start = { type: 'call.started', call: { id: 'call-1', name: 'memory_search', args: { query: 'test' }, status: 'pending' } };
    const partial = parseSmokeTrace(JSON.stringify(start) + '\n{"type":');
    expect(partial.calls).toHaveLength(1);
    expect(partial.issues).toHaveLength(1);
    expect(buildSmokeContextPreview('codex', partial).recordingComplete).toBe(false);
  });

  it('rejects duplicate IDs, orphaned results and changed arguments', async () => {
    const { replaySmokeTrace } = await import('../harness/lib/dry-smoke-trace.mjs');
    const call = { id: 'call-1', name: 'memory_search', args: { query: 'original' }, status: 'pending' };
    const start = { type: 'call.started', call };
    const finish = { type: 'call.finished', call: { ...call, status: 'returned', result: { content: [] } } };
    expect(replaySmokeTrace([start, finish]).issues).toEqual([]);
    for (const events of [[start, start], [finish], [start, { ...finish, call: { ...finish.call, args: { query: 'changed' } } }], [start, finish, finish]]) {
      expect(replaySmokeTrace(events).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('readable context inspection', () => {
  it('shows scenario verdict separately from a deliberate tool error and retains escaped raw evidence', async () => {
    const { buildSmokeContextPreview, renderSmokeContextMarkdown } = await import('../harness/lib/dry-smoke-trace.mjs');
    const { renderRunHtml } = await import('../harness/lib/report-html.mjs');
    const preview = buildSmokeContextPreview('codex', {
      discoveries: [{ connection: 1, tools: [{ name: 'memory_search', inputSchema: { type: 'object' } }] }],
      checks: [{ id: 'validation', ok: true }],
      calls: [{ id: 'call-1', name: 'memory_search', caseId: 'validation', connection: 1, args: { query: '<script>inert</script>', limit: 0 }, status: 'tool-error', result: { isError: true, content: [{ type: 'text', text: 'Invalid limit <script>inert</script>' }] } }],
    });
    expect(preview.calls[0].scenario).toMatchObject({ id: 'validation', outcome: 'PASS' });
    const html = renderRunHtml({ run: { kind: 'dry-smoke', complete: true }, candidate: {}, clients: [{ id: 'codex', displayName: 'Codex' }], cells: [], isolation: { ok: true }, contextPreviews: { codex: preview } });
    expect(html).toContain('Harness → MCP');
    expect(html).toContain('MCP → harness');
    expect(html).toContain('Tool reported an error');
    expect(html).toContain('id="codex-call-1"');
    expect(html).toContain('Search exchanges');
    expect(html).not.toContain('<script>inert</script>');
    expect(html).toContain('&lt;script&gt;inert&lt;/script&gt;');
    const markdown = renderSmokeContextMarkdown(preview);
    expect(markdown.indexOf('## Tool attempts')).toBeLessThan(markdown.indexOf('## Observed tool definitions'));
    expect(markdown).toContain('Full recorded exchange');
  });
});
