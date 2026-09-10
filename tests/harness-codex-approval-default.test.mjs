import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import codex from '../harness/clients/codex.mjs';
import { approveCodexHooks } from '../harness/lib/codex-approval.mjs';

vi.mock('../harness/lib/codex-approval.mjs', () => ({ approveCodexHooks: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), spawn: vi.fn() }));

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete process.stdin.isTTY;
});

it('automates native approval without an opt-in flag and preserves the driver result', async () => {
  const ctx = { options: {} };
  const env = { HOME: '/isolated/home' };
  vi.spyOn(codex, 'clientEnv').mockReturnValue(env);
  approveCodexHooks.mockResolvedValue(1);
  expect(await codex.approveHooks(ctx, '/isolated/home/work', '/evidence')).toBe(1);
  expect(approveCodexHooks).toHaveBeenCalledWith(ctx, '/isolated/home/work', env, '/evidence');
  expect(spawn).not.toHaveBeenCalled();
});

it('keeps explicit interactive approval manual in a terminal', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  vi.spyOn(codex, 'clientEnv').mockReturnValue({ HOME: '/isolated/home' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const child = new EventEmitter();
  spawn.mockReturnValue(child);
  const pending = codex.approveHooks({ options: { interactive: true } }, '/isolated/home/work', '/evidence');
  child.emit('exit', 0);
  expect(await pending).toBe(0);
  expect(spawn).toHaveBeenCalledWith('codex', expect.arrayContaining(['--no-alt-screen', '-C', '/isolated/home/work']), expect.objectContaining({ stdio: 'inherit' }));
  expect(approveCodexHooks).not.toHaveBeenCalled();
});

it('does not silently automate an interactive request without a terminal', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  expect(await codex.approveHooks({ options: { interactive: true } }, '/project', '/evidence')).toBeNull();
  expect(approveCodexHooks).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
