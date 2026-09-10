import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { check, captureCountChecks, recallChecks } from '../lib/checks.mjs';
import { sleep } from '../lib/api.mjs';
import { inspectInstall, tamperShim, seedDetectionFixtures, writeGlobalKey, writeGlobalHostConfig, installCandidate } from '../lib/home.mjs';
import { runTurn, readback, turnChecks, metadataChecks, grace, cell, relEvidence, sinceNow } from './_shared.mjs';

async function selfRepairSmoke({ ctx, api, client, project, candidate, scenarioId }) {
  const expected = 'A stale shim is detected as not fresh by the product adapter; the next client session triggers startup self-repair which restores the canonical shim; the assistant capture of that session lands (the opening user hook may race repair, which is the documented first-hook race).';
  const tampered = tamperShim(ctx, client.id, { mode: candidate.mode });
  if (!tampered) return cell({ row: 'Upgrade and self-repair', scenario: `${scenarioId}/self-repair-smoke`, client, expected, blockedReason: 'no shim installed for this client' });
  if (tampered.kind === 'unsupported') return cell({ row: 'Upgrade and self-repair', scenario: `${scenarioId}/self-repair-smoke`, client, expected, blockedReason: 'dev-mode shim tamper needs a POSIX exec bit; use registry mode on Windows' });
  const before = await inspectInstall(ctx, candidate, client.id);
  const m = ctx.subMarker(client.id, 'repair');
  const prompt = `Reply with exactly this token and nothing else: ${m}`;
  const since = sinceNow();
  const t = await runTurn({ ctx, client, project, prompt, scenarioId, label: 'after-tamper' });
  let after = await inspectInstall(ctx, candidate, client.id);
  const deadline = Date.now() + 60000;
  while (!(after.shim && after.shim.fresh) && Date.now() < deadline) {
    await sleep(5000);
    after = await inspectInstall(ctx, candidate, client.id);
  }
  const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 0, minAssistant: 1 });
  const checks = [
    check(`stale shim (${tampered.kind}) reported as not fresh by the product adapter`, before.shim && before.shim.fresh === false, JSON.stringify(before.shim || before)),
    ...turnChecks(t),
    check('startup self-repair restored a fresh shim within 60 s of the session', Boolean(after.shim && after.shim.fresh), JSON.stringify(after.shim || after)),
    check('assistant capture of the repairing session landed', rb.assistant.length >= 1, `assistant rows=${rb.assistant.length}`),
  ];
  if (tampered.kind === 'body') {
    checks.push(check('user capture landed while the shim was stale but still executable', rb.user.length >= 1, `user rows=${rb.user.length}`));
  }
  return cell({ row: 'Upgrade and self-repair', scenario: `${scenarioId}/self-repair-smoke`, client, prompt, expected,
    evidence: [relEvidence(ctx, t.rawPath), relEvidence(ctx, t.jsonPath)],
    notes: `tamper=${tampered.kind}; before fresh=${before.shim?.fresh}; after fresh=${after.shim?.fresh}; read-back user rows=${rb.user.length} (informational for exec-bit tamper: documented first-hook race), assistant rows=${rb.assistant.length}`,
    checks });
}

