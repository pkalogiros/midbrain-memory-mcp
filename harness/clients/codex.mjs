// Codex manifest + headless driver (codex exec --json …).
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { spawnCapture, whichSync } from '../lib/proc.mjs';
import { childEnv } from '../lib/context.mjs';
import { BlockedError } from '../lib/checks.mjs';
import { copyTree } from '../lib/evidence.mjs';

const TURN_TIMEOUT_MS = Number(process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS || 300000);

// MCP tool results arrive as {content:[{type:'text',text}],structured_content}; flatten to
// readable text so raw-evidence checks and the report see the actual content, not [object Object].
function mcpResultText(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    const t = result.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n').trim();
    if (t) return t;
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}

export default {
  id: 'codex',
  displayName: 'Codex',
  os: ['darwin', 'linux', 'win32'],
  binary: 'codex',
  install: { kind: 'preinstalled', hint: 'npm i -g @openai/codex' },
  // Read at call time, not import time: the harness loads .env after this module is imported.
  get authMode() { return (process.env.MIDBRAIN_HARNESS_CODEX_AUTH || 'apikey').toLowerCase(); }, // 'chatgpt' reuses your real ~/.codex login; 'apikey' uses OPENAI_API_KEY
  get requiredSecrets() { return this.authMode === 'chatgpt' ? [] : ['OPENAI_API_KEY']; },
  hostAuthPath() { return path.join(os.homedir(), '.codex', 'auth.json'); },
  detectionFixtures: [{ path: '.codex/.harness-keep', content: '' }],
  configShape: ['~/.codex/config.toml#mcp_servers', '~/.codex/hooks.json', '~/.codex/AGENTS.md', '~/.midbrain/bin/codex-hook'],
  mechanism: 'hooks.json UserPromptSubmit→user, PostToolUse→tool, Stop→assistant (10 s) via ~/.midbrain/bin/codex-hook; MCP entry in ~/.codex/config.toml [mcp_servers."midbrain-memory"]; features.hooks=true',
  expectedCaptureLabel: 'codex',
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: true, sessionResume: true, deferredTools: true },
  knownExceptions: [
    'Codex trusts command hooks by definition; a fresh home has no persisted hook trust, so the harness passes --dangerously-bypass-hook-trust by default and tests persisted trust as a separate client-specific cell.',
    'Tool events are posted as assistant-role "Tool activity summary" text, not a distinct role.',
    'Exec in an untrusted directory changes approval defaults; the harness seeds trust for its project directories.',
    'Auth comes from ~/.codex/auth.json, not OPENAI_API_KEY; the harness either copies your ChatGPT login (MIDBRAIN_HARNESS_CODEX_AUTH=chatgpt) or runs codex login --with-api-key.',
    'codex exec approval policy is never, which auto-denies MCP tool calls; the harness bypasses exec approvals so recall (memory_search) can run headlessly.',
  ],
  options: { hookTrust: 'bypass', trustProjects: true },
  specific: ['self-repair-smoke', 'hook-trust-persisted'],

  clientEnv(ctx) {
    return childEnv(ctx, this.authMode === 'chatgpt' ? {} : { OPENAI_API_KEY: ctx.secrets.OPENAI_API_KEY });
  },

  async preflight() {
    if (!whichSync('codex')) throw new BlockedError('codex binary not found on PATH');
    if (this.authMode === 'chatgpt') {
      const p = this.hostAuthPath();
      if (!existsSync(p)) throw new BlockedError(`codex chatgpt-auth reuse selected but ${p} not found — run 'codex login' once, or set MIDBRAIN_HARNESS_CODEX_AUTH=apikey`);
      try {
        const auth = JSON.parse(readFileSync(p, 'utf8'));
        if (!auth.tokens && !auth.OPENAI_API_KEY) throw new Error('no tokens');
      } catch (e) { throw new BlockedError(`codex host auth.json unreadable/empty (${e.message}); run 'codex login'`); }
    }
  },

  async version(ctx) {
    const r = await spawnCapture('codex', ['--version'], { env: this.clientEnv(ctx), timeoutMs: 30000 });
    return r.stdout.trim().split('\n')[0] || null;
  },

  // Codex authenticates from $CODEX_HOME/auth.json, not the OPENAI_API_KEY env
  // var, so a throwaway home must be logged in first (env-key alone → 401 on the
  // websocket /v1/responses path). `codex login --with-api-key` reads the key
  // from stdin and writes auth.json with auth_mode=apikey.
  async seedAuth(ctx) {
    const codexHome = path.join(ctx.dirs.home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    if (this.authMode === 'chatgpt') {
      // Copy your real ChatGPT login into the throwaway home so Codex bills your
      // Codex/ChatGPT plan, not the API platform. Codex refreshes tokens into
      // this copy, never touching your real ~/.codex/auth.json.
      copyFileSync(this.hostAuthPath(), path.join(codexHome, 'auth.json'));
      return { code: 0, mode: 'chatgpt' };
    }
    return spawnCapture('codex', ['login', '--with-api-key'], {
      env: this.clientEnv(ctx),
      input: `${ctx.secrets.OPENAI_API_KEY}\n`,
      timeoutMs: 60000,
    });
  },

  async mcpList(ctx) {
    const r = await spawnCapture('codex', ['mcp', 'list', '--json'], { cwd: ctx.dirs.run, env: this.clientEnv(ctx), timeoutMs: 60000 });
    let connected;
    try {
      const j = JSON.parse(r.stdout);
      const arr = Array.isArray(j) ? j : (j.servers || Object.values(j));
      connected = arr.some((sv) => /midbrain/i.test(String(sv.name || '')) && sv.enabled !== false && !sv.disabled_reason);
    } catch {
      // text form: a "midbrain-memory … enabled" row
      connected = r.stdout.split('\n').some((l) => /midbrain-memory/i.test(l) && /\benabled\b/i.test(l));
    }
    return { code: r.code, connected, text: `${r.stdout}\n${r.stderr}`.trim().slice(0, 400) };
  },

  async afterInstall(ctx, { projects }) {
    await this.seedAuth(ctx);
    if (!this.options.trustProjects) return;
    const cfg = path.join(ctx.dirs.home, '.codex', 'config.toml');
    let text = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
    for (const dir of projects) {
      const header = `[projects."${dir}"]`;
      if (text.includes(header)) continue;
      text += `\n${header}\ntrust_level = "trusted"\n`;
    }
    writeFileSync(cfg, text);
  },

  async approveHooks(ctx, project) {
    if (!ctx.options.interactive || !process.stdin.isTTY) return null;
    console.error('Approve only the three MidBrain hooks in /hooks, then exit Codex with /quit. The next turn verifies persisted approval without a bypass.');
    const args = ['--no-alt-screen', '-C', project];
    const model = (process.env.MIDBRAIN_HARNESS_CODEX_MODEL || '').trim();
    if (model) args.push('-m', model);
    return new Promise((resolve, reject) => {
      const child = spawn('codex', args, { cwd: project, env: { ...this.clientEnv(ctx), TERM: 'xterm-256color' }, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
  },

  async runTurn({ ctx, project, prompt, sessionId, resume = false, evidenceDir, label = 'turn', hookTrust }) {
    const trust = hookTrust || this.options.hookTrust;
    const lastMsg = path.join(evidenceDir, `${label}.last.txt`);
    const args = ['exec'];
    if (resume && sessionId) args.push('resume', sessionId);
    // Autonomous exec: without this, approval policy 'never' auto-denies MCP tool
    // calls (memory_search), so recall fails though capture (hooks) works.
    args.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-o', lastMsg);
    if (!resume) args.push('-C', project);
    if (trust === 'bypass') args.push('--dangerously-bypass-hook-trust');
    const model = (process.env.MIDBRAIN_HARNESS_CODEX_MODEL || '').trim();
    if (model) args.push('-m', model);
    args.push(prompt);
    const rawPath = path.join(evidenceDir, `${label}.ndjson`);
    const turn = {
      client: 'codex', sessionId: sessionId || null, prompt, finalText: '', toolCalls: [], init: null,
      exitCode: null, durationMs: 0, rawPath, stderr: '', isError: false, timedOut: false, hookTrust: trust,
    };
    const r = await spawnCapture('codex', args, {
      cwd: project,
      env: this.clientEnv(ctx),
      timeoutMs: TURN_TIMEOUT_MS,
      stdoutFile: rawPath,
      onStdoutLine: (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'thread.started' && ev.thread_id) {
          turn.sessionId = ev.thread_id;
        } else if (ev.type === 'item.completed') {
          const it = ev.item || {};
          if (it.type === 'mcp_tool_call') {
            turn.toolCalls.push({
              id: it.id, name: `${it.server}__${it.tool}`, server: it.server, input: it.arguments,
              result: mcpResultText(it.result ?? it.error), ok: it.status ? it.status === 'completed' : !it.error,
            });
          } else if (it.type === 'command_execution') {
            turn.toolCalls.push({ id: it.id, name: 'command_execution', input: it.command, result: it.aggregated_output ?? null, ok: it.exit_code === 0 });
          } else if (it.type === 'file_change' || it.type === 'web_search') {
            turn.toolCalls.push({ id: it.id, name: it.type, input: it, result: null, ok: true });
          } else if (it.type === 'agent_message') {
            turn.finalText = String(it.text ?? '');
          }
        } else if (ev.type === 'turn.failed' || ev.type === 'error') {
          turn.isError = true;
          turn.errorDetail = JSON.stringify(ev).slice(0, 500);
        }
      },
    });
    if (!turn.finalText && existsSync(lastMsg)) turn.finalText = readFileSync(lastMsg, 'utf8');
    turn.exitCode = r.code;
    turn.durationMs = r.durationMs;
    turn.stderr = r.stderr.slice(-4000);
    turn.timedOut = r.timedOut;
    return turn;
  },

  async evidence(ctx, destDir) {
    const a = copyTree(path.join(ctx.dirs.tmp, 'midbrain-codex-assistant-turns'), path.join(destDir, 'codex-assistant-turns'));
    const t = copyTree(path.join(ctx.dirs.tmp, 'midbrain-codex-tool-events'), path.join(destDir, 'codex-tool-events'));
    const s = copyTree(path.join(ctx.dirs.home, '.codex', 'sessions'), path.join(destDir, 'codex-sessions'), (p) => p.endsWith('.jsonl'));
    return [{ name: 'codex assistant turn receipts', count: a }, { name: 'codex tool events', count: t }, { name: 'codex session rollouts', count: s }];
  },
};
