// OpenCode manifest + driver. OpenCode is installed run-locally (npm prefix
// under <run>/tools) so the client version is pinned per run. Sessions run via
// `opencode run --format json`; the authoritative evidence is `opencode export
// <sessionID>` (messages + parts, including tool calls and results).
import path from 'node:path';
import { existsSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnCapture, whichSync } from '../lib/proc.mjs';
import { childEnv } from '../lib/context.mjs';
import { BlockedError } from '../lib/checks.mjs';

const TURN_TIMEOUT_MS = Number(process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS || 300000);
const PKG = 'opencode-ai';

function extractParts(exported) {
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  const toolCalls = [];
  let finalText = '';
  for (const msg of messages) {
    const role = msg?.info?.role || msg?.role;
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];
    if (role !== 'assistant') continue;
    let text = '';
    for (const p of parts) {
      if (p.type === 'tool') {
        const st = p.state || {};
        toolCalls.push({ id: p.id || p.callID, name: p.tool, server: /midbrain/i.test(String(p.tool)) ? 'midbrain-memory' : undefined, input: st.input ?? null, result: st.output ?? st.error ?? null, ok: st.status ? st.status === 'completed' : !st.error });
      } else if (p.type === 'text' && typeof p.text === 'string') {
        text += (text ? '\n' : '') + p.text;
      }
    }
    if (text) finalText = text;
  }
  return { toolCalls, finalText };
}