async function coldFirstTurn({ ctx, api, client, candidate, scenarioId }) {
  const first = ctx.meta.firstTurn?.[client.id];
  const expected = 'The very first user message in a brand-new home (before any startup self-repair had run) is captured.';
  if (!first || ctx.turns.find(t => t.client === client.id)?.scenario !== 's01-capture') {
    if (!candidate) return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/cold-first-turn`, client, expected, blockedReason: 'A separate clean candidate install is required after an upgrade prelude.' });
    const home = path.join(ctx.dirs.run, 'cold-home-' + client.id);
    mkdirSync(home); // Existing state is an error: this case must really be cold.
    const cold = { ...ctx, dirs: { ...ctx.dirs, home }, meta: {} };
    const project = path.join(home, 'project');
    mkdirSync(project);
    seedDetectionFixtures(cold, [client]);
    writeGlobalKey(cold, ctx.secrets.MIDBRAIN_HARNESS_API_KEY);
    writeGlobalHostConfig(cold, api.base);
    const installed = await installCandidate(cold, candidate, { cwd: project, label: 'cold-' + client.id });
    const marker = ctx.subMarker(client.id, 'cold-first');
    const since = sinceNow();
    const t = await runTurn({ ctx: cold, client, project, prompt: `Reply with exactly ${marker}`, scenarioId, label: 'cold-first-turn' });
    const rb = await readback(cold, api, marker, { sinceIso: since, minUser: 1, minAssistant: 1 });
    const file = t.jsonPath.replace(/\.json$/, '.readback.json');
    ctx.writeJson(file, rb);
    return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/cold-first-turn`, client, expected,
      evidence: [relEvidence(ctx, t.jsonPath), relEvidence(ctx, file)], notes: 'Separate fresh home and npm cache; candidate installed after publication; no previous client turn.',
      checks: [check('cold candidate installation succeeded', installed.code === 0), ...turnChecks(t), ...captureCountChecks(rb.rows, t),
        ...metadataChecks(rb.rows, client.expectedCaptureLabel, t.captureCwd, t.sessionId)] });
  }
  return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/cold-first-turn`, client, expected, notes: 'derived from s01-capture (first turn of the run)', checks: [
    check('opening user message captured on the cold first turn', first.userCaptured),
    check('assistant reply captured on the cold first turn', first.assistantCaptured),
  ] });
}

async function hookTrustPersisted({ ctx, api, client, project, scenarioId }) {
  const expected = 'Without --dangerously-bypass-hook-trust, Codex only runs hooks it has persisted trust for; documented as requiring a one-time /hooks approval.';
  const m = ctx.subMarker(client.id, 'trust');
  const prompt = `Reply with exactly this token and nothing else: ${m}`;
  const since = sinceNow();
  const t = await runTurn({ ctx, client, project, prompt, scenarioId, label: 'no-bypass', hookTrust: 'persisted' });
  const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
  const file = t.jsonPath.replace(/\.json$/, '.readback.json');
  ctx.writeJson(file, rb);
  const evidence = [relEvidence(ctx, t.rawPath), relEvidence(ctx, t.jsonPath), relEvidence(ctx, file)];
  const checks = [...turnChecks(t), check('unapproved hooks produce no capture', rb.rows.length === 0 && rb.timedOut, `rows=${rb.rows.length}`)];
  const evidenceDir = ctx.evidenceDir(client.id, scenarioId);
  const approved = await client.approveHooks?.(ctx, project, evidenceDir);
  const receipt = path.join(evidenceDir, 'approval-ui.txt');
  if (existsSync(receipt)) evidence.push(relEvidence(ctx, receipt));
  if (approved === null || approved === undefined) return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-trust-persisted`, client, prompt, expected, evidence, checks,
    blockedReason: 'Native hook approval did not run. Use --interactive in a terminal for manual /hooks approval, or omit it for automatic native UI approval. Bypass is not persisted approval.' });
  const afterMarker = m + '-approved';
  const afterSince = sinceNow();
  const after = await runTurn({ ctx, client, project, prompt: `Reply with exactly ${afterMarker}`, scenarioId, label: 'after-approval', hookTrust: 'persisted' });
  const observed = await readback(ctx, api, afterMarker, { sinceIso: afterSince, minUser: 1, minAssistant: 1 });
  const afterFile = after.jsonPath.replace(/\.json$/, '.readback.json');
  ctx.writeJson(afterFile, observed);
  return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-trust-persisted`, client, prompt, expected,
    evidence: [...evidence, relEvidence(ctx, after.jsonPath), relEvidence(ctx, afterFile)],
    checks: [...checks, check('native approval session exited successfully', approved === 0), ...turnChecks(after),
      ...captureCountChecks(observed.rows, after), ...metadataChecks(observed.rows, client.expectedCaptureLabel, after.captureCwd, after.sessionId)] });
}

async function hookAcceptance({ ctx, api, client, project, scenarioId }) {
  const expected = 'Without hook acceptance Hermes leaves the MidBrain hooks un-allowlisted and no capture lands; with HERMES_ACCEPT_HOOKS=1 the hooks are allowlisted and capture lands. The installer never flips the global toggle.';
  const allowlist = path.join(ctx.dirs.home, '.hermes', 'shell-hooks-allowlist.json');
  const original = existsSync(allowlist) ? readFileSync(allowlist) : null;
  const checks = [], evidence = [];
  try {
    rmSync(allowlist, { force: true });
    // Simple mode: the accepted half is S1's own capture (hooks accepted by default); derive it.
    const s1 = ctx.options?.simple ? ctx.meta?.captureEvidence?.[client.id] : null;
    for (const accepted of s1 ? [false] : [false, true]) {
      const marker = ctx.subMarker(client.id, accepted ? 'accepted' : 'unapproved');
      const since = sinceNow();
      const t = await runTurn({ ctx, client, project, prompt: `Reply with exactly ${marker}`, scenarioId,
        label: accepted ? 'with-acceptance' : 'without-acceptance', acceptHooks: accepted });
      const rb = await readback(ctx, api, marker, { sinceIso: since, minUser: 1, minAssistant: 1 });
      const file = path.join(ctx.evidenceDir(client.id, scenarioId), accepted ? 'accepted.readback.json' : 'unapproved.readback.json');
      ctx.writeJson(file, rb);
      evidence.push(relEvidence(ctx, t.jsonPath), relEvidence(ctx, file));
      checks.push(...turnChecks(t), check('API observation succeeded', !rb.lastError));
      if (accepted) checks.push(...captureCountChecks(rb.rows, t), ...metadataChecks(rb.rows, client.expectedCaptureLabel, t.captureCwd, t.sessionId));
      else checks.push(check('no user or assistant capture before acceptance', rb.timedOut && rb.rows.length === 0));
    }
    if (s1) {
      evidence.push(...s1.evidence);
      checks.push(...captureCountChecks(s1.rb.rows, s1.turn), ...metadataChecks(s1.rb.rows, client.expectedCaptureLabel, s1.turn.captureCwd, s1.turn.sessionId));
    }
    return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-acceptance`, client, expected, evidence, checks, notes: s1 ? 'simple mode: accepted-hooks capture derived from s01-capture' : '' });
  } finally {
    if (original) writeFileSync(allowlist, original);
    else rmSync(allowlist, { force: true });
  }
}

