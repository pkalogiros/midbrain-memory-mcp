import { experimentPrompt, experimentChecks } from '../lib/experiment.mjs';
import { randomBytes } from 'node:crypto';
import { check, complianceChecks, isMidbrainTool, recallChecks } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, cell, blockedCells, relEvidence, sinceNow, grace } from './_shared.mjs';

export default {
  id: 's03-fresh-session-continuity',
  title: 'Fresh-session continuity',
  kind: 'single',
  parallel: true,
  parity: true,
  rows: ['Fresh-session continuity', 'Rule and priming compliance'],
  async run({ ctx, api, client, project }) {
    const seed = ctx.options.simple && !ctx.meta.upgradeTurns?.[client.id] ? ctx.meta.s02Writes?.[client.id] : null;
    if (ctx.options.quickSimple && !seed?.rb.user.length) return blockedCells(this.rows, this.id, client, 'Capture prerequisite was not verified; no recall prompt was sent.');
    if (seed) {
      const { m, value, wTurn, rb, readyAt } = seed;
      if (!rb.user.length) return [cell({ row: 'Fresh-session continuity', scenario: this.id, client, checks: [check('checkpoint captured', false)] })];
      await grace(ctx, readyAt);
      const prompt = experimentPrompt(ctx, 'recall', { marker: m, value, client: client.id });
      const recall = await runTurn({ ctx, client, project, prompt, scenarioId: this.id, label: 'session-fresh' });
      const evidence = [relEvidence(ctx, wTurn.jsonPath), relEvidence(ctx, recall.jsonPath)];
      return [
        cell({ row: 'Fresh-session continuity', scenario: this.id, client, prompt, evidence,
          expected: 'A new session recovers the hidden checkpoint value through MidBrain.', notes: 'Checkpoint reuse: checkpoint written by this client during this run’s capture check.',
          checks: [...turnChecks(recall), check('fresh native session', Boolean(recall.sessionId && wTurn.sessionId && recall.sessionId !== wTurn.sessionId)), ...recallChecks(recall, m, [value]), ...experimentChecks(ctx, 'recall', recall, { marker: m, value, client: client.id })] }),
        cell({ row: 'Rule and priming compliance', scenario: this.id, client, prompt, evidence, checks: complianceChecks(recall, m) }),
      ];
    }
    // Simple mode: the upgrade prelude already wrote a checkpoint in one session and recalled it
    // from a fresh session on the candidate, which is this scenario's claim. Score those turns.
    const pre = ctx.options?.simple ? ctx.meta?.upgradeTurns?.[client.id] : null;
    if (pre) {
      const { marker: pm, value, write, recall } = pre;
      const memCalls = recall.toolCalls.filter(isMidbrainTool);
      const evidence = [relEvidence(ctx, write.rawPath), relEvidence(ctx, recall.rawPath), relEvidence(ctx, recall.jsonPath)];
      const notes = `derived from the S9 upgrade prelude (simple mode): checkpoint written in session ${write.sessionId} on the previous release, recalled in fresh session ${recall.sessionId} on the candidate; midbrain calls=${memCalls.length}`;
      return [
        cell({ row: 'Fresh-session continuity', scenario: this.id, client, prompt: recall.prompt, expected: 'A brand-new session recovers the checkpoint through a MidBrain tool call containing the marker and returns its hidden value.', evidence, notes, checks: [
          ...turnChecks(recall),
          check('fresh session has a different session id', recall.sessionId && write.sessionId && recall.sessionId !== write.sessionId, `${write.sessionId} → ${recall.sessionId}`),
          ...recallChecks(recall, pm, [value]),
        ] }),
        cell({ row: 'Rule and priming compliance', scenario: this.id, client, prompt: recall.prompt, expected: 'memory-first ordering, anchor preserved, search deepened on miss', evidence, notes: 'derived from the S9 upgrade prelude (simple mode)', checks: complianceChecks(recall, pm) }),
      ];
    }
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
