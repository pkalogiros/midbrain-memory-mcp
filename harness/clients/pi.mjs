import path from 'node:path';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnCapture, whichSync } from '../lib/proc.mjs';
import { childEnv } from '../lib/context.mjs';
import { BlockedError } from '../lib/checks.mjs';
import { copyTree } from '../lib/evidence.mjs';

export function piEvent(turn, event) {
  if (event.type === 'session') turn.sessionId = event.id;
  if (event.type === 'tool_execution_start') turn.toolCalls.push({ id: event.toolCallId, name: event.toolName, input: event.args, result: null, ok: null });
  if (event.type === 'tool_execution_end') {
    const call = turn.toolCalls.find(c => c.id === event.toolCallId);
    if (call) { call.result = event.result; call.ok = !event.isError; }
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const message = event.message;
    const text = (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) { turn.finalText = text; turn.nativeAssistantMessages.push({ text }); }
    if (['error', 'aborted'].includes(message.stopReason)) turn.isError = true;
  }
}

export default {
  id: 'pi', displayName: 'Pi', os: ['darwin', 'linux'], binary: 'pi',
  install: { kind: 'npm', pkg: '@earendil-works/pi-coding-agent', get version() { return process.env.MIDBRAIN_HARNESS_PI_VERSION || 'latest'; }, hint: 'installed run-locally' },
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  detectionFixtures: [{ path: '.pi/agent/settings.json', content: '{}\n' }],
  configShape: ['~/.pi/agent/extensions/midbrain-memory/index.ts', '~/.pi/agent/extensions/midbrain-memory/runtime.mjs', '~/.pi/agent/AGENTS.md'],
  mechanism: 'Native message_end capture and MCP tool bridge in the MidBrain Pi extension',
  expectedCaptureLabel: 'pi',
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: false, sessionResume: true, deferredTools: false },
  knownExceptions: ['Opt-in client; releases before this adapter cannot provide an upgrade baseline.'],
  specific: ['cold-first-turn'],
  clientEnv(ctx) { return childEnv(ctx, { ANTHROPIC_API_KEY: ctx.secrets.ANTHROPIC_API_KEY }); },
  async preflight(ctx, { doctor = false } = {}) {
    if (!whichSync('npm')) throw new BlockedError('npm is required to install Pi run-locally');
    if (doctor) return;
    const bin = path.join(ctx.dirs.toolsBin, 'pi');
    if (existsSync(bin)) return;
    const prefix = path.join(ctx.dirs.tools, 'pi');
    mkdirSync(prefix, { recursive: true });
    const r = await spawnCapture('npm', ['install', '--prefix', prefix, `${this.install.pkg}@${this.install.version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], {
      // Only the MidBrain candidate comes from the loopback registry.
      cwd: prefix, env: childEnv(ctx, { npm_config_registry: 'https://registry.npmjs.org/' }), timeoutMs: 300000,
    });
    if (r.code !== 0) throw new BlockedError(`Pi install failed: ${r.stderr.slice(-500)}`);
    symlinkSync(path.join(prefix, 'node_modules', '.bin', 'pi'), bin);
  },
  async version(ctx) {
    const r = await spawnCapture('pi', ['--version'], { env: this.clientEnv(ctx), timeoutMs: 30000 });
    return r.stdout.trim() || null;
  },
  async runTurn({ ctx, project, prompt, sessionId, resume = false, evidenceDir, label = 'turn' }) {
    const args = ['-p', '--mode', 'json', '--approve', '--provider', 'anthropic', '--model', process.env.MIDBRAIN_HARNESS_PI_MODEL || 'claude-haiku-4-5'];
    if (resume && sessionId) args.push('--session', sessionId);
    args.push('--', prompt);
    const turn = { client: 'pi', sessionId: null, prompt, finalText: '', toolCalls: [], nativeAssistantMessages: [], isError: false, nativeCapture: true, startedAt: new Date().toISOString(), rawPath: path.join(evidenceDir, `${label}.ndjson`) };
    const r = await spawnCapture('pi', args, {
      cwd: project, env: this.clientEnv(ctx), timeoutMs: Number(process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS || 300000), stdoutFile: turn.rawPath,
      onStdoutLine: line => { let event; try { event = JSON.parse(line); } catch { return; } piEvent(turn, event); },
    });
    return { ...turn, exitCode: r.code, durationMs: r.durationMs, stderr: r.stderr.slice(-4000), timedOut: r.timedOut };
  },
  async evidence(ctx, destDir) {
    return [{ name: 'Pi sessions', count: copyTree(path.join(ctx.dirs.home, '.pi', 'agent', 'sessions'), path.join(destDir, 'pi-sessions'), p => p.endsWith('.jsonl')) }];
  },
};