async function hookOrdering({ ctx, api, client, project, scenarioId }) {
  const expected = 'Native UserPromptSubmit and Stop complete in order without harness replay.';
  const checksFor = (t, rb) => [
    ...turnChecks(t), ...captureCountChecks(rb.rows, t), ...metadataChecks(rb.rows, client.expectedCaptureLabel, t.captureCwd, t.sessionId),
    check('capture settled without API errors', !rb.timedOut && !rb.lastError),
    check('user capture precedes assistant capture', Number.isFinite(Date.parse(rb.user[0]?.created_at)) && Date.parse(rb.user[0].created_at) <= Date.parse(rb.assistant[0]?.created_at)),
  ];
  // S1 already produced a native user + assistant capture with timestamps; ordering is
  // scored on that evidence instead of a second identical turn.
  const derived = ctx.meta?.captureEvidence?.[client.id];
  if (derived) {
    return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-ordering`, client, expected,
      evidence: derived.evidence, notes: 'derived from s01-capture (same native turn and read-back)', checks: checksFor(derived.turn, derived.rb) });
  }
  const marker = ctx.subMarker(client.id, 'hook-order');
  const since = sinceNow();
  const t = await runTurn({ ctx, client, project, prompt: `Reply with exactly ${marker}`, scenarioId, label: 'native-hooks' });
  const rb = await readback(ctx, api, marker, { sinceIso: since, minUser: 1, minAssistant: 1 });
  const file = path.join(ctx.evidenceDir(client.id, scenarioId), 'native-hooks.readback.json');
  ctx.writeJson(file, rb);
  return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-ordering`, client, expected,
    evidence: [relEvidence(ctx, t.jsonPath), relEvidence(ctx, file)], checks: checksFor(t, rb) });
}

