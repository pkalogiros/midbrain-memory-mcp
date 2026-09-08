// Claude Code manifest + headless driver (claude -p … --output-format stream-json).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnCapture, whichSync } from '../lib/proc.mjs';
import { childEnv } from '../lib/context.mjs';
import { BlockedError } from '../lib/checks.mjs';
import { copyTree } from '../lib/evidence.mjs';
import { sleep } from '../lib/api.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const TURN_TIMEOUT_MS = Number(process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS || 300000);

export default {
  id: 'claude',
  displayName: 'Claude Code',
  os: ['darwin', 'linux', 'win32'],
  binary: 'claude',
  install: { kind: 'preinstalled', hint: 'npm i -g @anthropic-ai/claude-code' },
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  detectionFixtures: [{ path: '.claude/settings.json', content: '{}\n' }],
  configShape: ['~/.claude.json#mcpServers', '~/.claude/settings.json#hooks', '~/.claude/CLAUDE.md', '~/.midbrain/bin/claude-hook'],
  mechanism: 'settings.json hooks UserPromptSubmit→user, Stop→assistant (async, 30 s) via ~/.midbrain/bin/claude-hook; MCP entry in ~/.claude.json mcpServers',
  expectedCaptureLabel: 'claude',
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: false, sessionResume: true, deferredTools: true },
  knownExceptions: [
    'No PostToolUse capture for Claude Code (tool events are captured for Codex only).',
    'Opening user message can be processed before startup self-repair replaces a historical shim (v0.4.10 notes).',
    'MCP tool schemas may be deferred; the agent must ToolSearch for memory_search before calling it.',
  ],
  specific: ['cold-first-turn', 'self-repair-smoke'],

  clientEnv(ctx) {
    return childEnv(ctx, { ANTHROPIC_API_KEY: ctx.secrets.ANTHROPIC_API_KEY });
  },

  async preflight() {
    if (!whichSync('claude')) throw new BlockedError('claude binary not found on PATH');
  },

  async version(ctx) {
    const r = await spawnCapture('claude', ['--version'], { env: this.clientEnv(ctx), timeoutMs: 30000 });
    return r.stdout.trim().split('\n')[0] || null;
  },

  async runTurn({ ctx, project, prompt, sessionId, resume = false, evidenceDir, label = 'turn' }) {
    const sid = sessionId || randomUUID();
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    args.push(resume ? '--resume' : '--session-id', sid);
    const model = (process.env.MIDBRAIN_HARNESS_CLAUDE_MODEL || '').trim();
    if (model) args.push('--model', model);
    const rawPath = path.join(evidenceDir, `${label}.ndjson`);
    const startedAt = new Date().toISOString();
    const turn = {
      client: 'claude', sessionId: sid, prompt, finalText: '', toolCalls: [], init: null,
      exitCode: null, durationMs: 0, rawPath, stderr: '', isError: false, timedOut: false, startedAt, stopHook: null,
    };
    const byId = new Map();
    const r = await spawnCapture('claude', args, {
      cwd: project,
      env: this.clientEnv(ctx),
      timeoutMs: TURN_TIMEOUT_MS,
      stdoutFile: rawPath,
      onStdoutLine: (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'system' && ev.subtype === 'init') {
          turn.init = { mcpServers: ev.mcp_servers || [], tools: ev.tools || [], model: ev.model || null, sessionId: ev.session_id || null };
        } else if (ev.type === 'assistant') {
          for (const b of ev.message?.content || []) {
            if (b.type === 'tool_use') {
              const call = { id: b.id, name: b.name, input: b.input, result: null, ok: null };
              byId.set(b.id, call);
              turn.toolCalls.push(call);
            }
          }
        } else if (ev.type === 'user') {
          for (const b of ev.message?.content || []) {
            if (b.type === 'tool_result') {
              const call = byId.get(b.tool_use_id);
              if (call) {
                call.result = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : (b.content ?? '');
                call.ok = !b.is_error;
              }
            }
          }
        } else if (ev.type === 'result') {
          turn.finalText = String(ev.result ?? '');
          turn.isError = Boolean(ev.is_error);
          if (ev.session_id) turn.sessionId = ev.session_id;
          turn.cost = ev.total_cost_usd ?? null;
          turn.numTurns = ev.num_turns ?? null;
        }
      },
    });
    turn.exitCode = r.code;
    turn.durationMs = r.durationMs;
    turn.stderr = r.stderr.slice(-4000);
    turn.timedOut = r.timedOut;
    if (turn.exitCode === 0 && !turn.timedOut && !turn.isError && turn.finalText.trim()) {
      await this.completeStopCapture({ ctx, turn, project });
    }
    return turn;
  },

  // `claude -p` exits before the product's async Stop hook completes its capture
  // POST, so the assistant turn is lost in headless one-shot mode (it works in
  // interactive sessions, where the process stays alive). Replay the product's
  // OWN installed Stop hook from the real transcript when it did not run — same
  // shim, same capture-assistant.mjs, same API. Skipped if the async hook did
  // complete, so no duplicate is created.
  async completeStopCapture({ ctx, turn, project }) {
    const logFile = path.join(ctx.dirs.logs, 'midbrain-claude.log');
    const assistantStoredSince = () => {
      try {
        return readFileSync(logFile, 'utf8').split('\n').some((l) => /role=assistant/.test(l) && l.slice(1, 25) >= turn.startedAt);
      } catch { return false; }
    };
    await sleep(2000);
    if (assistantStoredSince()) { turn.stopHook = 'async-completed'; return; }
    const shimName = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook';
    const shim = path.join(ctx.dirs.home, '.midbrain', 'bin', shimName);
    const transcript = this.findTranscript(ctx, turn.sessionId);
    if (!existsSync(shim) || !transcript) { turn.stopHook = `not-replayed (${!existsSync(shim) ? 'no shim' : 'no transcript'})`; return; }
    const payload = JSON.stringify({ last_assistant_message: turn.finalText, transcript_path: transcript, session_id: turn.sessionId, cwd: project, hook_event_name: 'Stop', stop_hook_active: false });
    const cmd = process.platform === 'win32' ? shim : '/bin/sh';
    const args = process.platform === 'win32' ? ['assistant'] : [shim, 'assistant'];
    const r = await spawnCapture(cmd, args, { cwd: project, env: this.clientEnv(ctx), input: payload, timeoutMs: 60000 });
    turn.stopHook = r.code === 0 ? 'replayed' : `replay-failed:${r.code}`;
    if (r.code !== 0) turn.stopHookStderr = r.stderr.slice(-300);
  },

  findTranscript(ctx, sessionId) {
    const root = path.join(ctx.dirs.home, '.claude', 'projects');
    if (!existsSync(root)) return null;
    for (const dir of readdirSync(root)) {
      const f = path.join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(f)) return f;
    }
    return null;
  },

  async evidence(ctx, destDir) {
    const n = copyTree(path.join(ctx.dirs.home, '.claude', 'projects'), path.join(destDir, 'claude-transcripts'), (p) => p.endsWith('.jsonl'));
    return [{ name: 'claude transcripts', count: n }];
  },
};
