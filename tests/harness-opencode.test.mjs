import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
vi.mock('../harness/lib/proc.mjs', () => ({ spawnCapture: vi.fn(), whichSync: vi.fn() }));
import { spawnCapture } from '../harness/lib/proc.mjs';
import opencode, { toolCall, nativeUsage } from '../harness/clients/opencode.mjs';

it('accounts for native steps once and leaves missing cost unreported', () => {
  const steps = [
    { id: 'one', tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 5, write: 0 } }, cost: 0.001 },
    { id: 'two', tokens: { input: 30, output: 8, reasoning: 2, cache: { read: 10, write: 0 } }, cost: 0.002 },
  ];
  const usage = nativeUsage([...steps, steps[1]]);
  expect(usage.cost).toBeCloseTo(0.003);
  expect(usage.usage.steps).toEqual(steps);
  expect(usage.costSource).toMatch(/client.*not.*invoice/i);
  expect(nativeUsage([]).cost).toBeNull();
  expect(nativeUsage([steps[0], { id: 'two', tokens: {} }]).cost).toBeNull();
  expect(nativeUsage([{ id: 'free', tokens: {}, cost: 0 }]).cost).toBe(0);
});

afterEach(() => vi.restoreAllMocks());

it('retains full MCP output only from OpenCode native metadata inside the run home', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'opencode-spill-'));
  const dir = path.join(home, '.local/share/opencode/tool-output');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tool_native');
  writeFileSync(file, 'VALUE-hidden');
  const part = { tool: 'midbrain-memory_memory_search', id: 'search', state: { status: 'completed', output: 'preview', metadata: { truncated: true, outputPath: file } } };
  try {
    const call = toolCall(part, { dirs: { home } }, home, 'turn');
    expect(call.result).toBe('VALUE-hidden');
    expect(readFileSync(call.resultPath, 'utf8')).toBe('VALUE-hidden');
    part.state.metadata.outputPath = path.join(home, 'credential.txt');
    writeFileSync(part.state.metadata.outputPath, 'must not read');
    const rejected = toolCall(part, { dirs: { home } }, home, 'turn');
    expect(rejected.result).toBe('preview');
    expect(rejected.evidenceError).toBeTruthy();
    expect(rejected.resultPath).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.each(['{"messages":[', JSON.stringify({ messages: [{ role: 'assistant', parts: [
  { type: 'tool', id: 'previous-turn', tool: 'midbrain-memory_memory_search', state: { status: 'completed', output: 'old evidence' } },
] }] })])('keeps current native tool evidence when an export is truncated or includes old turns: %s', async exportText => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opencode-evidence-'));
  vi.spyOn(opencode, 'clientEnv').mockReturnValue({});
  spawnCapture.mockImplementationOnce(async (_cmd, _args, options) => {
    for (const event of [
      { type: 'text', part: { sessionID: 'session', messageID: 'thinking', text: 'Searching.' } },
      { type: 'tool_use', part: { type: 'tool', id: 'current', tool: 'midbrain-memory_memory_search', state: { status: 'completed', input: { query: 'checkpoint' }, output: 'VALUE-hidden' } } },
      { type: 'text', part: { messageID: 'answer', text: 'VALUE-hidden' } },
      { type: 'step_finish', part: { type: 'step-finish', id: 'usage', tokens: { input: 12, output: 3 }, cost: 0.001 } },
    ]) options.onStdoutLine(JSON.stringify(event));
    return { code: 0, durationMs: 1, stderr: '', timedOut: false };
  }).mockResolvedValueOnce({ code: 0, stdout: exportText, stderr: '' });
  try {
    const turn = await opencode.runTurn({ ctx: {}, project: dir, evidenceDir: dir, prompt: 'recall checkpoint' });
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({ id: 'current', result: 'VALUE-hidden', ok: true });
    expect(turn.finalText).toBe('VALUE-hidden');
    expect(turn.cost).toBe(0.001);
    expect(turn.usage.steps).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
