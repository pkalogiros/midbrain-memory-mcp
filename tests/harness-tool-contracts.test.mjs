import { describe, it, expect } from 'vitest';
import { TOOL_CONTRACTS, checkToolSchema, toolCoverage } from '../harness/lib/tool-contracts.mjs';

describe('per-tool MCP coverage', () => {
  it('defines all 12 tools and explicitly marks argument-free tools', () => {
    expect(TOOL_CONTRACTS).toHaveLength(12);
    expect(TOOL_CONTRACTS.filter(t => !t.invalid).map(t => t.name).sort()).toEqual(['check_session_status', 'list_agents', 'list_files']);
  });
  it('rejects missing properties, changed bounds and new required arguments', () => {
    const tool = TOOL_CONTRACTS.find(t => t.name === 'memory_search');
    const schema = { type: 'object', properties: globalThis.structuredClone(tool.properties), required: tool.required };
    expect(checkToolSchema(tool.name, schema)).toEqual([]);
    schema.properties.limit.maximum = 500;
    expect(checkToolSchema(tool.name, schema).length).toBeGreaterThan(0);
    schema.properties = globalThis.structuredClone(tool.properties); schema.required = ['query', 'limit'];
    expect(checkToolSchema(tool.name, schema).length).toBeGreaterThan(0);
    delete schema.properties.query;
    expect(checkToolSchema(tool.name, schema).length).toBeGreaterThan(0);
  });
  it('does not infer execution coverage from discovery or a successful response alone', () => {
    const found = name => toolCoverage({ discoveries: [{ tools: [{ name: 'memory_search', inputSchema: {} }] }], checks: [], calls: [{ name: 'memory_search', status: 'returned', result: { content: [{ type: 'text', text: 'failure' }] } }] }).find(t => t.name === name);
    expect(found('memory_search')).toMatchObject({ discovered: true, schema: 'NOT RECORDED', positive: 'NOT RECORDED', invalid: 'NOT RECORDED', recovery: 'NOT RECORDED' });
    expect(found('list_files').invalid).toBe('N/A — no arguments');
  });
  it('requires the specific tool call, passing scenario, and text response envelope', () => {
    const evidence = { checks: [{ id: 'files', ok: true }, { id: 'schema:list_files', ok: true }], calls: [{ id: 'one', name: 'list_files', caseId: 'files', status: 'returned', result: { content: [{ type: 'text', text: 'Files (1)' }] } }], discoveries: [] };
    expect(toolCoverage(evidence).find(t => t.name === 'list_files').positive).toBe('PASS');
    expect(toolCoverage(evidence).find(t => t.name === 'read_file').positive).toBe('NOT RECORDED');
    evidence.calls[0].result = { content: [] };
    expect(toolCoverage(evidence).find(t => t.name === 'list_files').positive).toBe('FAIL');
  });
});
