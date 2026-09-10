import { randomBytes } from 'node:crypto';
import { check, complianceChecks, isMidbrainTool, inputText, memoryEvidence } from '../lib/checks.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from './_shared.mjs';

export default {
  id: 's02-cross-client-recall',
  title: 'Cross-client recall',
  kind: 'pair',
  parallel: true,
  parity: true,
  rows: ['Cross-client recall', 'Rule and priming compliance'],
  async run({ ctx, api, writer, reader, project }) {
    // One checkpoint per writer, read by every reader: the directed pairs are
    // unchanged, the duplicate writes (and their indexing grace) are not repeated.
    ctx.meta = ctx.meta || {};
    ctx.meta.s02Writes = ctx.meta.s02Writes || {};
    let shared = ctx.meta.s02Writes[writer.id];
    const fresh = !shared;
    if (fresh) {
      const m = ctx.subMarker(writer.id, 'xrecall');
      const value = 'VALUE-' + randomBytes(8).toString('hex');
      const writePrompt = `Checkpoint for task ${m}: the verification value is ${value}. Remember it and acknowledge briefly.`;
      const since = sinceNow();
      const wTurn = await runTurn({ ctx, client: writer, project, prompt: writePrompt, scenarioId: this.id, label: 'write' });
      const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1 });
      shared = ctx.meta.s02Writes[writer.id] = { m, value, wTurn, rb, since, readers: 0 };
    }
    shared.readers += 1;
    const { m, value, wTurn, rb } = shared;
    const readPrompt = `Search your MidBrain memory for task ${m} and tell me its exact verification value and which client recorded it. Do not guess; if it is not in memory say "not found after search".`;
    const expected = `Reader (${reader.displayName}) makes at least one MidBrain tool call whose input contains the marker verbatim and recovers the hidden verification value written by ${writer.displayName}; the reader prompt never contains that value.`;
    const evidence = [relEvidence(ctx, wTurn.rawPath)];
    if (rb.user.length === 0) {
      return [cell({ row: 'Cross-client recall', scenario: this.id, client: reader, prompt: readPrompt, expected, evidence,
        notes: `writer ${writer.id} row never reached the API (${rb.elapsedMs} ms); recall not attempted`,
        checks: [check(`writer ${writer.id} user row reached the API`, false, `rows=${rb.rows.length}`)] })];
    }
    if (fresh) await grace(ctx); // indexing grace once per shared write
    else if (shared.readyAt) await grace(ctx, shared.readyAt);
    const rTurn = await runTurn({ ctx, client: reader, project, prompt: readPrompt, scenarioId: this.id, label: `read-from-${writer.id}` });
    evidence.push(relEvidence(ctx, rTurn.rawPath), relEvidence(ctx, rTurn.jsonPath));
    const memCalls = rTurn.toolCalls.filter(isMidbrainTool);
    const notes = `writer=${writer.id} (one shared checkpoint, row visible after ${rb.elapsedMs} ms; reader ${shared.readers} of this writer), reader=${reader.id}; midbrain calls=${memCalls.length}: ${memCalls.map((c) => c.name).join(', ') || 'none'}`;
    return [
      cell({ row: 'Cross-client recall', scenario: this.id, client: reader, prompt: readPrompt, expected, evidence, notes, checks: [
        ...turnChecks(rTurn),
        check('reader made at least one MidBrain tool call', memCalls.length >= 1, `calls=${memCalls.length}`),
        check('a MidBrain call input contains the marker verbatim', memCalls.some((c) => inputText(c).includes(m))),
        check('successful MidBrain result contains the writer verification value', memoryEvidence(rTurn).some(text => text.includes(value))),
        check('reader final answer contains the hidden writer value', rTurn.finalText.includes(value)),
      ] }),
      cell({ row: 'Rule and priming compliance', scenario: this.id, client: reader, prompt: readPrompt, expected: 'memory-first ordering, anchor preserved, search deepened on miss', evidence, notes: `recall from ${writer.id}`, checks: complianceChecks(rTurn, m) }),
    ];
  },
};
