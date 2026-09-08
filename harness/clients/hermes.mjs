// Hermes Agent manifest + driver. Installed run-locally with `uv tool install`
// (UV_TOOL_DIR under <run>/tools). Sessions run via `hermes chat -q … -Q`.
// Hook consent is Hermes' client-specific case: the installer never enables
// hooks_auto_accept, so the default run sets HERMES_ACCEPT_HOOKS=1 (the
// documented non-interactive path) and S10 runs one turn without it.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnCapture, whichSync } from '../lib/proc.mjs';
import { childEnv } from '../lib/context.mjs';
import { BlockedError } from '../lib/checks.mjs';

const TURN_TIMEOUT_MS = Number(process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS || 300000);
const PKG = 'hermes-agent';
const SESSION_RE = /\b(session[_ -]?id|session)\b[^A-Za-z0-9_-]{0,6}([A-Za-z0-9_-]{8,})/i;

function parseSessionExport(jsonl) {
  const toolCalls = [];
  let finalText = '';
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const role = row.role || row.type;
    if (role === 'assistant' || role === 'ai') {
      const calls = row.tool_calls || row.toolCalls || [];
      for (const c of calls) {
        const fn = c.function || c;
        let input = fn.arguments ?? fn.input ?? null;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* keep string */ } }
        toolCalls.push({ id: c.id, name: fn.name || c.name, input, result: null, ok: null });
      }
      if (typeof row.content === 'string' && row.content.trim()) finalText = row.content;
    } else if (role === 'tool') {
      const target = toolCalls.find((t) => t.id && t.id === (row.tool_call_id || row.toolCallId));
      if (target) { target.result = typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? ''); target.ok = true; }
    }
  }
  return { toolCalls, finalText };
}

