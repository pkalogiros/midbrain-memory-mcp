import { check } from '../lib/checks.mjs';
import { rowMeta } from '../lib/api.mjs';
import { runTurn, readback, metadataChecks, turnChecks, cell, relEvidence, sinceNow, logSnippet } from './_shared.mjs';

export default {
  id: 's01-capture',
  title: 'Capture',
  kind: 'single',
  parity: true,
  rows: ['User capture', 'Assistant capture', 'Metadata', 'Duplicates and missing turns'],
  async run({ ctx, api, client, project }) {
    const m = ctx.subMarker(client.id, 'capture');
    const prompt = `Please remember this exactly: the harness marker for this session is ${m}. Reply with just the marker.`;
    const expected = 'Exactly one user row and one assistant row containing the marker reach the API with client label, shared session_id and home-relative cwd; no duplicates; no rows from other clients.';
    const since = sinceNow();
    const turn = await runTurn({ ctx, client, project, prompt, scenarioId: this.id, label: 'turn-1' });
    ctx.meta.firstTurn = ctx.meta.firstTurn || {};
    const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1, minAssistant: 1 });
    const foreign = rb.rows.filter((r) => rowMeta(r).client && rowMeta(r).client !== client.expectedCaptureLabel);
    const evidence = [relEvidence(ctx, turn.rawPath), relEvidence(ctx, turn.jsonPath)];
    const rbFile = `${turn.jsonPath.replace(/\.json$/, '')}.readback.json`;
    ctx.writeJson(rbFile, rb.rows);
    evidence.push(relEvidence(ctx, rbFile));
    const notes = `read-back: ${rb.rows.length} row(s) in ${rb.elapsedMs} ms over ${rb.polls} poll(s)${rb.timedOut ? ' (timed out)' : ''}; tool calls in turn: ${turn.toolCalls.length}${turn.stopHook ? `; stop-hook: ${turn.stopHook}` : ''}; log: ${logSnippet(ctx, client.id, /STORE|ERROR|WARN/) || '(no lines)'}`;
    ctx.meta.firstTurn[client.id] = { userCaptured: rb.user.length >= 1, assistantCaptured: rb.assistant.length >= 1 };
    const base = { scenario: this.id, client, prompt, expected, evidence, notes };
    return [
      cell({ ...base, row: 'User capture', checks: [...turnChecks(turn), check('user row containing the marker reached the API', rb.user.length >= 1, `user rows=${rb.user.length}`)] }),
      cell({ ...base, row: 'Assistant capture', checks: [check('assistant row containing the marker reached the API', rb.assistant.length >= 1, `assistant rows=${rb.assistant.length}`)] }),
      cell({ ...base, row: 'Metadata', checks: metadataChecks(rb.rows, client.expectedCaptureLabel) }),
      cell({ ...base, row: 'Duplicates and missing turns', checks: [
        check('exactly one user row for the marker (no duplicate, no missing)', rb.user.length === 1, `user rows=${rb.user.length}`),
        check('exactly one assistant row for the marker', rb.assistant.length === 1, `assistant rows=${rb.assistant.length}`),
        check('no rows with this marker from another client', foreign.length === 0, `foreign rows=${foreign.length}`),
      ] }),
    ];
  },
};
