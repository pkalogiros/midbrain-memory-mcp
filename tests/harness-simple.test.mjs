import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientPairs, selectManifests, ORDER } from '../harness/clients/index.mjs';
import { renderMarkdown } from '../harness/lib/report.mjs';

const ids = pairs => pairs.map(({ writer, reader }) => `${writer.id}->${reader.id}`);

describe('simple cross-client coverage', () => {
  it('keeps all 20 ordered pairs by default', () => {
    const pairs = clientPairs(selectManifests());
    expect(new Set(ids(pairs)).size).toBe(20);
    for (const id of ORDER) {
      expect(pairs.filter(p => p.writer.id === id)).toHaveLength(4);
      expect(pairs.filter(p => p.reader.id === id)).toHaveLength(4);
    }
  });
  it('uses five deterministic links, with every client writing and reading once', () => {
    const pairs = clientPairs(selectManifests([...ORDER].reverse()), true);
    expect(ids(pairs)).toEqual(['opencode->claude', 'claude->codex', 'codex->hermes', 'hermes->nanoclaw', 'nanoclaw->opencode']);
  });
  it('does not silently remove an unavailable client from the cycle', () => {
    const clients = selectManifests().map(c => ({ id: c.id, runnable: c.id !== 'codex' }));
    expect(ids(clientPairs(clients, true))).toContain('claude->codex');
    expect(ids(clientPairs(clients, true))).toContain('codex->hermes');
  });
  it('supports selected subsets without self-pairs', () => {
    expect(ids(clientPairs(selectManifests(['codex', 'claude']), true))).toEqual(['claude->codex', 'codex->claude']);
    expect(clientPairs(selectManifests(['claude']), true)).toEqual([]);
    expect(clientPairs([], true)).toEqual([]);
  });
  it('rejects combining simple and required before setup or model calls', () => {
    const cli = fileURLToPath(new URL('../harness/run.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'run', '--simple', '--required'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--simple cannot be combined with --required');
  });
  it('labels the reduced coverage and planned links in the report', () => {
    const report = renderMarkdown({ run: { simple: true, crossClientPairs: [{ writer: 'claude', reader: 'codex' }] },
      candidate: {}, clients: [], cells: [], isolation: { ok: true, drift: [] } });
    expect(report).toContain('Simple cycle');
    expect(report).toContain('claude → codex');
    expect(report).toContain('not full required coverage');
  });
});
