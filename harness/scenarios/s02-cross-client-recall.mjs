import { check, complianceChecks, isMidbrainTool, inputText, resultText } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from './_shared.mjs';

export default {
  id: 's02-cross-client-recall',
  title: 'Cross-client recall',
  kind: 'pair',
  parity: true,
  rows: ['Cross-client recall', 'Rule and priming compliance'],
  async run({ ctx, api, writer, reader, project }) {
    const m = ctx.subMarker(writer.id, `xrecall-${reader.id}`);
    const writePrompt = `Please remember this exactly: the harness marker for this session is ${m}. Reply with just the marker.`;
    const readPrompt = `Search your MidBrain memory for the token ${m} and tell me the exact token and which client recorded it. Do not guess; if it is not in memory say "not found after search".`;
    const expected = `Reader (${reader.displayName}) makes at least one MidBrain tool call whose input contains the marker verbatim and answers with the marker written by ${writer.displayName}.`;
    const since = sinceNow();
    const wTurn = await runTurn({ ctx, client: writer, project, prompt: writePrompt, scenarioId: this.id, label: `write-for-${reader.id}` });
    const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
    const evidence = [relEvidence(ctx, wTurn.rawPath)];
    if (rb.user.length === 0) {
      return [cell({ row: 'Cross-client recall', scenario: this.id, client: reader, prompt: readPrompt, expected, evidence,
        notes: `writer ${writer.id} row never reached the API (${rb.elapsedMs} ms); recall not attempted`,
        checks: [check(`writer ${writer.id} user row reached the API`, false, `rows=${rb.rows.length}`)] })];
    }
    await grace(ctx);
    const rTurn = await runTurn({ ctx, client: reader, project, prompt: readPrompt, scenarioId: this.id, label: `read-from-${writer.id}` });
    evidence.push(relEvidence(ctx, rTurn.rawPath), relEvidence(ctx, rTurn.jsonPath));
    const memCalls = rTurn.toolCalls.filter(isMidbrainTool);
    const notes = `writer=${writer.id} (row visible after ${rb.elapsedMs} ms), reader=${reader.id}; midbrain calls=${memCalls.length}: ${memCalls.map((c) => c.name).join(', ') || 'none'}`;
    return [
      cell({ row: 'Cross-client recall', scenario: this.id, client: reader, prompt: readPrompt, expected, evidence, notes, checks: [
        ...turnChecks(rTurn),
        check('reader made at least one MidBrain tool call', memCalls.length >= 1, `calls=${memCalls.length}`),
        check('a MidBrain call input contains the marker verbatim', memCalls.some((c) => inputText(c).includes(m))),
        check('a MidBrain call result contains the marker (raw evidence)', memCalls.some((c) => resultText(c).includes(m))),
        check('reader final answer contains the marker', rTurn.finalText.includes(m)),
      ] }),
      cell({ row: 'Rule and priming compliance', scenario: this.id, client: reader, prompt: readPrompt, expected: 'memory-first ordering, anchor preserved, search deepened on miss', evidence, notes: `recall from ${writer.id}`, checks: complianceChecks(rTurn, m) }),
    ];
  },
};
