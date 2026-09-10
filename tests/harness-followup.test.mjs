import { expect, it } from 'vitest';
import { validateBaseline, validateClientVersion, followupScenarios, parseSweep, modelCheckOptions } from '../harness/lib/followup.mjs';
import { readback } from '../harness/scenarios/_shared.mjs';

const client = { id: 'claude', specific: ['cold-first-turn'] };
const candidate = { mode: 'registry', tarballSha256: 'archive', files: { 'index.js': 'source' }, harness: { files: { 'run.mjs': 'runner' } } };
const baseline = () => ({
  candidate, isolation: { ok: true, drift: [] },
  run: { finishedAt: '2026-09-10', apiBase: 'https://test.example', platform: process.platform, arch: process.arch, node: process.version, captureSettings: { pk: false } },
  clients: [{ id: 'claude', version: '1.0', runnable: true }],
  cells: [
    ['install', 'Clean install'], ['client-version', 'Reproducibility'],
    ['s04-project-global-isolation', 'Project and global isolation'],
    ['s09-upgrade-continuity', 'Upgrade and self-repair'],
    ['s10-client-specific/cold-first-turn', 'Client-specific scenarios'],
  ].map(([scenario, row]) => ({ scenario, row, client: 'claude', status: 'PASS' })),
});
const validate = value => validateBaseline(value, candidate, [client], { apiBase: 'https://test.example', pk: false });

it('reuses only successful baseline evidence for the same candidate, harness, API and host', () => {
  expect(validate(baseline())).toHaveLength(3);
  const published = JSON.parse(JSON.stringify(baseline()));
  published.candidate.sourceTarballSha256 = 'archive';
  published.candidate.sourceFiles = { ...published.candidate.files };
  published.candidate.tarballSha256 = 'published-rc-archive';
  published.candidate.files['package.json'] = 'rewritten-rc-version';
  expect(validate(published)).toHaveLength(3);
  for (const mutate of [
    b => { b.candidate.files['index.js'] = 'changed'; },
    b => { b.candidate.harness.files['run.mjs'] = 'changed'; },
    b => { b.cells.at(-1).status = 'FAIL'; },
    b => { b.cells.pop(); },
    b => { b.isolation.ok = false; },
    b => { b.run.apiBase = 'https://other.example'; },
    b => { b.run.captureSettings.pk = true; },
  ]) {
    const b = JSON.parse(JSON.stringify(baseline())); mutate(b);
    expect(() => validate(b)).toThrow(/baseline/i);
  }
  expect(() => validateClientVersion(baseline(), 'claude', '2.0')).toThrow(/version/);
  expect(() => validateClientVersion(baseline(), 'claude', '1.0')).not.toThrow();
});

it('does not count earlier recall requests as proof that a new state update was captured', async () => {
  const oldRows = [{ role: 'user', text: 'marker old value' }, { role: 'user', text: 'recall marker' }];
  const api = { async waitForRows({ ready }) {
    expect(ready(oldRows)).toBe(false);
    const rows = [...oldRows, { role: 'user', text: 'marker new-value' }];
    expect(ready(rows)).toBe(true);
    return { rows };
  } };
  await readback({ options: {} }, api, 'marker', { minUser: 2, userText: 'new-value' });
});

it('leaves infrastructure checks out of the follow-up profile without calling it required coverage', () => {
  expect(followupScenarios()).toEqual(['s01', 's06', 's08', 's03', 's02', 's05']);
  expect(modelCheckOptions({ 'model-checks': true })).toMatchObject({ simple: true, mode: 'registry', concurrency: 4 });
  expect(modelCheckOptions({})).toEqual({});
  for (const extra of [{ required: true }, { upgrade: true }, { scenarios: 's09' }, { mode: 'dev' }, { 'follow-up': 'baseline' }]) {
    expect(() => modelCheckOptions({ 'model-checks': true, ...extra })).toThrow();
  }
});

it('accepts explicit model rounds and rejects unknown clients, empty models, and duplicate names', () => {
  const rounds = [{ name: 'fast', models: { claude: 'test-model', codex: 'another-model' } }];
  expect(parseSweep(rounds)).toEqual(rounds);
  for (const value of [[], [{ name: 'bad', models: {} }], [{ name: 'bad', models: { typo: 'x' } }], [{ name: 'bad', models: { claude: '' } }], [...rounds, ...rounds]]) {
    expect(() => parseSweep(value)).toThrow();
  }
});
