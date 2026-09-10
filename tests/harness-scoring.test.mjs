import { describe, it, expect, vi } from 'vitest';
import { recallChecks, currentAnswerChecks, captureCountChecks } from '../harness/lib/checks.mjs';
import { metadataChecks, readback, runTurn } from '../harness/scenarios/_shared.mjs';
import { HarnessApi } from '../harness/lib/api.mjs';
import os from 'node:os';

const turn = (result, ok = true) => ({ finalText: 'VALUE-secret', toolCalls: [{ name: 'midbrain__memory_search', input: { query: 'TASK' }, result, ok }] });
const passed = checks => checks.every(c => c.ok);

it('reports an unavailable readback API as blocked', async () => {
  const api = { waitForRows: async () => ({ rows: [], lastError: 'service unavailable' }) };
  await expect(readback({ options: {} }, api, 'marker', {})).rejects.toMatchObject({ blocked: true, message: expect.stringContaining('service unavailable') });
});

it('stops readback immediately on rejected credentials instead of reporting missing captures', async () => {
  const api = new HarnessApi({ baseUrl: 'http://unused', key: 'unused' });
  api.get = vi.fn().mockResolvedValue({ ok: false, status: 401 });
  await expect(readback({ options: {} }, api, 'marker', { sinceIso: new Date().toISOString() }))
    .rejects.toMatchObject({ blocked: true, message: expect.stringContaining('HTTP 401') });
  expect(api.get).toHaveBeenCalledTimes(1);
});

it('preserves native provider-error evidence before blocking the scenario', async () => {
  const home = os.tmpdir();
  const ctx = { dirs: { run: home, home }, turns: [], writeJson: vi.fn(), evidenceDir: () => home };
  const client = { id: 'nanoclaw', runTurn: async () => ({ providerError: 'billing_error (HTTP 400)', isError: true }) };
  await expect(runTurn({ ctx, client, project: home, prompt: 'test', scenarioId: 's08', label: 'provider-error' }))
    .rejects.toMatchObject({ blocked: true, message: expect.stringContaining('billing_error') });
  expect(ctx.turns).toHaveLength(1);
  expect(ctx.writeJson.mock.calls[1][1].providerError).toBe('billing_error (HTTP 400)');
});

it('records and sends the same client-formatted prompt', async () => {
  const home = os.tmpdir();
  const ctx = { dirs: { run: home, home }, turns: [], writeJson: vi.fn(), evidenceDir: () => home };
  const client = { id: 'nanoclaw', formatPrompt: p => `${p}\nUse the delivery wrapper.`, runTurn: vi.fn(async () => ({ exitCode: 0, durationMs: 1 })) };
  await runTurn({ ctx, client, project: home, prompt: 'exact marker', scenarioId: 's01', label: 'turn' });
  expect(client.runTurn.mock.calls[0][0].prompt).toBe('exact marker\nUse the delivery wrapper.');
  expect(ctx.writeJson.mock.calls[0][1].prompt).toBe(client.runTurn.mock.calls[0][0].prompt);
});

it('does not label post-upgrade capture as a cold first turn', async () => {
  const { default: scenario } = await import('../harness/scenarios/s10-client-specific.mjs');
  const client = { id: 'claude', specific: ['cold-first-turn'] };
  const ctx = { meta: { firstTurn: { claude: { userCaptured: true, assistantCaptured: true } } }, turns: [
    { client: 'claude', scenario: 's09-upgrade-continuity' },
    { client: 'claude', scenario: 's01-capture' },
  ] };
  expect((await scenario.run({ ctx, client }))[0].status).toBe('BLOCKED');
  ctx.turns.shift();
  expect((await scenario.run({ ctx, client }))[0].status).toBe('PASS');
});

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

