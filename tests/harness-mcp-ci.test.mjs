import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

describe('MCP integration CI boundaries', () => {
  it('runs a secretless Linux/macOS native matrix on integration changes', () => {
    const source = readFileSync('.github/workflows/mcp-integration.yml', 'utf8');
    const workflow = parse(source);
    expect(workflow.on.pull_request.paths).toContain('mcp.mjs');
    expect(workflow.on.push.paths).toContain('harness/**');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs['dry-smoke'].strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
    expect(workflow.jobs['scripted-smoke'].strategy.matrix.client).toEqual(['pi', 'opencode', 'hermes', 'claude', 'codex']);
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('--execute');
    for (const job of Object.values(workflow.jobs)) {
      expect(job.strategy['fail-fast']).toBe(false);
      expect(job.steps.some(s => s.uses?.startsWith('actions/upload-artifact') && s.if === 'always()')).toBe(true);
      expect(job.steps.find(s => s.uses?.startsWith('actions/checkout')).with['persist-credentials']).toBe(false);
    }
    expect(source).toContain('protocol-events.ndjson');
  });
  it('keeps paid behavioral work manual and reuses the same native smoke matrix', () => {
    const workflow = parse(readFileSync('.github/workflows/behavioral.yml', 'utf8'));
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    for (const suite of ['dry-smoke', 'scripted-smoke']) {
      expect(workflow.jobs[suite].uses).toBe('./.github/workflows/mcp-integration.yml');
      expect(workflow.jobs[suite].with.suite).toBe(suite);
    }
  });
});
