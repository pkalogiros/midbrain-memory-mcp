import { randomBytes } from 'node:crypto';
import { rowText } from '../lib/api.mjs';
import { check, complianceChecks, isMidbrainTool, recallChecks, currentAnswerChecks } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from './_shared.mjs';

export default {
  id: 's05-freshness-reconciliation',
  title: 'Freshness and reconciliation',
  kind: 'single',
  parallel: true,
  parity: true,
  rows: ['Freshness reconciliation', 'Rule and priming compliance'],
  async run({ ctx, api, client, project }) {
    // Simple mode: this client's S2 checkpoint is the stale state; only the update and the
    // fresh-session ask are new prompts. Required mode writes its own initial state.
    const s2 = ctx.options?.simple ? ctx.meta?.s02Writes?.[client.id] : null;
    const m = s2 ? s2.m : ctx.subMarker(client.id, 'fresh');
    const oldV = s2 ? s2.value : `staging-${randomBytes(8).toString('hex')}`;
    const newV = s2 ? `VALUE-${randomBytes(8).toString('hex')}` : `prod-${randomBytes(8).toString('hex')}`;
    const what = s2 ? 'verification value' : 'deploy target';
    const p1 = `Note for task ${m}: the deploy target is currently ${oldV}. Acknowledge briefly.`;
    const p2 = `Update for task ${m}: the ${what} has changed to ${newV}. ${oldV} is retired and must not be used. Acknowledge briefly.`;
    const p3 = `What is the current ${what} for task ${m}? Return only JSON with keys "current" (the ${s2 ? 'value' : 'target name'}) and "evidence" (the state-changing memory you used).`;
    const expected = `Third fresh session reports ${newV} as current, does not present ${oldV} as current, and used a MidBrain tool call containing the marker.`;
    const since = s2 ? s2.since : sinceNow();
    const t1 = s2 ? s2.wTurn : await runTurn({ ctx, client, project, prompt: p1, scenarioId: this.id, label: 'state-old' });
    const rb1 = s2 ? s2.rb : await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
    const t2 = await runTurn({ ctx, client, project, prompt: p2, scenarioId: this.id, label: 'state-new' });
    const rb2 = await readback(ctx, api, m, { sinceIso: since, minUser: 2, userText: newV });
    const evidence = [relEvidence(ctx, t1.rawPath), relEvidence(ctx, t2.rawPath)];
    if (rb2.user.length < 2 || !rb2.user.some(r => rowText(r).includes(newV))) {
      return [cell({ row: 'Freshness reconciliation', scenario: this.id, client, prompt: p3, expected, evidence, notes: `only ${rb2.user.length} of 2 state rows reached the API (${rb1.user.length} after first)`, checks: [check('both state rows reached the API', false)] })];
    }
    await grace(ctx);
    const t3 = await runTurn({ ctx, client, project, prompt: p3, scenarioId: this.id, label: 'ask-current' });
    evidence.push(relEvidence(ctx, t3.rawPath), relEvidence(ctx, t3.jsonPath));
    const memCalls = t3.toolCalls.filter(isMidbrainTool);
    return [
      cell({ row: 'Freshness reconciliation', scenario: this.id, client, prompt: p3, expected, evidence, notes: `${s2 ? 'simple mode: stale state is this client\'s S2 checkpoint; ' : ''}midbrain calls=${memCalls.length}`, checks: [
        ...turnChecks(t3),
        ...recallChecks(t3, m, [newV]),
        ...currentAnswerChecks(t3.finalText, newV),
      ] }),
      cell({ row: 'Rule and priming compliance', scenario: this.id, client, prompt: p3, expected: 'memory-first ordering, anchor preserved, search deepened on miss', evidence, checks: complianceChecks(t3, m) }),
    ];
  },
};
