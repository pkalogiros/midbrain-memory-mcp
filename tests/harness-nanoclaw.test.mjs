import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerUrl, parseTranscript, selectReply, ownedMount, dockerEnv } from '../harness/lib/nanoclaw.mjs';
import { metadataChecks } from '../harness/scenarios/_shared.mjs';
import { runExitCode } from '../harness/lib/checks.mjs';

describe('NanoClaw evidence', () => {
  it('correlates delivered messages by inbound id and excludes system actions', () => {
    const rows = [
      { in_reply_to: 'older', kind: 'chat', content: '{"text":"wrong"}' },
      { in_reply_to: 'wanted', kind: 'system', content: '{"text":"action"}' },
      { in_reply_to: 'wanted', kind: 'chat', content: '{"text":"right"}' },
    ];
    expect(selectReply(rows, 'wanted')).toBe('right');
    expect(selectReply(rows, 'absent')).toBe('');
  });
  it('extracts only current-turn MCP calls and pairs errors with their tool use', () => {
    const rows = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: 'mcp__midbrain__memory_search', input: {} }] } },
      { type: 'user', message: { content: 'unique prompt' } },
      { type: 'assistant', sessionId: 'sdk-id', message: { content: [{ type: 'tool_use', id: 'new', name: 'mcp__midbrain__memory_search', input: { query: 'anchor' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'new', is_error: true, content: 'failed' }] } },
    ];
    const parsed = parseTranscript(rows.map(JSON.stringify).join('\n'), 'unique prompt');
    expect(parsed.sessionId).toBe('sdk-id');
    expect(parsed.toolCalls).toEqual([{ id: 'new', name: 'mcp__midbrain__memory_search', input: { query: 'anchor' }, result: 'failed', ok: false }]);
    expect(parseTranscript(rows.map(JSON.stringify).join('\n'), 'missing prompt').toolCalls).toEqual([]);
  });
  it('distinguishes native provider errors from ordinary assistant text', () => {
    const user = { type: 'user', message: { content: 'prompt' } };
    const failure = { type: 'assistant', isApiErrorMessage: true, error: 'billing_error', apiErrorStatus: 400, message: { content: [{ type: 'text', text: 'Credit balance is too low' }] } };
    expect(parseTranscript([user, failure].map(JSON.stringify).join('\n'), 'prompt').providerError).toBe('billing_error (HTTP 400): Credit balance is too low');
    const answer = { type: 'assistant', message: failure.message };
    expect(parseTranscript([user, answer].map(JSON.stringify).join('\n'), 'prompt').providerError).toBeNull();
    expect(parseTranscript([user, failure, answer].map(JSON.stringify).join('\n'), 'prompt').providerError).toBeNull();
  });
  it('reports current-turn native hook timeouts without exposing hook commands', () => {
    const timeout = { type: 'attachment', attachment: { type: 'hook_cancelled', hookEvent: 'Stop', timedOut: true, timeoutMs: 30000, command: 'private command' } };
    const user = { type: 'user', message: { content: 'prompt' } };
    expect(parseTranscript([timeout, user].map(JSON.stringify).join('\n'), 'prompt').hookFailures).toEqual([]);
    expect(parseTranscript([user, timeout].map(JSON.stringify).join('\n'), 'prompt').hookFailures).toEqual(['Stop hook timed out after 30 s']);
  });
  it('accepts only the actual container cwd when declared', () => {
    const rows = [{ memory_metadata: { client: 'nanoclaw', cwd: '/workspace/agent', session_id: 'sdk' } }];
    expect(metadataChecks(rows, 'nanoclaw', '/workspace/agent').every(c => c.ok)).toBe(true);
    expect(metadataChecks(rows, 'nanoclaw', '/wrong').every(c => c.ok)).toBe(false);
  });
});

