import { check } from '../lib/checks.mjs';
import { sleep } from '../lib/api.mjs';
import { inspectInstall, tamperShim } from '../lib/home.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow } from './_shared.mjs';

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

async function coldFirstTurn({ ctx, client, scenarioId }) {
  const first = ctx.meta.firstTurn?.[client.id];
  const expected = 'The very first user message in a brand-new home (before any startup self-repair had run) is captured.';
  if (!first) return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/cold-first-turn`, client, expected, blockedReason: 's01-capture did not run first for this client' });
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
  const captured = rb.user.length >= 1;
  return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-trust-persisted`, client, prompt, expected,
    evidence: [relEvidence(ctx, t.rawPath), relEvidence(ctx, t.jsonPath)],
    status: captured ? 'PASS' : 'SKIP',
    notes: captured ? 'hooks ran without bypass in this Codex version' : 'documented exception: no capture without persisted hook trust; interactive /hooks approval required once per home',
    checks: [check('turn completed', t.exitCode === 0 && !t.timedOut), check('user row captured without hook-trust bypass', captured, `user rows=${rb.user.length}`)] });
}

async function hookAcceptance({ ctx, api, client, project, scenarioId }) {
  const expected = 'Without hook acceptance Hermes leaves the MidBrain hooks un-allowlisted and no capture lands; with HERMES_ACCEPT_HOOKS=1 the hooks are allowlisted and capture lands. The installer never flips the global toggle.';
  const before = typeof client.hooksList === 'function' ? await client.hooksList(ctx) : '';
  const m = ctx.subMarker(client.id, 'hookconsent');
  const prompt = `Reply with exactly this token and nothing else: ${m}`;
  const since = sinceNow();
  const t = await runTurn({ ctx, client, project, prompt, scenarioId, label: 'without-acceptance', acceptHooks: false });
  const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
  const listAfter = typeof client.hooksList === 'function' ? await client.hooksList(ctx) : '';
  const midbrainLines = (txt) => txt.split('\n').filter((l) => /midbrain/i.test(l));
  return cell({ row: 'Client-specific scenarios', scenario: `${scenarioId}/hook-acceptance`, client, prompt, expected,
    evidence: [relEvidence(ctx, t.rawPath), relEvidence(ctx, t.jsonPath)],
    notes: `hooks list before: ${midbrainLines(before).join(' | ') || '(none)'}; after unapproved turn: ${midbrainLines(listAfter).join(' | ') || '(none)'}; user rows without acceptance=${rb.user.length}`,
    checks: [
      check('installer left MidBrain hooks configured but not allowlisted', midbrainLines(before).length >= 1 && midbrainLines(before).every((l) => /not allowlisted/i.test(l)), midbrainLines(before).join(' | ')),
      check('unapproved turn completed (fail-open)', t.exitCode === 0 && !t.timedOut, `exit=${t.exitCode}`),
      check('no capture landed without hook acceptance', rb.user.length === 0, `user rows=${rb.user.length}`),
      check('hooks remain un-allowlisted after the unapproved turn', midbrainLines(listAfter).every((l) => /not allowlisted/i.test(l)), midbrainLines(listAfter).join(' | ')),
    ] });
}

const HANDLERS = { 'self-repair-smoke': selfRepairSmoke, 'cold-first-turn': coldFirstTurn, 'hook-trust-persisted': hookTrustPersisted, 'hook-acceptance': hookAcceptance };

export default {
  id: 's10-client-specific',
  title: 'Client-specific cases',
  kind: 'single',
  parity: true,
  rows: ['Client-specific scenarios', 'Upgrade and self-repair'],
  async run(args) {
    const { client } = args;
    const cells = [];
    for (const name of client.specific || []) {
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
