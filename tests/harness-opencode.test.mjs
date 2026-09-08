import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
vi.mock('../harness/lib/proc.mjs', () => ({ spawnCapture: vi.fn(), whichSync: vi.fn() }));
import { spawnCapture } from '../harness/lib/proc.mjs';
import opencode, { toolCall } from '../harness/clients/opencode.mjs';

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
    ]) options.onStdoutLine(JSON.stringify(event));
    return { code: 0, durationMs: 1, stderr: '', timedOut: false };
  }).mockResolvedValueOnce({ code: 0, stdout: exportText, stderr: '' });
  try {
    const turn = await opencode.runTurn({ ctx: {}, project: dir, evidenceDir: dir, prompt: 'recall checkpoint' });
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({ id: 'current', result: 'VALUE-hidden', ok: true });
    expect(turn.finalText).toBe('VALUE-hidden');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
