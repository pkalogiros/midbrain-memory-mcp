import { check, complianceChecks, isMidbrainTool, inputText } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from './_shared.mjs';

export default {
  id: 's05-freshness-reconciliation',
  title: 'Freshness and reconciliation',
  kind: 'single',
  parity: true,
  rows: ['Freshness reconciliation', 'Rule and priming compliance'],
  async run({ ctx, api, client, project }) {
    const m = ctx.subMarker(client.id, 'fresh');
    const oldV = `staging-${m.slice(-4).toLowerCase()}`;
    const newV = `prod-${m.slice(-4).toLowerCase()}`;
    const p1 = `Note for task ${m}: the deploy target is currently ${oldV}. Acknowledge briefly.`;
    const p2 = `Update for task ${m}: the deploy target has changed to ${newV}. ${oldV} is retired and must not be used. Acknowledge briefly.`;
    const p3 = `What is the current deploy target for task ${m}? Answer with the target name and cite the memory evidence you used.`;
    const expected = `Third fresh session reports ${newV} as current, does not present ${oldV} as current, and used a MidBrain tool call containing the marker.`;
    const since = sinceNow();
    const t1 = await runTurn({ ctx, client, project, prompt: p1, scenarioId: this.id, label: 'state-old' });
    const rb1 = await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
    const t2 = await runTurn({ ctx, client, project, prompt: p2, scenarioId: this.id, label: 'state-new' });
    const rb2 = await readback(ctx, api, m, { sinceIso: since, minUser: 2 });
    const evidence = [relEvidence(ctx, t1.rawPath), relEvidence(ctx, t2.rawPath)];
    if (rb2.user.length < 2) {
      return [cell({ row: 'Freshness reconciliation', scenario: this.id, client, prompt: p3, expected, evidence, notes: `only ${rb2.user.length} of 2 state rows reached the API (${rb1.user.length} after first)`, checks: [check('both state rows reached the API', false)] })];
    }
    await grace(ctx);
    const t3 = await runTurn({ ctx, client, project, prompt: p3, scenarioId: this.id, label: 'ask-current' });
    evidence.push(relEvidence(ctx, t3.rawPath), relEvidence(ctx, t3.jsonPath));
    const memCalls = t3.toolCalls.filter(isMidbrainTool);
    // The scenario asks the agent to CITE evidence, so a correct answer quotes the old
    // memory that literally says "currently <oldV>". Judge which value the answer presents
    // as current (order + superseded framing), not the mere presence of the old quote.
    const iNew = t3.finalText.indexOf(newV);
    const iOld = t3.finalText.indexOf(oldV);
    const supersededFraming = /retired|superseded|no longer|previous|former|predecessor|was |used to|changed|replaced|outdated|stale|old value/i.test(t3.finalText);
    const oldPresentedAsCurrent = iOld >= 0 && iNew >= 0 && iOld < iNew && !supersededFraming;
    return [
      cell({ row: 'Freshness reconciliation', scenario: this.id, client, prompt: p3, expected, evidence, notes: `midbrain calls=${memCalls.length}`, checks: [
        ...turnChecks(t3),
        check('answer used a MidBrain tool call containing the marker', memCalls.some((c) => inputText(c).includes(m))),
        check(`answer names ${newV} as the target`, t3.finalText.includes(newV)),
        check(`answer presents ${newV}, not ${oldV}, as current`, !oldPresentedAsCurrent, `iNew=${iNew} iOld=${iOld} superseded=${supersededFraming}`),
      ] }),
      cell({ row: 'Rule and priming compliance', scenario: this.id, client, prompt: p3, expected: 'memory-first ordering, anchor preserved, search deepened on miss', evidence, checks: complianceChecks(t3, m) }),
    ];
  },
};
