import { describe, it, expect, vi } from 'vitest';
import { recallChecks, currentAnswerChecks, captureCountChecks } from '../harness/lib/checks.mjs';
import { metadataChecks, readback } from '../harness/scenarios/_shared.mjs';
import { HarnessApi } from '../harness/lib/api.mjs';

const turn = (result, ok = true) => ({ finalText: 'VALUE-secret', toolCalls: [{ name: 'midbrain__memory_search', input: { query: 'TASK' }, result, ok }] });
const passed = checks => checks.every(c => c.ok);

describe('evidence-based scoring', () => {
  it('rejects an answer without successful retrieval of the hidden value', () => {
    expect(passed(recallChecks(turn('reader question TASK'), 'TASK', ['VALUE-secret']))).toBe(false);
    expect(passed(recallChecks(turn('VALUE-secret', false), 'TASK', ['VALUE-secret']))).toBe(false);
    expect(passed(recallChecks(turn('VALUE-secret'), 'TASK', ['VALUE-secret']))).toBe(true);
  });
  it('does not accept contradictory prose or merely mentioning the current value', () => {
    expect(passed(currentAnswerChecks('Old is current; new is retired.', 'new'))).toBe(false);
    expect(passed(currentAnswerChecks('{"current":"old","evidence":"new retired"}', 'new'))).toBe(false);
    expect(passed(currentAnswerChecks('{"current":"new","evidence":"the update"}', 'new'))).toBe(true);
  });
  it('requires capture metadata to match the real client session', () => {
    const rows = [{ memory_metadata: { client: 'claude', session_id: 'other', cwd: '~/work' } }];
    expect(passed(metadataChecks(rows, 'claude', '~/work', 'actual'))).toBe(false);
  });
  it('distinguishes two native replies from duplicate capture of one reply', () => {
    const turn = { nativeAssistantMessages: [{ id: 'a', text: 'plain' }, { id: 'b', text: '<message>plain</message>' }] };
    const rows = [{ role: 'user', text: 'prompt' }, { role: 'assistant', text: 'plain' }, { role: 'assistant', text: '<message>plain</message>' }];
    expect(passed(captureCountChecks(rows, turn))).toBe(true);
    expect(passed(captureCountChecks([rows[0], rows[1], rows[1]], turn))).toBe(false);
  });
});

it('waits for both roles and notices a late duplicate before declaring capture settled', async () => {
  vi.useFakeTimers();
  try {
    const api = new HarnessApi({ baseUrl: 'http://unused', key: 'unused' });
    const user = { id: 'u', role: 'user', text: 'MARKER' };
    const assistant = { id: 'a', role: 'assistant', text: 'MARKER' };
    api.listEpisodicSince = vi.fn().mockResolvedValueOnce([user, { ...user, id: 'u2' }]).mockResolvedValueOnce([user, assistant]).mockResolvedValue([user, assistant, { ...assistant, id: 'a2' }]);
    const result = readback({ options: { readbackTimeoutMs: 10000, pollIntervalMs: 1000, captureSettleMs: 3000 } }, api, 'MARKER', { sinceIso: new Date().toISOString(), minUser: 1, minAssistant: 1 });
    await vi.advanceTimersByTimeAsync(6000);
    const rb = await result;
    expect(rb.assistant).toHaveLength(2);
    expect(rb.timedOut).toBe(false);
    expect(rb.elapsedMs).toBeGreaterThanOrEqual(5000);
  } finally { vi.useRealTimers(); }
});


it('detects edited and missing frozen inputs', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { snapshotFiles, assertFilesUnchanged } = await import('../harness/lib/candidate.mjs');
  const root = mkdtempSync(path.join(tmpdir(), 'candidate-test-'));
  try {
    const file = path.join(root, 'scenario.mjs');
    writeFileSync(file, 'original');
    const snapshot = snapshotFiles(root);
    expect(() => assertFilesUnchanged(root, snapshot)).not.toThrow();
    writeFileSync(file, 'edited');
    expect(() => assertFilesUnchanged(root, snapshot)).toThrow('Frozen input changed');
    rmSync(file);
    expect(() => assertFilesUnchanged(root, snapshot)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('requires a clean Hermes consent state and restores it even if the client fails', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { default: scenario } = await import('../harness/scenarios/s10-client-specific.mjs');
  const home = mkdtempSync(path.join(tmpdir(), 'hermes-consent-'));
  const allowlist = path.join(home, '.hermes/shell-hooks-allowlist.json');
  mkdirSync(path.dirname(allowlist));
  writeFileSync(allowlist, '{"existing":"approval"}');
  const ctx = { dirs: { home }, evidenceDir: () => home, subMarker: () => 'MARKER', writeJson() {} };
  const client = { id: 'hermes', specific: ['hook-acceptance'], async runTurn({ acceptHooks }) {
    expect(acceptHooks).toBe(false);
    expect(existsSync(allowlist)).toBe(false);
    throw new Error('client failed');
  } };
  try {
    await expect(scenario.run({ ctx, client, project: home })).rejects.toThrow('client failed');
    expect(readFileSync(allowlist, 'utf8')).toBe('{"existing":"approval"}');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
