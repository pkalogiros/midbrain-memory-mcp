// Unit coverage for the behavioral harness's pure logic (harness/lib). No
// credential writers, no network, no client processes.
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { complianceChecks, forbiddenHits, statusFromChecks, check, isMidbrainTool } from '../harness/lib/checks.mjs';
import { hashSurface, diff, extraSurfaces } from '../harness/lib/tripwire.mjs';
import { buildMatrix, worst, renderMarkdown, ROWS } from '../harness/lib/report.mjs';
import { copyTree } from '../harness/lib/evidence.mjs';
import { childEnv } from '../harness/lib/context.mjs';
import { loadDotEnv } from '../harness/lib/env.mjs';

const turn = (calls, finalText = '') => ({ toolCalls: calls, finalText });
const call = (name, input, result = 'ok result with content', extra = {}) => ({ name, input, result, ok: true, ...extra });

describe('harness checks', () => {
  it('memory-first compliance passes when the first call is a MidBrain search carrying the marker', () => {
    const t = turn([call('mcp__midbrain-memory__memory_search', { query: 'MBH-AAAAAA-claude-x', limit: 10 })]);
    const checks = complianceChecks(t, 'MBH-AAAAAA-claude-x');
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('memory-first compliance accepts ToolSearch discovery before the memory call', () => {
    const t = turn([call('ToolSearch', { query: 'memory_search' }), call('mcp__midbrain-memory__memory_search', { query: 'MBH-1' })]);
    expect(complianceChecks(t, 'MBH-1')[0].ok).toBe(true);
  });

  it('flags a shell call before recall and a missing anchor', () => {
    const t = turn([call('Bash', { command: 'ls' }), call('mcp__midbrain-memory__memory_search', { query: 'something else' })]);
    const [first, anchor] = complianceChecks(t, 'MBH-2');
    expect(first.ok).toBe(false);
    expect(anchor.ok).toBe(false);
  });

  it('requires a wider or different search after an empty result', () => {
    const empty = call('mcp__midbrain-memory__memory_search', { query: 'MBH-3', limit: 10 }, 'No results found.');
    const narrowAgain = call('mcp__midbrain-memory__memory_search', { query: 'MBH-3', limit: 10 }, 'No results found.');
    const wider = call('mcp__midbrain-memory__memory_search', { query: 'MBH-3', limit: 50 }, 'found MBH-3');
    expect(complianceChecks(turn([empty, narrowAgain]), 'MBH-3')[2].ok).toBe(false);
    expect(complianceChecks(turn([empty, wider]), 'MBH-3')[2].ok).toBe(true);
    const grep = call('mcp__midbrain-memory__grep', { pattern: 'MBH-3' }, 'found');
    expect(complianceChecks(turn([empty, grep]), 'MBH-3')[2].ok).toBe(true);
  });

  it('recognises Codex mcp_tool_call names and servers as MidBrain tools', () => {
    expect(isMidbrainTool({ name: 'midbrain-memory__memory_search', server: 'midbrain-memory' })).toBe(true);
    expect(isMidbrainTool({ name: 'command_execution' })).toBe(false);
  });

  it('no-match forbidden phrases catch process language and markers', () => {
    expect(forbiddenHits('Canberra is the capital of Australia.')).toEqual([]);
    expect(forbiddenHits('I searched MidBrain memory and found nothing.').length).toBeGreaterThan(0);
    expect(forbiddenHits('Result: not found after search').length).toBeGreaterThan(0);
    expect(forbiddenHits('marker MBH-ABCDEF').length).toBeGreaterThan(0);
  });

  it('cell status is PASS only when every check passes', () => {
    expect(statusFromChecks([check('a', true), check('b', true)])).toBe('PASS');
    expect(statusFromChecks([check('a', true), check('b', false)])).toBe('FAIL');
    expect(statusFromChecks([])).toBe('BLOCKED');
  });
});

describe('harness tripwire semantics', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-tripwire-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  it('ignores non-MidBrain churn in ~/.claude.json but catches mcpServers changes', () => {
    const file = path.join(home, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ numStartups: 1, projects: { '/a': { allowedTools: [] } } }));
    const h1 = hashSurface(file, home);
    fs.writeFileSync(file, JSON.stringify({ numStartups: 2, projects: { '/a': { allowedTools: ['Bash'] }, '/b': {} } }));
    const h2 = hashSurface(file, home);
    expect(h1).toBe(h2);
    fs.writeFileSync(file, JSON.stringify({ numStartups: 2, mcpServers: { 'midbrain-memory': { command: 'npx' } } }));
    expect(hashSurface(file, home)).not.toBe(h1);
    fs.writeFileSync(file, JSON.stringify({ projects: { '/a': { mcpServers: { 'midbrain-memory': {} } } } }));
    expect(hashSurface(file, home)).not.toBe(h1);
  });

  it('compares ~/.claude/settings.json on hooks and permissions only', () => {
    const file = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: {} }));
    const h1 = hashSurface(file, home);
    fs.writeFileSync(file, JSON.stringify({ theme: 'light', hooks: {} }));
    expect(hashSurface(file, home)).toBe(h1);
    fs.writeFileSync(file, JSON.stringify({ theme: 'light', hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } }));
    expect(hashSurface(file, home)).not.toBe(h1);
  });

  it('reports ABSENT/DIR and diffs creation as drift', () => {
    expect(hashSurface(path.join(home, 'nope'), home)).toBe('ABSENT');
    expect(hashSurface(path.join(home, '.claude'), home)).toBe('DIR');
    const before = { hashes: { [path.join(home, 'k')]: 'ABSENT' } };
    const after = { hashes: { [path.join(home, 'k')]: 'raw:abc' } };
    expect(diff(before, after)).toHaveLength(1);
    expect(diff(before, before)).toEqual([]);
  });

  it('adds live-client surfaces under the given home', () => {
    const extra = extraSurfaces(home);
    expect(extra.some((p) => p.endsWith(path.join('.claude', '.credentials.json')))).toBe(true);
    expect(extra.every((p) => p.startsWith(home))).toBe(true);
  });
});

