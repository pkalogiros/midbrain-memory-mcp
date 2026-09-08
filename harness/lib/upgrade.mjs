// Upgrade-continuity prelude (S9). Registry mode only. Installs the previous
// published release through the loopback proxy, captures, publishes the
// candidate as `latest`, upgrades through the documented user path (clear the
// npx cache → next cold start re-resolves @latest), then proves old memory is
// still recallable and new sessions capture on the new version.
//
// Product note: the built-in self-heal fetches a hard-coded npmjs URL and only
// accepts stable versions, so it cannot be exercised against a loopback or an
// rc candidate. See docs/testing/multi-client-harness.md §7.
import path from 'node:path';
import { check, isMidbrainTool, inputText } from './checks.mjs';
import { publishCandidate, npxVersion, clearNpxCache, registryLatest } from './registry.mjs';
import { installCandidate, inspectInstall } from './home.mjs';
import { runTurn, readback, turnChecks, cell, relEvidence, sinceNow, grace } from '../scenarios/_shared.mjs';

const SCENARIO = 's09-upgrade-continuity';

export async function runUpgradePrelude({ ctx, api, candidate, clients, project }) {
  const out = {};
  const before = await npxVersion(ctx, candidate.name);
  const upstreamLatest = await registryLatest(ctx.registry, candidate.name);
  const oldMarkers = {};
  const oldChecks = {};
  for (const client of clients) {
    const m = ctx.subMarker(client.id, 'pre-upgrade');
    oldMarkers[client.id] = m;
    const since = sinceNow();
    const t = await runTurn({ ctx, client, project, prompt: `Please remember this exactly: the harness marker for this session is ${m}. Reply with just the marker.`, scenarioId: SCENARIO, label: 'old-version-capture' });
    const rb = await readback(ctx, api, m, { sinceIso: since, minUser: 1, minAssistant: 1 });
    oldChecks[client.id] = { turn: t, rb };
  }

  await publishCandidate(ctx, candidate);
  ctx.writeJson(path.join(ctx.dirs.run, 'candidate.json'), candidate);
  const cacheExisted = clearNpxCache(ctx);
  const after = await npxVersion(ctx, candidate.name);

  for (const client of clients) {
    const m = oldMarkers[client.id];
    const mNew = ctx.subMarker(client.id, 'post-upgrade');
    const since = sinceNow();
    const t2 = await runTurn({ ctx, client, project, prompt: `Please remember this exactly: the harness marker for this session is ${mNew}. Reply with just the marker.`, scenarioId: SCENARIO, label: 'new-version-capture' });
    const rb2 = await readback(ctx, api, mNew, { sinceIso: since, minUser: 1, minAssistant: 1 });
    const insp = await inspectInstall(ctx, candidate, client.id);
    await grace(ctx);
    const t3 = await runTurn({ ctx, client, project, prompt: `Search your MidBrain memory for the token ${m} and tell me the exact token. Do not guess; if it is not in memory say "not found after search".`, scenarioId: SCENARIO, label: 'recall-old-after-upgrade' });
    const memCalls = t3.toolCalls.filter(isMidbrainTool);
    const { turn: t1, rb: rb1 } = oldChecks[client.id];
    out[client.id] = cell({
      row: 'Upgrade and self-repair', scenario: SCENARIO, client,
      prompt: t3.prompt,
      expected: `Previous release (${upstreamLatest}) installs and captures; candidate ${candidate.registry.publishVersion} becomes latest; after the documented cache clear the next session runs the candidate, captures, keeps a fresh single set of hooks, and recalls memory written before the upgrade.`,
      evidence: [relEvidence(ctx, t1.rawPath), relEvidence(ctx, t2.rawPath), relEvidence(ctx, t3.rawPath), 'evidence/_install/install-global.stdout.txt'],
      notes: `npx before=${before.version} after=${after.version}; loopback latest after publish=${candidate.registry.latestAfterPublish}; npx cache existed before clear=${cacheExisted}; inspect after upgrade=${JSON.stringify(insp).slice(0, 300)}`,
      checks: [
        check(`previous published release resolved first (${upstreamLatest})`, before.version === upstreamLatest && before.version !== candidate.registry.publishVersion, `npx --version → ${before.version}`),
        ...turnChecks(t1),
        check('capture landed on the previous release', rb1.user.length >= 1 && rb1.assistant.length >= 1, `user=${rb1.user.length} assistant=${rb1.assistant.length}`),
        check('candidate published as latest on the loopback', candidate.registry.latestAfterPublish === candidate.registry.publishVersion, `latest=${candidate.registry.latestAfterPublish}`),
        check('next resolution after cache clear runs the candidate', after.version === candidate.registry.publishVersion, `npx --version → ${after.version}`),
        ...turnChecks(t2),
        check('capture landed on the candidate', rb2.user.length >= 1 && rb2.assistant.length >= 1, `user=${rb2.user.length} assistant=${rb2.assistant.length}`),
        check('install still fresh after upgrade (no duplicate hooks, canonical shim)', insp.fresh === true || insp.fresh === null, `fresh=${insp.fresh}`),
        check('fresh session on the candidate recalled pre-upgrade memory via MidBrain', memCalls.some((c) => inputText(c).includes(m)) && t3.finalText.includes(m), `memory calls=${memCalls.length}`),
      ],
    });
  }
  ctx.meta.upgradeCells = out;
  return out;
}

export async function installPreviousRelease(ctx, candidate, { cwd }) {
  return installCandidate(ctx, candidate, { cwd, label: 'install-global' });
}