export default {
  id: 'opencode',
  displayName: 'OpenCode',
  os: ['darwin', 'linux', 'win32'],
  binary: 'opencode',
  install: { kind: 'npm', pkg: PKG, get version() { return process.env.MIDBRAIN_HARNESS_OPENCODE_VERSION || 'latest'; }, hint: 'installed run-locally into <run>/tools' },
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  // OpenCode creates opencode.jsonc itself on first run; pre-creating it keeps the
  // installer and the client on the same file.
  detectionFixtures: [{ path: '.config/opencode/opencode.jsonc', content: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' }],
  configShape: ['~/.config/opencode/opencode.jsonc#mcp', '~/.config/opencode/plugins/midbrain-memory.ts', '~/.config/opencode/plugins/midbrain-shared.mjs', '~/.config/opencode/plugins/.midbrain-repo-root', '~/.config/opencode/AGENTS.md'],
  mechanism: 'Bun/TS plugin in ~/.config/opencode/plugins (chat.message→user, message.updated→assistant, in-process); MCP entry under "mcp" in opencode.jsonc',
  expectedCaptureLabel: 'opencode',
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: false, sessionResume: true, deferredTools: true },
  knownExceptions: [
    'Capture plugin runs inside the OpenCode process, separate from the MCP server; capture is fire-and-forget.',
    'Dev-mode installs (--dev) intentionally disable OpenCode plugin self-repair; use registry mode to test repair.',
    'Wrong config key (mcpServers instead of mcp) fails silently; the installer normalizes it.',
  ],
  specific: ['plugin-process-separation'],

  clientEnv(ctx) {
    return childEnv(ctx, { ANTHROPIC_API_KEY: ctx.secrets.ANTHROPIC_API_KEY, OPENAI_API_KEY: ctx.secrets.OPENAI_API_KEY });
  },

  async ensureInstalled(ctx) {
    const bin = path.join(ctx.dirs.toolsBin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    if (existsSync(bin)) return bin;
    const prefix = path.join(ctx.dirs.tools, 'opencode');
    mkdirSync(prefix, { recursive: true });
    const spec = `${PKG}@${this.install.version}`;
    const r = await spawnCapture('npm', ['install', '--prefix', prefix, spec, '--no-audit', '--no-fund', '--no-package-lock'], { cwd: prefix, env: { ...process.env, NO_COLOR: '1' }, timeoutMs: 300000 });
    if (r.code !== 0) throw new BlockedError(`run-local install of ${spec} failed: ${r.stderr.trim().slice(-300)}`);
    const installed = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    if (!existsSync(installed)) throw new BlockedError(`${spec} installed but no opencode binary at ${installed}`);
    mkdirSync(ctx.dirs.toolsBin, { recursive: true });
    rmSync(bin, { force: true });
    symlinkSync(installed, bin);
    return bin;
  },

  async preflight(ctx, { doctor = false } = {}) {
    if (doctor) { if (!whichSync('npm')) throw new BlockedError('npm not on PATH (needed for the run-local opencode-ai install)'); return; }
    await this.ensureInstalled(ctx);
  },

  async version(ctx) {
    const r = await spawnCapture('opencode', ['--version'], { env: this.clientEnv(ctx), timeoutMs: 60000 });
    return r.stdout.trim().split('\n').pop() || null;
  },

  async mcpList(ctx) {
    const r = await spawnCapture('opencode', ['mcp', 'list'], { cwd: ctx.dirs.run, env: this.clientEnv(ctx), timeoutMs: 120000 });
    return { code: r.code, text: `${r.stdout}\n${r.stderr}`.trim() };
  },

  async runTurn({ ctx, project, prompt, sessionId, resume = false, evidenceDir, label = 'turn' }) {
    const args = ['run', '--format', 'json', '--dir', project];
    if (resume && sessionId) args.push('-s', sessionId);
    const model = (process.env.MIDBRAIN_HARNESS_OPENCODE_MODEL || '').trim();
    if (model) args.push('-m', model);
    args.push(prompt);
    const rawPath = path.join(evidenceDir, `${label}.ndjson`);
    const turn = {
      client: 'opencode', sessionId: sessionId || null, prompt, finalText: '', toolCalls: [], init: null,
      exitCode: null, durationMs: 0, rawPath, stderr: '', isError: false, timedOut: false,
    };
    let streamText = '';
    const r = await spawnCapture('opencode', args, {
      cwd: project,
      env: this.clientEnv(ctx),
      timeoutMs: TURN_TIMEOUT_MS,
      stdoutFile: rawPath,
      onStdoutLine: (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        const sid = ev.sessionID || ev.properties?.sessionID || ev.properties?.info?.sessionID || ev.part?.sessionID;
        if (sid && !turn.sessionId) turn.sessionId = sid;
        if (ev.type === 'error') { turn.isError = true; turn.errorDetail = JSON.stringify(ev.error || ev).slice(0, 500); }
        if (ev.type === 'text' && typeof ev.part?.text === 'string') streamText += ev.part.text;
      },
    });
    turn.exitCode = r.code;
    turn.durationMs = r.durationMs;
    turn.stderr = r.stderr.slice(-4000);
    turn.timedOut = r.timedOut;
    if (turn.sessionId) {
      const exp = await spawnCapture('opencode', ['export', turn.sessionId], { cwd: project, env: this.clientEnv(ctx), timeoutMs: 60000 });
      if (exp.code === 0 && exp.stdout.trim()) {
        const exportPath = path.join(evidenceDir, `${label}.export.json`);
        writeFileSync(exportPath, exp.stdout);
        turn.exportPath = exportPath;
        try {
          const parsed = extractParts(JSON.parse(exp.stdout));
          turn.toolCalls = parsed.toolCalls;
          turn.finalText = parsed.finalText || streamText;
        } catch (e) {
          turn.exportError = e.message;
          turn.finalText = streamText;
        }
      } else {
        turn.exportError = exp.stderr.trim().slice(-300);
        turn.finalText = streamText;
      }
    } else {
      turn.finalText = streamText;
    }
    return turn;
  },

  async evidence(ctx, destDir) {
    const db = path.join(ctx.dirs.home, '.local', 'share', 'opencode', 'opencode.db');
    if (existsSync(db)) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(path.join(destDir, 'opencode.db'), readFileSync(db));
      return [{ name: 'opencode sqlite db', count: 1 }];
    }
    return [];
  },
};
