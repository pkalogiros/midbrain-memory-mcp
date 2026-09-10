// NanoClaw v2: the real Claude provider and agent-runner in Docker, driven by
// an isolated local mailbox instead of a messaging-service account.
import path from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { NanoClawRuntime, NANOCLAW_SHA, CAPTURE_CWD, dockerEnv } from '../lib/nanoclaw.mjs';
import { BlockedError } from '../lib/checks.mjs';
import { spawnCapture, whichSync } from '../lib/proc.mjs';
import { walk } from '../lib/evidence.mjs';
import { nanoSpecificCases } from '../scenarios/nanoclaw-lifecycle.mjs';

const runtimes = new WeakMap();

export default {
  id: 'nanoclaw',
  displayName: 'NanoClaw',
  os: ['linux', 'darwin'],
  binary: 'docker',
  install: { kind: 'docker', hint: 'Docker and Node 24+; pinned NanoClaw source/image are prepared run-locally' },
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  detectionFixtures: [],
  configShape: ['~/nanoclaw/.claude/skills/add-midbrain/SKILL.md', '~/nanoclaw/container/CLAUDE.md'],
  mechanism: 'Pinned NanoClaw v2 Claude provider in Docker; real SQLite mailbox, native SDK hooks, durable .claude-shared mount',
  expectedCaptureLabel: 'nanoclaw',
  captureCwd: CAPTURE_CWD,
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: false, sessionResume: true, deferredTools: true },
  knownExceptions: [
    'The group retains its installer-populated npm cache across container wakes; upgrade validation explicitly clears its npx resolution cache.',
    'No separate PostToolUse capture; tool calls/results are collected from the native Claude transcript.',
    'The runner may request a formatting retry, producing multiple native assistant replies for one inbound message. Each native reply must be captured exactly once; duplicate or missing captures still fail.',
    'The local mailbox transport excludes Slack/WhatsApp delivery, OneCLI gateway provisioning, and host routing from this MCP integration lane.',
  ],
  specific: ['cold-wake', 'session-resume', 'legacy-opener-recovery'],

  formatPrompt(prompt) {
    return `${prompt}\n\nDelivery format: put the requested reply inside <message to="harness">...</message>. Any exact-text or JSON requirement above applies to the text inside that wrapper.`;
  },

  runtime(ctx) {
    const runtime = runtimes.get(ctx);
    if (!runtime) throw new Error('NanoClaw was not prepared');
    return runtime;
  },

  async preflight(ctx, { doctor = false } = {}) {
    if (!['darwin', 'linux'].includes(process.platform)) throw new BlockedError('NanoClaw requires Docker on Linux or macOS');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new BlockedError('NanoClaw mailbox requires Node 24+ (built-in SQLite)');
    if (!whichSync('docker') || !whichSync('git')) throw new BlockedError('Docker and git must be on PATH');
    const r = await spawnCapture('docker', ['info', '--format', '{{.ServerVersion}}'], { env: dockerEnv(), timeoutMs: 15000 });
    if (r.code !== 0) throw new BlockedError('Docker daemon is unavailable');
    if (doctor) return;
    const runtime = new NanoClawRuntime(ctx, ctx.candidate);
    runtimes.set(ctx, runtime);
    ctx.cleanup.push(() => runtime.cleanup());
    await runtime.prepare();
  },

  async version(ctx) {
    const runtime = this.runtime(ctx);
    return NANOCLAW_SHA + ' image=' + runtime.image;
  },

  async afterInstall(ctx, { projects }) { await this.runtime(ctx).group(projects[0]); },
  async clearNpxCache(ctx) { this.runtime(ctx).clearNpxCache(); },
  async installedVersion(ctx) { return this.runtime(ctx).installedVersion(); },
  async mcpList(ctx) { return this.runtime(ctx).probe(); },
  async runTurn(args) { return this.runtime(args.ctx).turn(args); },
  async specificCases(args) { return nanoSpecificCases({ ...args, runtime: this.runtime(args.ctx) }); },

  async evidence(ctx, destDir) {
    const runtime = this.runtime(ctx);
    const source = path.join(runtime.root, 'data/v2-sessions');
    const files = walk(source, f => /\.(jsonl|log)$/.test(f));
    for (const file of files) {
      const target = path.join(destDir, 'native', path.relative(source, file));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, runtime.redact(readFileSync(file, 'utf8')), { mode: 0o600 });
    }
    const count = files.length;
    const groups = [...runtime.groups.values()].map(g => ({ id: g.id, durableShim: existsSync(path.join(g.claude, '.midbrain/bin/claude-hook')), label: existsSync(path.join(g.claude, '.midbrain-capture-client')) ? readFileSync(path.join(g.claude, '.midbrain-capture-client'), 'utf8').trim() : null }));
    ctx.writeJson(path.join(destDir, 'identity.json'), { ...runtime.identity, groups });
    return [{ name: 'NanoClaw native evidence files', count }];
  },
};
