import { describe, it, expect } from 'vitest';
import { normalizeScriptedRequest, sendScriptedResponse, checkProviderToolSchema } from '../harness/lib/scripted-smoke-wire.mjs';
import { TOOL_CONTRACTS, checkToolSchema } from '../harness/lib/tool-contracts.mjs';

describe('local native provider protocols', () => {
  it('preserves Codex namespaces on discovery, calls and response streams', () => {
    const result = normalizeScriptedRequest('codex', { tools: [{ type: 'namespace', name: 'mcp__midbrain_memory', tools: [{ type: 'function', name: 'list_files', parameters: { type: 'object' } }] }], input: [{ type: 'function_call', namespace: 'mcp__midbrain_memory', name: 'list_files', call_id: 'call', arguments: '{}' }] });
    expect(result.tools[0].name).toBe('mcp__midbrain_memory__list_files');
    expect(result.calls[0].name).toBe(result.tools[0].name);
    let body; sendScriptedResponse('codex', { writeHead() {}, end: s => { body = JSON.parse(s); } }, {}, { id: 'call', name: result.tools[0].name, args: {} }, 1);
    expect(body.output[0]).toMatchObject({ namespace: 'mcp__midbrain_memory', name: 'list_files', call_id: 'call' });
  });
  it('checks the explicit Codex schema projection without relaxing the raw MCP contract', () => {
    const contract = TOOL_CONTRACTS.find(t => t.name === 'memory_search');
    const schema = { type: 'object', required: contract.required, properties: Object.fromEntries(Object.entries(contract.properties).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([field]) => !['minimum', 'maximum', 'default'].includes(field)))])) };
    expect(checkProviderToolSchema('codex', contract.name, schema)).toEqual([]);
    expect(checkToolSchema(contract.name, schema).length).toBeGreaterThan(0);
    schema.properties.memory_type.enum = ['invented'];
    expect(checkProviderToolSchema('codex', contract.name, schema).length).toBeGreaterThan(0);
  });
  it('correlates Anthropic tool_use and tool_result without losing error flags', () => {
    const result = normalizeScriptedRequest('claude', { tools: [{ name: 'tool', input_schema: { type: 'object' } }], messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: '503' }], is_error: true }] },
    ] });
    expect(result.calls).toEqual([{ id: 'call', name: 'tool', args: { query: 'x' } }]);
    expect(result.results).toEqual([{ id: 'call', content: '503', isError: true }]);
    expect(result.tools[0].schema).toEqual({ type: 'object' });
  });
  it('correlates Responses function calls and results with their original IDs', () => {
    const result = normalizeScriptedRequest('codex', { tools: [{ type: 'function', name: 'tool', parameters: { type: 'object' } }], input: [
      { type: 'function_call', call_id: 'call', name: 'tool', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'call', output: 'answer' },
    ] });
    expect(result.calls).toEqual([{ id: 'call', name: 'tool', args: { query: 'x' } }]);
    expect(result.results[0]).toMatchObject({ id: 'call', content: 'answer' });
  });
  it.each(['claude', 'codex'])('streams a tool call and completion in %s wire format', client => {
    const chunks = []; const res = { writeHead() {}, write: value => chunks.push(value), end: value => { if (value) chunks.push(value); } };
    sendScriptedResponse(client, res, { stream: true }, { id: 'script-call-1', name: 'test_tool', args: { query: 'x' } }, 1);
    const wire = chunks.join('');
    expect(wire).toContain('script-call-1'); expect(wire).toContain('test_tool');
    expect(wire).toContain(client === 'claude' ? 'message_stop' : 'response.completed');
    chunks.length = 0; sendScriptedResponse(client, res, { stream: true }, null, 2);
    expect(chunks.join('')).toContain('SCRIPTED_MCP_COMPLETE');
  });
});
