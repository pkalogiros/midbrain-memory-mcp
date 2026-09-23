// One bounded native turn per worker. Secrets arrive via stdin, never a command line
// or persisted input file. Imports happen after the explicit model policy is set.
import { writeFileSync } from 'node:fs';
import { smokeEnv } from './dry-smoke-policy.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { id, model, timeoutMs, ctx, project, prompt, evidenceDir } = JSON.parse(input);
process.env[`MIDBRAIN_HARNESS_${id.toUpperCase()}_MODEL`] = model;
process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS = String(timeoutMs);
process.env.MIDBRAIN_HARNESS_CODEX_AUTH = 'apikey';
process.env.MIDBRAIN_HARNESS_HERMES_PROVIDER = 'anthropic';
const { default: manifest } = await import(`../clients/${id}.mjs`);
const originalEnv = manifest.clientEnv.bind(manifest);
manifest.clientEnv = (context, options) => ({ ...originalEnv(context, options),
  ...smokeEnv(context, { ...context.secrets, MIDBRAIN_DEV: '1', MIDBRAIN_API_URL: ctx.apiUrl,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', HERMES_ACCEPT_HOOKS: '1', HERMES_INTERACTIVE: '0' }),
});
try {
  if (id === 'codex') {
    const auth = await manifest.seedAuth(ctx);
    if (auth.code !== 0) throw new Error('Codex API-key login failed inside the isolated home');
  }
  const turn = await manifest.runTurn({ ctx, project, prompt, evidenceDir, label: 'native' });
  // Historical price tables are not authoritative for this new mode.
  delete turn.estimatedCost;
  if (turn.costSource?.includes('2026-09-10')) { turn.cost = null; turn.costSource = 'Native usage only; no current price estimate'; }
  writeFileSync(`${evidenceDir}/worker-turn.json`, JSON.stringify(turn, null, 2), { mode: 0o600 });
} catch (error) {
  writeFileSync(`${evidenceDir}/worker-turn.json`, JSON.stringify({ client: id, prompt, exitCode: -1, isError: true, errorDetail: error.message, finalText: '', toolCalls: [] }), { mode: 0o600 });
  process.exitCode = 1;
}