describe('turn reuse (cost): same evidence, fewer prompts', () => {
  function fakeCtx(extra = {}) {
    return { dirs: { run: os.tmpdir(), home: os.tmpdir(), logs: os.tmpdir() }, options: { indexGraceMs: 0 }, turns: [], meta: {},
      evidenceDir: () => os.tmpdir(), writeJson() {}, subMarker: (id, s) => `MBH-test-${id}-${s}`, ...extra };
  }
  const goodTurn = (prompt, extra = {}) => ({ prompt, finalText: prompt, exitCode: 0, timedOut: false, isError: false, toolCalls: [], rawPath: '/tmp/unused/turn', jsonPath: '/tmp/unused/turn.json', captureCwd: '~/work', sessionId: 'sess', ...extra });

  it('S2 writes one checkpoint per writer and reuses it for every reader', async () => {
    const { default: s02 } = await import('../harness/scenarios/s02-cross-client-recall.mjs');
    const ctx = fakeCtx();
    const writes = [], reads = [];
    const writer = { id: 'claude', displayName: 'Claude', runTurn: async ({ prompt }) => { writes.push(prompt); return goodTurn(prompt); } };
    const reader = (id) => ({ id, displayName: id, runTurn: async ({ prompt }) => { reads.push(prompt); return goodTurn(prompt, { toolCalls: [] }); } });
    const api = { waitForRows: async () => ({ rows: [{ role: 'user', text: 'x' }], elapsedMs: 1, polls: 1, timedOut: false, lastError: null }) };
    await s02.run({ ctx, api, writer, reader: reader('codex'), project: os.tmpdir() });
    await s02.run({ ctx, api, writer, reader: reader('hermes'), project: os.tmpdir() });
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toContain('MBH-test-claude-xrecall');
    expect(reads[1]).toContain('MBH-test-claude-xrecall');
    expect(writes[0]).toMatch(/VALUE-[0-9a-f]{16}/);
    expect(reads.join(' ')).not.toMatch(/VALUE-[0-9a-f]{16}/);
  });

  it('S1 scores the post-upgrade capture instead of running a second identical turn', async () => {
    const { default: s01 } = await import('../harness/scenarios/s01-capture.mjs');
    const meta = { client: 'claude', session_id: 'sess', cwd: '~/work' };
    const rows = [{ role: 'user', text: 'MBH-x', memory_metadata: meta, created_at: '2026-09-10T00:00:00Z' }, { role: 'assistant', text: 'MBH-x', memory_metadata: meta, created_at: '2026-09-10T00:00:01Z' }];
    const rb = { rows, user: [rows[0]], assistant: [rows[1]], elapsedMs: 1, polls: 1, timedOut: false, lastError: null };
    const ctx = fakeCtx({ meta: { candidateCapture: { claude: { marker: 'MBH-x', prompt: 'p', turn: goodTurn('p'), rb } } } });
    const client = { id: 'claude', expectedCaptureLabel: 'claude', runTurn: async () => { throw new Error('S1 must not spend a turn in upgrade mode'); } };
    const api = { waitForRows: async () => { throw new Error('no read-back expected'); } };
    const cells = await s01.run({ ctx, api, client, project: os.tmpdir() });
    expect(cells.map(c => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    expect(cells[0].notes).toContain('post-upgrade capture');
    expect(ctx.meta.captureEvidence.claude.rb).toBe(rb);
    // Simple's upgraded checkpoint also feeds S2 and S8 without another prompt.
    const { default: s08 } = await import('../harness/scenarios/s08-marker-robustness.mjs');
    const literal = '<!-- mb:ctx-start --> midbrain-memory-rules:start MBH-x';
    ctx.options.simple = true;
    ctx.meta.candidateCapture.claude.seed = { m: 'MBH-x', value: 'VALUE-hidden', literal };
    ctx.meta.candidateCapture.claude.turn.finalText = literal;
    rows.forEach(row => { row.text = literal; });
    await s01.run({ ctx, api, client, project: os.tmpdir() });
    expect(ctx.meta.s02Writes.claude.value).toBe('VALUE-hidden');
    expect((await s08.run({ ctx, api, client, project: os.tmpdir() }))[0].status).toBe('PASS');

  });

  it('hook ordering is derived from the S1 capture instead of a new turn', async () => {
    const { default: s10 } = await import('../harness/scenarios/s10-client-specific.mjs');
    const meta = { client: 'claude', session_id: 'sess', cwd: '~/work' };
    const rows = [{ role: 'user', text: 'MBH-x', memory_metadata: meta, created_at: '2026-09-10T00:00:00Z' }, { role: 'assistant', text: 'MBH-x', memory_metadata: meta, created_at: '2026-09-10T00:00:01Z' }];
    const rb = { rows, user: [rows[0]], assistant: [rows[1]], elapsedMs: 1, polls: 1, timedOut: false, lastError: null };
    const ctx = fakeCtx({ meta: { captureEvidence: { claude: { turn: goodTurn('p'), rb, evidence: ['evidence/claude/s01-capture/turn-1.json'] } } } });
    const client = { id: 'claude', expectedCaptureLabel: 'claude', specific: ['hook-ordering'], runTurn: async () => { throw new Error('must not spend a turn'); } };
    const cells = await s10.run({ ctx, api: {}, client, project: os.tmpdir() });
    expect(cells).toHaveLength(1);
    expect(cells[0].status).toBe('PASS');
    expect(cells[0].notes).toContain('derived from s01-capture');
  });
});

it('S4 reuses the S1 global write instead of storing a second identical marker', async () => {
  const { default: s04 } = await import('../harness/scenarios/s04-project-global-isolation.mjs');
  const { HarnessApi } = await import('../harness/lib/api.mjs');
  const path = await import('node:path');
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(path.join(os.tmpdir(), 's04-reuse-'));
  const project = path.join(root, 'proj-a'); mkdirSync(project);
  for (const p of ['proj-b', 'proj-c']) mkdirSync(path.join(root, p));
  const rows = [{ role: 'user', text: 'marker for this session is MBH-s1' }];
  const rb = { rows, user: rows, assistant: [], elapsedMs: 1, polls: 1, timedOut: false, lastError: null };
  const ctx = { dirs: { run: root, home: root, logs: root }, options: { indexGraceMs: 0 }, turns: [], secrets: { MIDBRAIN_HARNESS_PROJECT_API_KEY: 'k2' },
    meta: { projBInstalled: true, captureEvidence: { claude: { marker: 'MBH-s1', since: '2026-09-10T00:00:00.000Z', project, rb, evidence: ['evidence/claude/s01-capture/turn-1.ndjson'] } } },
    projectDir: (n) => path.join(root, n), evidenceDir: () => root, writeJson() {}, subMarker: (id, s) => `MBH-${id}-${s}` };
  const prompts = [];
  const client = { id: 'claude', expectedCaptureLabel: 'claude', runTurn: async ({ prompt }) => { prompts.push(prompt); return { prompt, finalText: 'not found after search', exitCode: 0, timedOut: false, isError: false, toolCalls: [], rawPath: path.join(root, 't'), jsonPath: path.join(root, 't.json') }; } };
  const api = { base: 'http://unused', listEpisodicSince: async () => [], waitForRows: async () => ({ rows, elapsedMs: 1, polls: 1, timedOut: false, lastError: null }) };
  const spyList = vi.spyOn(HarnessApi.prototype, 'listEpisodicSince').mockResolvedValue([]);
  const spyWait = vi.spyOn(HarnessApi.prototype, 'waitForRows').mockResolvedValue({ rows, elapsedMs: 1, polls: 1, timedOut: false, lastError: null });
  try {
    const [cellA] = await s04.run({ ctx, api, client, project, candidate: {} });
    expect(prompts).toHaveLength(4); // write-proj-b + three asks; no write-proj-a
    expect(prompts.filter(p => p.includes('MBH-claude-isoA'))).toHaveLength(0);
    expect(prompts.some(p => p.includes('MBH-s1'))).toBe(true); // proj-c asks for the S1 marker
    expect(cellA.notes).toContain('reused from s01-capture');
    expect(spyList).toHaveBeenCalledWith('2026-09-10T00:00:00.000Z'); // leak check spans the S1 write
  } finally { spyList.mockRestore(); spyWait.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it('S3 in simple mode is scored on the upgrade prelude turns instead of two more prompts', async () => {
  const { default: s03 } = await import('../harness/scenarios/s03-fresh-session-continuity.mjs');
  const turn = (prompt, sessionId, calls = []) => ({ prompt, sessionId, finalText: 'VALUE-abc', exitCode: 0, timedOut: false, isError: false, toolCalls: calls, rawPath: '/tmp/unused/t', jsonPath: '/tmp/unused/t.json' });
  const recall = turn('recall', 'sess-2', [{ name: 'midbrain__memory_search', input: { query: 'MBH-pre' }, result: 'checkpoint MBH-pre has verification value VALUE-abc', ok: true }]);
  const ctx = { dirs: { run: '/tmp/unused' }, options: { simple: true, indexGraceMs: 0 }, meta: { upgradeTurns: { claude: { marker: 'MBH-pre', value: 'VALUE-abc', write: turn('write', 'sess-1'), recall } } }, turns: [], subMarker: (id, s) => `MBH-${id}-${s}`, evidenceDir: () => '/tmp/unused', writeJson() {} };
  const client = { id: 'claude', runTurn: async () => { throw new Error('must not spend a turn in simple mode'); } };
  const cells = await s03.run({ ctx, api: {}, client, project: os.tmpdir() });
  expect(cells.map(c => c.status)).toEqual(['PASS', 'PASS']);
  expect(cells[0].notes).toContain('derived from the S9 upgrade prelude');
  const full = { ...ctx, options: { simple: false, indexGraceMs: 0 } };
  await expect(s03.run({ ctx: full, api: {}, client, project: os.tmpdir() })).rejects.toThrow('must not spend');
});

it('simple mode trims S4 to three asks and skips required-only client cases', async () => {
  const { default: s04 } = await import('../harness/scenarios/s04-project-global-isolation.mjs');
  const { default: s10 } = await import('../harness/scenarios/s10-client-specific.mjs');
  const { HarnessApi } = await import('../harness/lib/api.mjs');
  const path = await import('node:path');
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(path.join(os.tmpdir(), 's04-simple-'));
  const project = path.join(root, 'proj-a'); for (const p of ['proj-a', 'proj-b', 'proj-c']) mkdirSync(path.join(root, p));
  const rows = [{ role: 'user', text: 'marker for this session is MBH-s1' }];
  const rb = { rows, user: rows, assistant: [], elapsedMs: 1, polls: 1, timedOut: false, lastError: null };
  const ctx = { dirs: { run: root, home: root, logs: root }, options: { indexGraceMs: 0, simple: true }, turns: [], secrets: { MIDBRAIN_HARNESS_PROJECT_API_KEY: 'k2' },
    meta: { projBInstalled: true, captureEvidence: { codex: { marker: 'MBH-s1', since: '2026-09-10T00:00:00.000Z', project, rb, evidence: [] } } },
    projectDir: (n) => path.join(root, n), evidenceDir: () => root, writeJson() {}, subMarker: (id, s) => `MBH-${id}-${s}` };
  const prompts = [];
  const client = { id: 'codex', expectedCaptureLabel: 'codex', specific: ['hook-trust-persisted'], runTurn: async ({ prompt }) => { prompts.push(prompt); return { prompt, finalText: 'not found after search', exitCode: 0, timedOut: false, isError: false, toolCalls: [], rawPath: path.join(root, 't'), jsonPath: path.join(root, 't.json') }; } };
  const api = { base: 'http://unused', listEpisodicSince: async () => [], waitForRows: async () => ({ rows, elapsedMs: 1, polls: 1, timedOut: false, lastError: null }) };
  const spies = [vi.spyOn(HarnessApi.prototype, 'listEpisodicSince').mockResolvedValue([]), vi.spyOn(HarnessApi.prototype, 'waitForRows').mockResolvedValue({ rows, elapsedMs: 1, polls: 1, timedOut: false, lastError: null })];
  try {
    const [cellA] = await s04.run({ ctx, api, client, project, candidate: {} });
    expect(prompts).toHaveLength(3); // write-proj-b + two asks
    expect(cellA.notes).toContain('required-only');
    expect(cellA.checks.some(c => /global fallback/.test(c.name))).toBe(false);
    expect(await s10.run({ ctx, api, client, project, candidate: {} })).toEqual([]);
    ctx.options.simple = false;
    await expect(s10.run({ ctx, api, client, project, candidate: {} })).resolves.not.toEqual([]);
  } finally { spies.forEach(s => s.mockRestore()); rmSync(root, { recursive: true, force: true }); }
});

it('simple mode builds S5 on the client S2 checkpoint and trims the OpenCode and Hermes cases', async () => {
  const { default: s05 } = await import('../harness/scenarios/s05-freshness-reconciliation.mjs');
  const { default: s10 } = await import('../harness/scenarios/s10-client-specific.mjs');
  const path = await import('node:path');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'simple-trim-'));
  const project = path.join(root, 'proj-a'); mkdirSync(project);
  mkdirSync(path.join(root, '.hermes')); mkdirSync(path.join(root, '.config/opencode'), { recursive: true });
  writeFileSync(path.join(root, '.config/opencode/opencode.jsonc'), '{ "mcp": { "midbrain-memory": { "enabled": true } } }');
  const turn = (prompt, extra = {}) => ({ prompt, finalText: '{"current":"VALUE-new","evidence":"update"}', exitCode: 0, timedOut: false, isError: false, toolCalls: [], rawPath: path.join(root, 't'), jsonPath: path.join(root, 't.json'), captureCwd: '~/proj-a', sessionId: 'sess', ...extra });
  const rows = [{ role: 'user', text: 'Checkpoint for task MBH-w: VALUE-old', memory_metadata: { client: 'hermes', session_id: 'sess', cwd: '~/proj-a' } }, { role: 'assistant', text: 'ok MBH-w', memory_metadata: { client: 'hermes', session_id: 'sess', cwd: '~/proj-a' } }];
  const rb = { rows, user: [rows[0]], assistant: [rows[1]], elapsedMs: 1, polls: 1, timedOut: false, lastError: null };
  const prompts = [];
  const mk = (id) => ({ id, expectedCaptureLabel: id, specific: id === 'hermes' ? ['hook-acceptance'] : ['plugin-process-separation'],
    runTurn: async ({ prompt }) => { prompts.push(prompt); return turn(prompt, prompt.includes('Reply with exactly') ? { finalText: 'x' } : { toolCalls: [{ name: 'midbrain__memory_search', input: { query: 'MBH-w' }, result: 'VALUE-new is current', ok: true }] }); } });
  const base = { dirs: { run: root, home: root, logs: root }, options: { indexGraceMs: 0, simple: true }, turns: [], evidenceDir: () => root, writeJson() {}, subMarker: (id, s) => `MBH-${id}-${s}` };
  const api = { waitForRows: async () => ({ rows: rows.concat({ ...rows[0], text: prompts.find(p => p.startsWith('Update for task')) || '' }), elapsedMs: 1, polls: 1, timedOut: false, lastError: null }) };
  try {
    const ctx = { ...base, meta: { s02Writes: { hermes: { m: 'MBH-w', value: 'VALUE-old', wTurn: turn('w'), rb, since: '2026-09-10T00:00:00.000Z' } }, captureEvidence: { hermes: { turn: turn('s1'), rb, evidence: ['e'] } } } };
    const cells = await s05.run({ ctx, api, client: mk('hermes'), project });
    expect(prompts.filter(p => p.startsWith('Note for task'))).toHaveLength(0);
    expect(prompts.filter(p => p.startsWith('Update for task MBH-w'))).toHaveLength(1);
    expect(cells[0].notes).toContain('S2 checkpoint');
    prompts.length = 0;
    const hermesCells = await s10.run({ ctx, api, client: mk('hermes'), project, candidate: {} });
    expect(prompts).toHaveLength(1); // only the unapproved turn
    expect(hermesCells[0].notes).toContain('derived from s01-capture');
    prompts.length = 0;
    const ocCells = await s10.run({ ctx, api, client: mk('opencode'), project, candidate: {} });
    expect(prompts).toHaveLength(1); // capture only, no MCP recall turn
    expect(ocCells[0].notes).toContain('required-only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


it('allows a slow verification request beyond 30 seconds but aborts at 60 seconds', async () => {
  vi.useFakeTimers();
  try {
    const api = new HarnessApi({ baseUrl: 'http://unused', key: 'unused' });
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, status: 200, text: async () => '[]' }), 45000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('request timed out')); }, { once: true });
    })));
    const slow = api.get('/test');
    await vi.advanceTimersByTimeAsync(45000);
    expect((await slow).ok).toBe(true);
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('request timed out')), { once: true });
    })));
    const stalled = expect(api.get('/test')).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(60000);
    await stalled;
  } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});


