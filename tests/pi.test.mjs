import { afterEach, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeTestEnv } from './helpers/test-env.mjs';
import { Pi } from '../shared/clients/pi.mjs';
import { piEvent } from '../harness/clients/pi.mjs';
import { capturePi } from '../plugins/pi/extension.mjs';
import { selectManifests } from '../harness/clients/index.mjs';

let env;
afterEach(async () => { await env?.restore(); env = null; });

it('installs Pi idempotently, repairs owned runtime, and preserves an unowned extension', async () => {
  env = await makeTestEnv();
  const dir = path.join(env.home, '.pi/agent/extensions/midbrain-memory');
  const client = new Pi();
  await client.installGlobal();
  const entry = await fs.readFile(path.join(dir, 'index.ts'), 'utf8');
  const before = await fs.stat(path.join(dir, 'index.ts'));
  await client.installGlobal();
  expect((await fs.stat(path.join(dir, 'index.ts'))).mtimeMs).toBe(before.mtimeMs);
  expect(await client.isFresh()).toBe(true);
  await fs.writeFile(path.join(dir, 'runtime.mjs'), 'broken');
  expect(await client.isFresh()).toBe(false);
  await client.repairHooks();
  expect(await client.isFresh()).toBe(true);
  await fs.writeFile(path.join(dir, 'index.ts'), 'user extension');
  await expect(client.installGlobal()).rejects.toThrow('unowned');
  expect(await fs.readFile(path.join(dir, 'index.ts'), 'utf8')).toBe('user extension');
  expect(entry).toContain('registerMidbrain');
});

it('captures only native user/assistant text with originating session metadata', async () => {
  env = await makeTestEnv();
  const storeEpisodic = vi.fn();
  const deps = { createApi: vi.fn(async () => ({ storeEpisodic })), logger: { error: vi.fn() } };
  const ctx = { cwd: env.home, sessionManager: { getSessionId: () => 'pi-session' } };
  await capturePi({ message: { role: 'user', content: 'hello' } }, ctx, deps);
  await capturePi({ message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'private' }] } }, { cwd: env.home, sessionManager: { getSessionId: () => 'pi-session' } }, deps);
  await capturePi({ message: { role: 'toolResult', content: 'ignore' } }, {}, deps);
  expect(storeEpisodic.mock.calls.map(([text, role, , metadata]) => ({ text, role, metadata }))).toEqual([
    { text: 'hello', role: 'user', metadata: { client: 'pi', cwd: '~', session_id: 'pi-session' } },
    { text: 'answer', role: 'assistant', metadata: { client: 'pi', cwd: '~', session_id: 'pi-session' } },
  ]);
});

it('makes Pi explicitly selectable without changing the established default matrix', () => {
  expect(selectManifests().map(x => x.id)).toHaveLength(5);
  expect(selectManifests(['pi']).map(x => x.id)).toEqual(['pi']);
});

it('scores completed native Pi events without confusing partial messages or tool failures', () => {
  const turn = { toolCalls: [], nativeAssistantMessages: [], finalText: '', isError: false };
  for (const event of [
    { type: 'session', id: 'native-session' },
    { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
    { type: 'tool_execution_start', toolCallId: '1', toolName: 'midbrain_memory_search', args: { query: 'anchor' } },
    { type: 'tool_execution_end', toolCallId: '1', result: { content: [{ type: 'text', text: 'failure' }] }, isError: true },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  ]) piEvent(turn, event);
  expect(turn.sessionId).toBe('native-session');
  expect(turn.finalText).toBe('answer');
  expect(turn.nativeAssistantMessages).toEqual([{ text: 'answer' }]);
  expect(turn.toolCalls[0]).toMatchObject({ name: 'midbrain_memory_search', ok: false, input: { query: 'anchor' } });
});