export default {
  id: 'hermes',
  displayName: 'Hermes',
  os: ['darwin', 'linux'],
  binary: 'hermes',
  install: { kind: 'uv-tool', pkg: PKG, get version() { return process.env.MIDBRAIN_HARNESS_HERMES_VERSION || ''; }, hint: 'installed run-locally with uv into <run>/tools' },
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  detectionFixtures: [{ path: '.hermes/.harness-keep', content: '' }],
  configShape: ['~/.hermes/config.yaml#hooks', '~/.hermes/config.yaml#mcp_servers', '~/.hermes/SOUL.md', '~/.midbrain/bin/hermes-hook'],
  mechanism: 'config.yaml hooks pre_llm_call→user, post_llm_call→assistant (30 s) via ~/.midbrain/bin/hermes-hook; MCP entry under mcp_servers with MIDBRAIN_PROJECT_DIR=${TERMINAL_CWD}',
  expectedCaptureLabel: 'hermes',
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: false, sessionResume: true, deferredTools: true },
  knownExceptions: [
    'Hermes prompts once per (event, command) pair to approve a shell hook; non-interactive use needs hooks_auto_accept: true or HERMES_ACCEPT_HOOKS=1, which the installer never sets. The harness sets HERMES_ACCEPT_HOOKS=1 by default and tests the unapproved path as a client-specific cell.',
    'A running gateway must be restarted after setup (not applicable to one-shot chat runs).',
    'No transcript file exists; tool-call evidence comes from `hermes sessions export` and the hook log.',
  ],
  get options() { return { provider: process.env.MIDBRAIN_HARNESS_HERMES_PROVIDER || 'anthropic', model: process.env.MIDBRAIN_HARNESS_HERMES_MODEL || 'claude-sonnet-4-5' }; },
  specific: ['hook-acceptance'],

  clientEnv(ctx, { acceptHooks = true } = {}) {
    return childEnv(ctx, {
      ANTHROPIC_API_KEY: ctx.secrets.ANTHROPIC_API_KEY,
      HERMES_ACCEPT_HOOKS: acceptHooks ? '1' : undefined,
      HERMES_INTERACTIVE: '0',
      UV_TOOL_DIR: path.join(ctx.dirs.tools, 'hermes', 'tools'),
      UV_TOOL_BIN_DIR: ctx.dirs.toolsBin,
    });
  },

  async ensureInstalled(ctx) {
    const bin = path.join(ctx.dirs.toolsBin, 'hermes');
    if (existsSync(bin)) return bin;
    if (!whichSync('uv')) throw new BlockedError('uv not found on PATH (needed to install hermes-agent run-locally)');
    const spec = this.install.version ? `${PKG}==${this.install.version}` : PKG;
    const env = { ...process.env, UV_TOOL_DIR: path.join(ctx.dirs.tools, 'hermes', 'tools'), UV_TOOL_BIN_DIR: ctx.dirs.toolsBin, NO_COLOR: '1' };
    mkdirSync(env.UV_TOOL_DIR, { recursive: true });
    const r = await spawnCapture('uv', ['tool', 'install', spec, '--python', '3.12'], { cwd: ctx.dirs.tools, env, timeoutMs: 600000 });
    if (r.code !== 0 || !existsSync(bin)) throw new BlockedError(`run-local install of ${spec} failed: ${r.stderr.trim().slice(-300)}`);
    return bin;
  },

  /** Hermes refuses to start without a provider; seed the model block before the installer patches hooks/mcp. */
  seedConfig(ctx) {
    const dir = path.join(ctx.dirs.home, '.hermes');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.yaml');
    if (existsSync(file) && /^model:/m.test(readFileSync(file, 'utf8'))) return file;
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, `${existing.trimEnd()}${existing ? '\n' : ''}model:\n  provider: ${this.options.provider}\n  default: ${this.options.model}\n`);
    return file;
  },

  async preflight(ctx, { doctor = false } = {}) {
    if (doctor) { if (!whichSync('uv')) throw new BlockedError('uv not on PATH (needed for the run-local hermes-agent install)'); return; }
    await this.ensureInstalled(ctx);
    this.seedConfig(ctx);
  },

  async version(ctx) {
    const python = path.join(ctx.dirs.tools, 'hermes/tools/hermes-agent/bin/python');
    const r = await spawnCapture(python, ['-c', 'from importlib.metadata import version; print(version("hermes-agent"))'], { env: this.clientEnv(ctx), timeoutMs: 30000 });
    return r.code === 0 ? r.stdout.trim() || null : null;
  },

  async hooksList(ctx) {
    const r = await spawnCapture('hermes', ['hooks', 'list'], { cwd: ctx.dirs.run, env: this.clientEnv(ctx, { acceptHooks: false }), timeoutMs: 120000 });
    return `${r.stdout}\n${r.stderr}`.trim();
  },

  async mcpList(ctx) {
    const r = await spawnCapture('hermes', ['mcp', 'list'], { cwd: ctx.dirs.run, env: this.clientEnv(ctx, { acceptHooks: false }), timeoutMs: 120000 });
    return { code: r.code, text: `${r.stdout}\n${r.stderr}`.trim() };
  },

  async runTurn({ ctx, project, prompt, sessionId, resume = false, evidenceDir, label = 'turn', acceptHooks = true }) {
    const args = ['chat', '-q', prompt, '-Q', '--provider', this.options.provider, '-m', this.options.model, '--pass-session-id'];
    if (resume && sessionId) args.push('--resume', sessionId);
    const rawPath = path.join(evidenceDir, `${label}.stdout.txt`);
    const turn = {
      client: 'hermes', sessionId: sessionId || null, prompt, finalText: '', toolCalls: [], init: null,
      exitCode: null, durationMs: 0, rawPath, stderr: '', isError: false, timedOut: false, acceptHooks,
    };
    const env = this.clientEnv(ctx, { acceptHooks });
    const r = await spawnCapture('hermes', args, { cwd: project, env, timeoutMs: TURN_TIMEOUT_MS, stdoutFile: rawPath });
    turn.exitCode = r.code;
    turn.durationMs = r.durationMs;
    turn.stderr = r.stderr.slice(-4000);
    turn.timedOut = r.timedOut;
    turn.finalText = r.stdout.trim();
    const sm = `${r.stdout}\n${r.stderr}`.match(SESSION_RE);
    if (sm) turn.sessionId = sm[2];
    if (!turn.sessionId) {
      const ls = await spawnCapture('hermes', ['sessions', 'list'], { cwd: project, env, timeoutMs: 60000 });
      const first = ls.stdout.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{8,}\s/.test(l));
      if (first) turn.sessionId = first.split(/\s+/)[0];
    }
    if (turn.sessionId) {
      const out = path.join(evidenceDir, `${label}.session.jsonl`);
      const exp = await spawnCapture('hermes', ['sessions', 'export', '--format', 'jsonl', '--session-id', turn.sessionId, '--yes', '--no-redact', out], { cwd: project, env, timeoutMs: 120000 });
      if (exp.code === 0 && existsSync(out)) {
        turn.exportPath = out;
        const parsed = parseSessionExport(readFileSync(out, 'utf8'));
        turn.toolCalls = parsed.toolCalls;
        if (!turn.finalText && parsed.finalText) turn.finalText = parsed.finalText;
      } else {
        turn.exportError = `${exp.stderr}`.trim().slice(-300);
      }
    }
    if (/agent failed|Unknown provider|No LLM provider/i.test(`${r.stdout}\n${r.stderr}`)) turn.isError = true;
    return turn;
  },

  async evidence(ctx, destDir) {
    const out = [];
    for (const f of ['shell-hooks-allowlist.json', 'config.yaml']) {
      const src = path.join(ctx.dirs.home, '.hermes', f);
      if (existsSync(src)) { mkdirSync(destDir, { recursive: true }); writeFileSync(path.join(destDir, f), readFileSync(src)); out.push({ name: f, count: 1 }); }
    }
    return out;
  },
};
