// NanoClaw manifest. Driver is phase 3 (Docker-capable Linux runner). Preflight
// reports the concrete blocker (no Docker daemon, no NanoClaw checkout).
import { childEnv } from '../lib/context.mjs';
import { BlockedError } from '../lib/checks.mjs';
import { runSync, whichSync } from '../lib/proc.mjs';

export default {
  id: 'nanoclaw',
  displayName: 'NanoClaw',
  os: ['linux', 'darwin'],
  binary: 'docker',
  install: { kind: 'docker', hint: 'NanoClaw checkout at $NANOCLAW_HOME with container/Dockerfile and .claude/skills' },
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  detectionFixtures: [
    { path: 'nanoclaw/container/Dockerfile', content: '# harness fixture\n' },
    { path: 'nanoclaw/.claude/skills/.harness-keep', content: '' },
  ],
  configShape: ['~/nanoclaw/.claude/skills/add-midbrain/SKILL.md', '~/nanoclaw/container/CLAUDE.md'],
  mechanism: 'Claude Code inside a disposable container; hooks merged into data/v2-sessions/<group>/.claude-shared/settings.json; MIDBRAIN_CAPTURE_CLIENT=nanoclaw; MIDBRAIN_STATE_DIR=/home/node/.claude/.midbrain',
  expectedCaptureLabel: 'nanoclaw',
  capabilities: { userCapture: true, assistantCapture: true, toolCapture: false, sessionResume: false, deferredTools: true },
  knownExceptions: [
    'Hook children do not inherit the MCP server environment; only ~/.claude is durable across --rm respawns.',
    'First hook of a freshly created container can race startup persistence and miss once; recovery is at-least-once via the spool.',
    'Legacy untouched groups rely on the v0.4.10 opener-recovery receipt (at-most-once attempt boundary).',
  ],
  specific: ['cold-wake', 'legacy-opener-recovery'],
  clientEnv(ctx) { return childEnv(ctx, { ANTHROPIC_API_KEY: ctx.secrets.ANTHROPIC_API_KEY }); },
  async preflight() {
    if (!whichSync('docker')) throw new BlockedError('docker CLI not found');
    const r = runSync('docker', ['info'], { timeout: 15000 });
    if (r.code !== 0) throw new BlockedError('docker daemon not running');
    throw new BlockedError('NanoClaw driver not implemented (phase 3): needs a NanoClaw checkout and container orchestration');
  },
  async version() { return null; },
  async runTurn() { throw new BlockedError('NanoClaw driver not implemented (phase 3)'); },
  async evidence() { return []; },
};
