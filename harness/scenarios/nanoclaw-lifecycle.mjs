// Lifecycle cases belong to the client manifest; adding another client does
// not require extending a central table of client-specific implementations.
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { check, captureCountChecks } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, metadataChecks, cell, relEvidence, sinceNow } from './_shared.mjs';

const SCENARIO = 's10-client-specific';
function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

export async function nanoSpecificCases({ ctx, api, client, project, runtime, candidate }) {
  const group = await runtime.group(project);
  const shim = path.join(group.claude, '.midbrain/bin/claude-hook');
  const key = path.join(group.claude, '.midbrain/.midbrain-key');
  const before = { shim: existsSync(shim) ? digest(shim) : null, key: digest(key) };
  const marker = ctx.subMarker(client.id, 'cold-wake');
  const since = sinceNow();
  const first = await runTurn({ ctx, client, project, prompt: 'Reply with exactly ' + marker + '-first', scenarioId: SCENARIO, label: 'before-cold-wake' });
  // Every runTurn removes its container. A resumed turn must reuse only the
  // durable group/session mounts and let the real SDK resume its continuation.
  const second = await runTurn({ ctx, client, project, prompt: 'Reply with exactly ' + marker + '-second', sessionId: first.sessionId, resume: true, scenarioId: SCENARIO, label: 'after-cold-wake' });
  const rb = await readback(ctx, api, marker + '-second', { sinceIso: since, minUser: 1, minAssistant: 1 });
  const rbFile = path.join(ctx.evidenceDir(client.id, SCENARIO), 'cold-wake.readback.json');
  ctx.writeJson(rbFile, rb.rows);
  const evidence = [relEvidence(ctx, first.jsonPath), relEvidence(ctx, second.jsonPath), relEvidence(ctx, rbFile)];
  const cells = [cell({ row: 'Client-specific scenarios', scenario: SCENARIO + '/cold-wake', client, evidence,
    expected: 'A newly created container uses the durable shim and credential and natively captures its opening turn exactly once.', checks: [
      ...turnChecks(first), ...turnChecks(second),
      check('different container instances', first.containerId !== second.containerId),
      check('durable shim existed before wake and survived unchanged', Boolean(before.shim) && existsSync(shim) && digest(shim) === before.shim),
      check('durable credential survived unchanged', digest(key) === before.key),
      ...captureCountChecks(rb.rows, second),
      ...metadataChecks(rb.rows, 'nanoclaw', second.captureCwd, second.sessionId),
    ] }), cell({ row: 'Client-specific scenarios', scenario: SCENARIO + '/session-resume', client, evidence,
    expected: 'NanoClaw resumes the same provider continuation across container recreation.', checks: [
      ...turnChecks(second),
      check('SDK continuation preserved', Boolean(first.sessionId) && first.sessionId === second.sessionId),
      check('same NanoClaw mailbox session', first.nanoSessionId === second.nanoSessionId),
    ] })];
  if (candidate.mode !== 'registry') {
    cells.push(cell({ row: 'Client-specific scenarios', scenario: SCENARIO + '/legacy-opener-recovery', client,
      blockedReason: 'Legacy startup recovery requires canonical registry mode; dev-marked installations intentionally bypass that migration.' }));
    return cells;
  }
  // Isolated untouched legacy group: old hook path, no capture marker, no
  // state-dir env. Never overwrite the normal group's durable state.
  const legacyProject = ctx.projectDir('nanoclaw-legacy');
  const legacy = await runtime.group(legacyProject);
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: "'/home/node/.midbrain/bin/claude-hook' user", timeout: 30 }] }],
      Stop: [{ hooks: [{ type: 'command', command: "'/home/node/.midbrain/bin/claude-hook' assistant", timeout: 30, async: true }] }],
    },
  };
  writeFileSync(path.join(legacy.claude, 'settings.json'), JSON.stringify(settings));
  rmSync(path.join(legacy.claude, '.midbrain-capture-client'), { force: true });
  rmSync(path.join(legacy.claude, '.midbrain/bin'), { recursive: true, force: true });
  const env = legacy.config.mcpServers['midbrain-memory'].env;
  delete env.MIDBRAIN_STATE_DIR;
  delete env.MIDBRAIN_CAPTURE_CLIENT;
  env.MIDBRAIN_API_KEY = legacy.key;
  writeFileSync(path.join(legacy.agent, 'container.json'), JSON.stringify(legacy.config), { mode: 0o600 });
  const m = ctx.subMarker('nanoclaw', 'legacy-opener');
  const legacySince = sinceNow();
  const t = await runTurn({ ctx, client, project: legacyProject, prompt: 'Reply with exactly ' + m, scenarioId: SCENARIO, label: 'legacy-first-wake' });
  const old = await readback(ctx, api, m, { sinceIso: legacySince, minUser: 1, minAssistant: 1 });
  const file = path.join(ctx.evidenceDir(client.id, SCENARIO), 'legacy.readback.json');
  ctx.writeJson(file, old.rows);
  cells.push(cell({ row: 'Client-specific scenarios', scenario: SCENARIO + '/legacy-opener-recovery', client,
    evidence: [relEvidence(ctx, t.jsonPath), relEvidence(ctx, file)],
    expected: 'The candidate migrates the legacy mount configuration and captures or natively recovers the opener without harness replay.',
    checks: [...turnChecks(t), ...captureCountChecks(old.rows, t), ...metadataChecks(old.rows, 'nanoclaw', t.captureCwd, t.sessionId)] }));
  return cells;
}
