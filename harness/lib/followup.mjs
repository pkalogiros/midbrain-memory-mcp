import path from 'node:path';
import { readFileSync, existsSync, symlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileHash } from './candidate.mjs';
import { MANIFESTS } from '../clients/index.mjs';

export const followupScenarios = () => ['s01', 's06', 's08', 's03', 's02', 's05'];
const REUSED = ['s04-project-global-isolation', 's09-upgrade-continuity', 's10-client-specific'];

export function modelCheckOptions(flags) {
  const followup = flags['follow-up'] !== undefined;
  if (!followup && !flags['model-checks']) return flags;
  if (followup && flags['model-checks']) throw new Error('Choose --follow-up or --model-checks, not both');
  if (flags.upgrade || flags.required || flags.scenarios || (flags.mode && flags.mode !== 'registry')) throw new Error('Model checks use a fixed registry profile; do not combine with --upgrade, --required, --scenarios or dev mode');
  return { ...flags, simple: true, mode: 'registry', concurrency: flags.concurrency ?? 4 };
}

export function loadBaseline(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('--follow-up needs a completed baseline run directory');
  const dir = path.resolve(directory);
  const file = path.join(dir, 'results.json');
  const results = JSON.parse(readFileSync(file, 'utf8'));
  if (!results.candidate?.tarball || fileHash(results.candidate.tarball) !== results.candidate.tarballSha256) throw new Error('Baseline candidate archive is missing or changed');
  return { dir, results, reportSha256: fileHash(file) };
}

function requirePass(cells, label) {
  if (!cells.length || cells.some(c => c.status !== 'PASS')) throw new Error(`Baseline ${label} is missing or not PASS; run a new baseline first`);
}

export function validateBaseline(baseline, candidate, clients, { apiBase, pk }) {
  if (!baseline.run?.finishedAt || baseline.run.followup || baseline.run.modelChecks || baseline.isolation?.ok !== true || baseline.isolation.drift?.length) throw new Error('Baseline must be a completed original run with clean isolation');
  if (candidate.mode !== 'registry' || baseline.candidate?.mode !== 'registry' ||
      (baseline.candidate.sourceTarballSha256 || baseline.candidate.tarballSha256) !== (candidate.sourceTarballSha256 || candidate.tarballSha256) ||
      !isDeepStrictEqual(baseline.candidate.sourceFiles || baseline.candidate.files, candidate.sourceFiles || candidate.files) ||
      !isDeepStrictEqual(baseline.candidate.harness?.files, candidate.harness?.files)) throw new Error('Baseline candidate or harness changed; run a new baseline first');
  if (baseline.run.apiBase !== apiBase || baseline.run.captureSettings?.pk !== pk ||
      baseline.run.platform !== process.platform || baseline.run.arch !== process.arch || baseline.run.node !== process.version) throw new Error('Baseline API, capture settings or host runtime changed');
  const reused = [];
  for (const client of clients) {
    if (!baseline.clients?.some(c => c.id === client.id && c.runnable && c.version)) throw new Error(`Baseline has no verified ${client.id} version`);
    const cells = baseline.cells.filter(c => c.client === client.id);
    for (const row of ['Clean install', 'Reproducibility']) requirePass(cells.filter(c => c.row === row), `${client.id}/${row}`);
    for (const scenario of REUSED.slice(0, 2)) requirePass(cells.filter(c => c.scenario === scenario), `${client.id}/${scenario}`);
    for (const name of client.specific || []) {
      if (baseline.run.simple && name === 'hook-trust-persisted') continue;
      requirePass(cells.filter(c => c.scenario === `s10-client-specific/${name}`), `${client.id}/${name}`);
    }
    const selected = cells.filter(c => REUSED.some(id => c.scenario === id || c.scenario.startsWith(id + '/')));
    requirePass(selected, `${client.id}/infrastructure checks`);
    reused.push(...selected.map(({ client, row, scenario, status }) => ({ client, row, scenario, status })));
  }
  return reused;
}

export function validateClientVersion(baseline, id, version) {
  const expected = baseline.clients.find(c => c.id === id)?.version;
  if (!version || version !== expected) throw new Error(`Baseline ${id} version changed (${expected} → ${version}); run a new baseline first`);
}

// Share executable installations only. HOME, sessions, npm caches, credentials,
// client settings, logs, projects, and NanoClaw mailboxes are always new.
export function reusePreparedTools(ctx, baseline, clients) {
  for (const client of clients) {
    const id = client.id;
    if (['hermes', 'opencode', 'pi'].includes(id)) {
      const source = path.join(baseline.dir, 'tools', id);
      const bin = path.join(baseline.dir, 'tools', 'bin', id);
      const pinned = client.install.version;
      const priorPin = baseline.results.run.toolPins?.[id];
      if (pinned && pinned !== 'latest' && priorPin !== pinned) throw new Error(`Baseline ${id} install pin changed; run a new baseline first`);
      if (existsSync(source) && existsSync(bin)) {
        symlinkSync(source, path.join(ctx.dirs.tools, id), 'dir');
        symlinkSync(bin, path.join(ctx.dirs.toolsBin, id));
      }
    }
    if (id === 'nanoclaw') {
      const identity = JSON.parse(readFileSync(path.join(baseline.dir, 'nanoclaw.json'), 'utf8'));
      const source = path.join(baseline.dir, 'tools', 'nanoclaw-checkout');
      if (existsSync(source)) ctx.meta.preparedNanoSource = source;
      ctx.meta.preparedNanoImage = identity.baseImage;
    }
  }
}

export function parseSweep(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Model sweep must be a nonempty array of {name, models} rounds');
  const names = new Set();
  for (const round of value) {
    if (!round || typeof round.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(round.name) || names.has(round.name)) throw new Error('Sweep round names must be unique simple names');
    names.add(round.name);
    if (!round.models || typeof round.models !== 'object' || Array.isArray(round.models) || !Object.keys(round.models).length) throw new Error(`Sweep ${round.name} needs explicit client/model entries`);
    for (const [id, model] of Object.entries(round.models)) if (!MANIFESTS[id] || typeof model !== 'string' || !model.trim()) throw new Error(`Invalid sweep client/model: ${id}`);
  }
  return value;
}
