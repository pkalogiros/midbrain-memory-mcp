import { check, forbiddenHits, isMidbrainTool } from '../lib/checks.mjs';
import { runTurn, turnChecks, cell, relEvidence } from './_shared.mjs';

export default {
  id: 's06-no-match-clean',
  title: 'No-match cleanliness',
  kind: 'single',
  parallel: true,
  parity: true,
  rows: ['No-match clean'],
  async run({ ctx, client, project }) {
    const prompt = 'What is the capital of Australia? Answer in one short sentence.';
    const expected = 'Answer contains "Canberra" and no MidBrain process language, no memory-tool names, no marker text, no "not found after search".';
    const t = await runTurn({ ctx, client, project, prompt, scenarioId: this.id, label: 'turn-1' });
    const hits = forbiddenHits(t.finalText);
    const memCalls = t.toolCalls.filter(isMidbrainTool).length;
    return [cell({ row: 'No-match clean', scenario: this.id, client, prompt, expected, evidence: [relEvidence(ctx, t.rawPath), relEvidence(ctx, t.jsonPath)],
      notes: `MidBrain tool calls made on an unrelated prompt: ${memCalls} (informational)`,
      checks: [
        ...turnChecks(t),
        check('answer contains Canberra', /canberra/i.test(t.finalText)),
        check('answer free of MidBrain process language and markers', hits.length === 0, hits.length ? `hits: ${hits.join(' ; ')}` : ''),
      ] })];
  },
};