describe('harness report', () => {
  it('aggregates the worst status per row and renders the matrix', () => {
    expect(worst(['PASS', 'BLOCKED'])).toBe('BLOCKED');
    expect(worst(['PASS', 'FAIL', 'BLOCKED'])).toBe('FAIL');
    expect(worst(['SKIP', 'PASS'])).toBe('PASS');
    const cells = [
      { row: 'User capture', client: 'claude', status: 'PASS' },
      { row: 'User capture', client: 'claude', status: 'FAIL' },
      { row: 'User capture', client: 'codex', status: 'PASS' },
    ];
    const m = buildMatrix(cells, ['claude', 'codex']);
    expect(m['User capture'].claude).toBe('FAIL');
    expect(m['User capture'].codex).toBe('PASS');
    expect(m['Metadata'].claude).toBeNull();
    const md = renderMarkdown({
      run: { runId: 'r1', platform: 'darwin', arch: 'arm64', osRelease: '24', node: 'v24', marker: 'MBH-X', startedAt: 's', finishedAt: 'f', readbackTimeoutMs: 1, indexGraceMs: 2 },
      candidate: { name: 'p', version: '0.0.0', shortSha: 'abc1234', dirty: false, mode: 'dev', branch: 'main', pack: { filename: 'p.tgz', entryCount: 3, integrity: 'sha512-x' } },
      clients: [{ id: 'claude', displayName: 'Claude Code', runnable: true, knownExceptions: [], configShape: {} }, { id: 'codex', displayName: 'Codex', runnable: false, blockedReason: 'no key', knownExceptions: [] }],
      cells: cells.map((c) => ({ ...c, scenario: 's', checks: [check('x', c.status === 'PASS')], evidence: [] })),
      isolation: { ok: true, drift: [] },
    });
    expect(md).toContain('| Check | Claude Code | Codex |');
    for (const row of ROWS) expect(md).toContain(`| ${row} |`);
    expect(md).toContain('❌ FAIL');
  });
});

describe('harness child environment', () => {
  it('never leaks host MidBrain/provider/CI variables and pins the throwaway home', () => {
    const saved = { ...process.env };
    try {
      process.env.MIDBRAIN_API_KEY = 'leak';
      process.env.ANTHROPIC_API_KEY = 'leak';
      process.env.OPENAI_API_KEY = 'leak';
      process.env.CLAUDECODE = '1';
      process.env.CI = 'true';
      process.env.VITEST = 'true';
      const ctx = { dirs: { home: '/h', tmp: '/h/tmp', logs: '/h/logs', toolsBin: '/h/tools/bin' } };
      const env = childEnv(ctx, { ANTHROPIC_API_KEY: 'only-this' });
      expect(env.HOME).toBe('/h');
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined(); // aligned with the product's $HOME/.claude.json MCP config
      expect(env.CODEX_HOME).toBe(path.join('/h', '.codex'));
      expect(env.TMPDIR).toBe('/h/tmp');
      expect(env.MIDBRAIN_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CI).toBeUndefined();
      expect(env.VITEST).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe('only-this');
      expect(env.PATH.startsWith('/h/tools/bin')).toBe(true);
      expect(env.npm_config_registry).toBeUndefined();
      expect(childEnv({ ...ctx, registry: { url: 'http://127.0.0.1:1/' } }).npm_config_registry).toBe('http://127.0.0.1:1/');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('harness .env loader', () => {
  it('loads KEY=VALUE lines without overriding existing variables', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-env-'));
    const file = path.join(tmp, '.env');
    fs.writeFileSync(file, '# comment\nHARNESS_T_A="quoted"\nexport HARNESS_T_B=plain\nHARNESS_T_C=\n');
    process.env.HARNESS_T_B = 'preset';
    try {
      const loaded = loadDotEnv(file);
      expect(process.env.HARNESS_T_A).toBe('quoted');
      expect(process.env.HARNESS_T_B).toBe('preset');
      expect(loaded).toContain('HARNESS_T_A');
      expect(loaded).not.toContain('HARNESS_T_B');
    } finally {
      delete process.env.HARNESS_T_A; delete process.env.HARNESS_T_B; delete process.env.HARNESS_T_C;
    }
  });
});


it('collects regular evidence without following file, directory or root symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-evidence-links-'));
  try {
    const source = path.join(root, 'sessions');
    fs.mkdirSync(source);
    fs.mkdirSync(path.join(root, 'outside'));
    fs.writeFileSync(path.join(root, 'outside', 'private.json'), 'synthetic private fixture');
    fs.writeFileSync(path.join(source, 'turn.json'), '{}');
    fs.symlinkSync(path.join(root, 'outside', 'private.json'), path.join(source, 'linked.json'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(source, 'linked-dir'), 'dir');
    fs.symlinkSync(source, path.join(root, 'linked-root'), 'dir');
    expect(copyTree(source, path.join(root, 'collected'))).toBe(1);
    expect(fs.readdirSync(path.join(root, 'collected'))).toEqual(['turn.json']);
    expect(copyTree(path.join(root, 'linked-root'), path.join(root, 'other'))).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
