import { check, isMidbrainTool, inputText, resultText } from '../lib/checks.mjs';
import { HarnessApi } from '../lib/api.mjs';
import { writeProjectKey, installCandidate } from '../lib/home.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from './_shared.mjs';

const askFor = (m) => `Search your MidBrain memory for the token ${m}. Report exactly one of: "found: <token>" or "not found after search". Do not guess.`;

export default {
  id: 's04-project-global-isolation',
  title: 'Global and project isolation',
  kind: 'single',
  parity: true,
  rows: ['Project and global isolation'],
  async run({ ctx, api, client, project, candidate }) {
    const key2 = ctx.secrets.MIDBRAIN_HARNESS_PROJECT_API_KEY;
    const expected = 'A marker written under the project credential (proj-b) is not visible from the global credential (proj-a); it is visible from proj-b; a marker written under the global credential is visible from a global-only directory (fallback).';
    if (!key2) {
      return [cell({ row: 'Project and global isolation', scenario: this.id, client, expected, blockedReason: 'MIDBRAIN_HARNESS_PROJECT_API_KEY not provided (second MidBrain agent needed for a project override)' })];
    }
    const projB = ctx.projectDir('proj-b');
    const projC = ctx.projectDir('proj-c');
    if (!ctx.meta.projBInstalled) {
      writeProjectKey(projB, key2);
      const r = await installCandidate(ctx, candidate, { cwd: projB, extraArgs: ['--project', projB], label: 'install-project-b' });
      ctx.meta.projBInstalled = r.code === 0;
      if (r.code !== 0) {
        return [cell({ row: 'Project and global isolation', scenario: this.id, client, expected, checks: [check('project install for proj-b succeeded', false, r.stderr.slice(-300))] })];
      }
    }
    const api2 = new HarnessApi({ baseUrl: api.base, key: key2 });
    const mB = ctx.subMarker(client.id, 'isoB');
    const mA = ctx.subMarker(client.id, 'isoA');
    const since = sinceNow();
    const evidence = [];
    const wB = await runTurn({ ctx, client, project: projB, prompt: `Please remember this exactly: the harness marker for this session is ${mB}. Reply with just the marker.`, scenarioId: this.id, label: 'write-proj-b' });
    evidence.push(relEvidence(ctx, wB.rawPath));
    const rbB = await readback(ctx, api2, mB, { sinceIso: since, minUser: 1 });
    const wA = await runTurn({ ctx, client, project, prompt: `Please remember this exactly: the harness marker for this session is ${mA}. Reply with just the marker.`, scenarioId: this.id, label: 'write-proj-a' });
    evidence.push(relEvidence(ctx, wA.rawPath));
    const rbA = await readback(ctx, api, mA, { sinceIso: since, minUser: 1 });
    const leakB = await api.listEpisodicSince(since);
    const leakA = await api2.listEpisodicSince(since);
    await grace(ctx);
    const askAforB = await runTurn({ ctx, client, project, prompt: askFor(mB), scenarioId: this.id, label: 'ask-proj-a-for-b' });
    const askBforB = await runTurn({ ctx, client, project: projB, prompt: askFor(mB), scenarioId: this.id, label: 'ask-proj-b-for-b' });
    const askCforA = await runTurn({ ctx, client, project: projC, prompt: askFor(mA), scenarioId: this.id, label: 'ask-proj-c-for-a' });
    for (const t of [askAforB, askBforB, askCforA]) evidence.push(relEvidence(ctx, t.rawPath), relEvidence(ctx, t.jsonPath));
    // Retrieval = the STORED write memory surfaced, not the reader's own question (which
    // also contains the marker and gets captured, so a bare-token match false-positives).
    const storedPhrase = (m) => `marker for this session is ${m}`;
    const memHit = (t, m) => t.toolCalls.filter(isMidbrainTool).some((c) => resultText(c).includes(storedPhrase(m)) || resultText(c).split('\n').some((line) => line.includes(m) && !/search|token|not found/i.test(line)));
    const memAsked = (t, m) => t.toolCalls.filter(isMidbrainTool).some((c) => inputText(c).includes(m));
    return [cell({ row: 'Project and global isolation', scenario: this.id, client, prompt: askFor('<marker>'), expected, evidence, checks: [
      check('proj-b marker stored under the project credential', rbB.user.length >= 1, `rows=${rbB.user.length}`),
      check('proj-a marker stored under the global credential', rbA.user.length >= 1, `rows=${rbA.user.length}`),
      check('proj-b marker is not present in the global credential store', !leakB.some((r) => String(r.text ?? '').includes(mB))),
      check('proj-a marker is not present in the project credential store', !leakA.some((r) => String(r.text ?? '').includes(mA))),
      ...turnChecks(askAforB),
      check('asking from proj-a (global) searched for the proj-b marker', memAsked(askAforB, mB)),
      check('asking from proj-a (global) did not retrieve the proj-b marker', !memHit(askAforB, mB)),
      check('asking from proj-a answered not found', /not found after search/i.test(askAforB.finalText)),
      check('asking from proj-b retrieved the proj-b marker', memHit(askBforB, mB)),
      check('asking from a global-only directory retrieved the proj-a marker (global fallback)', memHit(askCforA, mA)),
    ] })];
  },
};