async function pluginProcessSeparation({ ctx, api, client, project, scenarioId }) {
  const file = path.join(ctx.dirs.home, '.config/opencode/opencode.jsonc');
  const original = readFileSync(file, 'utf8');
  const entries = Object.keys(parse(original).mcp || {}).filter(key => /midbrain/i.test(key));
  if (entries.length !== 1) return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/plugin-process-separation`, client, blockedReason: 'Expected one MidBrain MCP config entry' });
  const marker = ctx.subMarker(client.id, 'plugin-only'), value = 'VALUE-' + randomBytes(8).toString('hex');
  let writer, rb;
  try {
    writeFileSync(file, applyEdits(original, modify(original, ['mcp', entries[0], 'enabled'], false, {})));
    const since = sinceNow();
    writer = await runTurn({ ctx, client, project, prompt: `Remember checkpoint ${marker}: verification value ${value}. Reply with exactly ${marker}.`, scenarioId, label: 'plugin-without-mcp' });
    rb = await readback(ctx, api, marker, { sinceIso: since, minUser: 1, minAssistant: 1 });
  } finally { writeFileSync(file, original); }
  const rbFile = path.join(ctx.evidenceDir(client.id, scenarioId), 'plugin-only.readback.json');
  ctx.writeJson(rbFile, rb);
  const captureChecks = [...turnChecks(writer), ...captureCountChecks(rb.rows, writer), check('native capture settled', !rb.timedOut && !rb.lastError)];
  // Simple mode stops at the capture: recall through MCP for this client is already proven by S2/S3.
  if (ctx.options?.simple) {
    return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/plugin-process-separation`, client,
      expected: 'The plugin captures with its MCP entry disabled.', notes: 'simple mode: MCP recall of the plugin-only row omitted (required-only); S2/S3 cover recall',
      evidence: [relEvidence(ctx, writer.jsonPath), relEvidence(ctx, rbFile)], checks: captureChecks });
  }
  await grace(ctx);
  const reader = await runTurn({ ctx, client, project, prompt: `Recall checkpoint ${marker} from MidBrain and report its exact verification value.`, scenarioId, label: 'mcp-restored' });
  return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/plugin-process-separation`, client,
    expected: 'The plugin captures with its MCP entry disabled; a new process with MCP enabled retrieves the hidden value.',
    evidence: [relEvidence(ctx, writer.jsonPath), relEvidence(ctx, reader.jsonPath), relEvidence(ctx, rbFile)],
    checks: [...captureChecks, ...turnChecks(reader), ...recallChecks(reader, marker, [value])] });
}

// Cases whose product behaviour only moves with a client release; simple mode leaves them to --required.
const REQUIRED_ONLY = new Set(['hook-trust-persisted']);
const HANDLERS = { 'hook-ordering': hookOrdering, 'plugin-process-separation': pluginProcessSeparation, 'self-repair-smoke': selfRepairSmoke, 'cold-first-turn': coldFirstTurn, 'hook-trust-persisted': hookTrustPersisted, 'hook-acceptance': hookAcceptance };

export default {
  id: 's10-client-specific',
  title: 'Client-specific cases',
  kind: 'single',
  parity: true,
  rows: ['Client-specific scenarios', 'Upgrade and self-repair'],
  async run(args) {
    const { client } = args;
    if (client.specificCases) return client.specificCases(args);
    const cells = [];
    for (const name of client.specific || []) {
      if (args.ctx.options?.simple && REQUIRED_ONLY.has(name)) continue; // covered by the required matrix
      const handler = HANDLERS[name];
      if (!handler) {
        cells.push(cell({ row: 'Client-specific scenarios', scenario: `${this.id}/${name}`, client, blockedReason: `client-specific case "${name}" has no handler yet` }));
        continue;
      }
      cells.push(await handler({ ...args, scenarioId: this.id }));
    }
    return cells;
  },
};
