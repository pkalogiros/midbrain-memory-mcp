import { randomBytes } from 'node:crypto';
import { check, complianceChecks, isMidbrainTool, recallChecks } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from './_shared.mjs';

export default {
  id: 's03-fresh-session-continuity',
  title: 'Fresh-session continuity',
  kind: 'single',
  parity: true,
  rows: ['Fresh-session continuity', 'Rule and priming compliance'],
  async run({ ctx, api, client, project }) {
    const m = ctx.subMarker(client.id, 'continuity');
    const h = randomBytes(2).toString('hex');
    const a = `alpha_${h}`;
    const b = `beta_${h}`;
    const p1 = `We are working on task ${m}. Checkpoint: the next step is to rename the function ${a} to ${b} in utils.py. Acknowledge briefly.`;
    const p2 = `Use memory to find the checkpoint for task ${m} and tell me the exact next step, quoting both function names.`;
    const expected = `A brand-new session recovers the checkpoint through a MidBrain tool call containing the marker and names both ${a} and ${b}.`;
    const since = sinceNow();
    const t1 = await runTurn({ ctx, client, project, prompt: p1, scenarioId: this.id, label: 'session-1' });
    const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
    const evidence = [relEvidence(ctx, t1.rawPath)];
    if (rb.user.length === 0) {
      return [cell({ row: 'Fresh-session continuity', scenario: this.id, client, prompt: p2, expected, evidence, notes: 'checkpoint turn never reached the API; continuity not attempted', checks: [check('checkpoint user row reached the API', false)] })];
    }
    await grace(ctx);
    const t2 = await runTurn({ ctx, client, project, prompt: p2, scenarioId: this.id, label: 'session-2-fresh' });
    evidence.push(relEvidence(ctx, t2.rawPath), relEvidence(ctx, t2.jsonPath));
    const memCalls = t2.toolCalls.filter(isMidbrainTool);
    const notes = `session1=${t1.sessionId} session2=${t2.sessionId}; midbrain calls=${memCalls.length}`;
    return [
      cell({ row: 'Fresh-session continuity', scenario: this.id, client, prompt: p2, expected, evidence, notes, checks: [
        ...turnChecks(t2),
        check('fresh session has a different session id', t2.sessionId && t1.sessionId && t2.sessionId !== t1.sessionId, `${t1.sessionId} → ${t2.sessionId}`),
        ...recallChecks(t2, m, [a, b]),
      ] }),
      cell({ row: 'Rule and priming compliance', scenario: this.id, client, prompt: p2, expected: 'memory-first ordering, anchor preserved, search deepened on miss', evidence, checks: complianceChecks(t2, m) }),
    ];
  },
};