it('counts only a proven read of a preceding MidBrain result file', async () => {
  const { memoryEvidence } = await import('../harness/lib/checks.mjs');
  const source = { name: 'midbrain__memory_search', ok: true, result: 'Output has been saved to /tmp/tool-results/result.txt.\nFormat: Plain text' };
  const read = { name: 'Bash', ok: true, input: { command: 'grep -n "TASK" /tmp/tool-results/result.txt' }, result: 'VALUE-secret' };
  expect(memoryEvidence({ toolCalls: [source, read] })).toContain('VALUE-secret');
  expect(memoryEvidence({ toolCalls: [read, source] })).not.toContain('VALUE-secret');
  expect(memoryEvidence({ toolCalls: [source, { ...read, input: { command: 'grep -n "TASK" /tmp/other.txt' } }] })).not.toContain('VALUE-secret');
});

it('clears recovered Codex stream errors only on successful completion, retaining terminal failures', async () => {
  const { recordCodexOutcome } = await import('../harness/clients/codex.mjs');
  const turn = {};
  recordCodexOutcome(turn, { type: 'error', message: 'Reconnecting' });
  expect(turn.isError).toBe(true);
  recordCodexOutcome(turn, { type: 'turn.completed' });
  expect(turn.isError).toBe(false);
  expect(turn.recoveredErrors).toHaveLength(1);
  recordCodexOutcome(turn, { type: 'turn.failed' });
  recordCodexOutcome(turn, { type: 'turn.completed' });
  expect(turn.isError).toBe(true);
});