describe('NanoClaw isolation', () => {
  it('keeps agent instructions separate from host projects while preserving their memory binding', async () => {
    const { NanoClawRuntime } = await import('../harness/lib/nanoclaw.mjs');
    const root = mkdtempSync(path.join(os.tmpdir(), 'nano-workspace-'));
    const home = path.join(root, 'home'), project = path.join(home, 'project');
    mkdirSync(path.join(project, '.midbrain'), { recursive: true });
    writeFileSync(path.join(project, 'CLAUDE.md'), 'Host project instructions');
    writeFileSync(path.join(project, '.midbrain/.midbrain-key'), 'project-key');
    const ctx = { dirs: { run: root, home }, secrets: { MIDBRAIN_HARNESS_API_KEY: 'global-key', ANTHROPIC_API_KEY: 'test-provider-key' } };
    const runtime = new NanoClawRuntime(ctx, { mode: 'dev', repoRoot: fileURLToPath(new URL('../', import.meta.url)) });
    mkdirSync(path.join(runtime.root, 'container'), { recursive: true });
    writeFileSync(path.join(runtime.root, 'container/CLAUDE.md'), 'NanoClaw agent instructions');
    const commands = [];
    runtime.oneShot = async args => { commands.push(args); return { stdout: '', stderr: '' }; };
    try {
      const group = await runtime.group(project);
      expect(readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('Host project instructions');
      expect(group.agent).not.toBe(project);
      expect(readFileSync(path.join(group.agent, 'CLAUDE.md'), 'utf8')).toContain('NanoClaw agent instructions');
      expect(group.key).toBe('project-key');
      expect(commands[0].join(' ')).toContain('dst=/home/node/.npm');
      mkdirSync(path.join(group.npm, '_npx'), { recursive: true });
      writeFileSync(path.join(group.npm, '_npx', 'old-package'), 'old');
      writeFileSync(path.join(group.npm, 'keep'), 'cached tarballs');
      runtime.clearNpxCache();
      expect(() => readFileSync(path.join(group.npm, '_npx', 'old-package'))).toThrow();
      expect(readFileSync(path.join(group.npm, 'keep'), 'utf8')).toBe('cached tarballs');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('translates loopback URLs without losing API paths or registry ports', () => {
    expect(containerUrl('http://127.0.0.1:8000/api/')).toBe('http://host.docker.internal:8000/api/');
    expect(containerUrl('https://memory.midbrain.ai')).toBe('https://memory.midbrain.ai/');
  });
  it('rejects mounts outside the run, including symlinks', async () => {
    const { symlinkSync } = await import('node:fs');
    const root = mkdtempSync(path.join(os.tmpdir(), 'nano-mount-'));
    try {
      mkdirSync(path.join(root, 'run'));
      writeFileSync(path.join(root, 'outside'), 'private');
      expect(() => ownedMount(path.join(root, 'run'), path.join(root, 'outside'))).toThrow();
      symlinkSync(path.join(root, 'outside'), path.join(root, 'run', 'escape'));
      expect(() => ownedMount(path.join(root, 'run'), path.join(root, 'run', 'escape'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('Docker control processes do not inherit provider or MidBrain credentials', () => {
    const env = dockerEnv({ PATH: '/bin', HOME: '/host', DOCKER_HOST: 'unix:///docker.sock', ANTHROPIC_API_KEY: 'secret', MIDBRAIN_API_KEY: 'secret' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/host', DOCKER_HOST: 'unix:///docker.sock' });
  });
  it('blocked checks do not fail a run, while failures and isolation violations do', () => {
    expect(runExitCode([{ status: 'PASS' }, { status: 'BLOCKED' }], true)).toBe(0);
    expect(runExitCode([{ status: 'BLOCKED' }], true)).toBe(0);
    expect(runExitCode([{ status: 'FAIL' }, { status: 'BLOCKED' }], true)).toBe(1);
    expect(runExitCode([], true)).toBe(1);
    expect(runExitCode([{ status: 'PASS' }, { status: 'SKIP' }], true)).toBe(1);
    expect(runExitCode([{ status: 'PASS' }], true)).toBe(0);
    expect(runExitCode([{ status: 'PASS' }], false)).toBe(1);
  });
});

describe('shared recall scoring used by NanoClaw', () => {
  it('rejects cross-client recall that retrieves only the reader question', async () => {
    const { default: scenario } = await import('../harness/scenarios/s02-cross-client-recall.mjs');
    const ctx = { dirs: { run: '/tmp/unused', home: os.tmpdir() }, options: { indexGraceMs: 0 }, turns: [], evidenceDir: () => '/tmp/unused', writeJson() {}, subMarker: () => 'MBH-test-writer' };
    const turn = prompt => ({ prompt, finalText: prompt, exitCode: 0, timedOut: false, isError: false, rawPath: '/tmp/unused/turn', toolCalls: [{ name: 'midbrain__memory_search', input: { query: prompt }, result: prompt, ok: true }] });
    const writer = { id: 'claude', displayName: 'Claude', runTurn: async ({ prompt }) => turn(prompt) };
    const reader = { id: 'nanoclaw', displayName: 'NanoClaw', runTurn: async ({ prompt }) => turn(prompt) };
    const api = { waitForRows: async () => ({ rows: [{ role: 'user' }], elapsedMs: 0, polls: 1 }) };
    const cells = await scenario.run({ ctx, api, writer, reader, project: os.tmpdir() });
    expect(cells[0].status).toBe('FAIL');
  });
});

it('uses the most recent prompt boundary when a resumed session repeats a request', () => {
  const rows = [
    { type: 'user', message: { content: 'repeat' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: 'memory_search' }] } },
    { type: 'user', message: { content: 'repeat' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'current', name: 'memory_search' }] } },
  ];
  expect(parseTranscript(rows.map(JSON.stringify).join('\n'), 'repeat').toolCalls.map(c => c.id)).toEqual(['current']);
});

it('removes a run-owned setup container when its Docker command fails', async () => {
  const { NanoClawRuntime } = await import('../harness/lib/nanoclaw.mjs');
  const r = new NanoClawRuntime({ dirs: { home: '/unused' }, secrets: {}, runId: 'test' }, {});
  const calls = [];
  r.docker = async args => { calls.push(args); return { code: args[0] === 'rm' ? 0 : 1, stderr: 'setup failed' }; };
  await expect(r.oneShot(['--entrypoint', 'false', 'test-image'])).rejects.toThrow('setup failed');
  expect(calls[0][0]).toBe('run');
  expect(calls[1]).toEqual(['rm', '-f', calls[0][calls[0].indexOf('--name') + 1]]);
  expect(r.containers.size).toBe(0);
});

it.skipIf(Number(process.versions.node.split('.')[0]) < 24)('round-trips mailbox messages, acknowledgments, and the provider continuation', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createMailbox, enqueue, readMailbox } = await import('../harness/lib/nanoclaw-mailbox.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'nano-mailbox-'));
  try {
    const source = new URL('./fixtures/nanoclaw/', import.meta.url).pathname;
    await createMailbox(root, source, 'session');
    await enqueue(root, 'first', 'session', 'before restart');
    await enqueue(root, 'second', 'session', 'after restart');
    const inbound = new DatabaseSync(path.join(root, 'inbound.db'), { readOnly: true });
    try {
      const rows = inbound.prepare('SELECT * FROM messages_in ORDER BY seq').all();
      expect(rows.map(r => r.id)).toEqual(['first', 'second']);
      expect(rows.every(r => r.thread_id === 'session' && r.trigger === 1)).toBe(true);
      expect(JSON.parse(rows[1].content).text).toBe('after restart');
      expect(inbound.prepare('PRAGMA journal_mode').get().journal_mode).toBe('delete');
    } finally { inbound.close(); }
    const outbound = new DatabaseSync(path.join(root, 'outbound.db'));
    try {
      outbound.prepare('INSERT INTO messages_out(id,seq,in_reply_to,timestamp,kind,content) VALUES(?,?,?,?,?,?)').run('reply', 1, 'second', new Date().toISOString(), 'chat', '{"text":"done"}');
      outbound.prepare('INSERT INTO processing_ack VALUES(?,?,?)').run('second', 'completed', new Date().toISOString());
      outbound.prepare('INSERT INTO session_state VALUES(?,?,?)').run('continuation:claude', 'real-sdk-id', new Date().toISOString());
    } finally { outbound.close(); }
    const result = await readMailbox(root, 'second');
    expect(result.ack).toBe('completed');
    expect(result.continuation).toBe('real-sdk-id');
    expect(selectReply(result.messages, 'second')).toBe('done');
    expect((await readMailbox(root, 'first')).messages).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('recognizes NanoClaw XML-escaped prompt envelopes without changing raw captures', () => {
  const rows = [
    { type: 'user', message: { content: '<message id="2">Echo &quot;this&quot;: &lt;!-- marker --&gt; &amp; done</message>' } },
    { type: 'assistant', sessionId: 'sdk', message: { content: [{ type: 'tool_use', id: 'call', name: 'memory_search' }] } },
  ];
  expect(parseTranscript(rows.map(JSON.stringify).join('\n'), 'Echo "this": <!-- marker --> & done').sessionId).toBe('sdk');
});

it('counts distinct provider replies, not streamed fragments of one reply', () => {
  const reply = (id, text) => ({ type: 'assistant', message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const rows = [reply('old', 'old'), { type: 'user', message: { content: 'current prompt' } },
    reply('one', 'plain'), reply('one', 'plain'), reply('two', '<message>plain</message>')];
  expect(parseTranscript(rows.map(JSON.stringify).join('\n'), 'current prompt').nativeAssistantMessages).toEqual([
    { id: 'one', text: 'plain' }, { id: 'two', text: '<message>plain</message>' },
  ]);
});
