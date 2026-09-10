import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runJobs, parseConcurrency, scenarioConcurrency, scenarioResources } from '../harness/lib/scheduler.mjs';
import { SCENARIOS } from '../harness/scenarios/index.mjs';
import { prepareProjectIsolation } from '../harness/scenarios/s04-project-global-isolation.mjs';
import { installCandidate, writeProjectKey } from '../harness/lib/home.mjs';

vi.mock('../harness/lib/home.mjs', async importOriginal => ({
  ...await importOriginal(), installCandidate: vi.fn(), writeProjectKey: vi.fn(),
}));

const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

describe('bounded harness scheduling', () => {
  it('overlaps independent clients, bounds concurrency, and preserves result order', async () => {
    const first = gate(), second = gate(), started = gate();
    const events = [];
    const pending = runJobs([
      { resources: ['a'], run: async () => { events.push('a'); await first.promise; return 'A'; } },
      { resources: ['b'], run: async () => { events.push('b'); started.resolve(); await second.promise; return 'B'; } },
      { resources: ['c'], run: async () => { events.push('c'); first.resolve(); return 'C'; } },
    ], 2);
    await started.promise;
    expect(events).toEqual(['a', 'b']);
    second.resolve();
    expect(await pending).toEqual(['A', 'B', 'C']);
    expect(events).toEqual(['a', 'b', 'c']);
  });

  it('locks both sides of pairs while allowing disjoint pairs to proceed', async () => {
    const release = gate(), independent = gate();
    const events = [];
    const pending = runJobs([
      { resources: ['a', 'b'], run: async () => { events.push('ab'); await release.promise; } },
      { resources: ['b', 'c'], run: async () => { events.push('bc'); } },
      { resources: ['c', 'd'], run: async () => { events.push('cd'); independent.resolve(); await release.promise; } },
    ], 3);
    await independent.promise;
    expect(events).toEqual(['ab', 'cd']);
    release.resolve();
    await pending;
    expect(events).toEqual(['ab', 'cd', 'bc']);
  });

  it('locks only the reader when model-check checkpoints are already complete', () => {
    const scenario = { id: 's02-cross-client-recall' };
    const args = { writer: { id: 'a' }, reader: { id: 'b' } };
    const ctx = { options: { modelChecks: true }, meta: { s02Writes: { a: { wTurn: {}, rb: {} } } } };
    expect(scenarioResources(scenario, args, ctx)).toEqual(['b']);
    expect(scenarioResources(scenario, args, { ...ctx, options: {} })).toEqual(['a', 'b']);
    expect(scenarioResources(scenario, args, { ...ctx, meta: {} })).toEqual(['a', 'b']);
    expect(scenarioResources({ id: 'future' }, args, ctx)).toEqual(['a', 'b']);
  });

  it('drains running and queued work before reporting a failure', async () => {
    const release = gate(), started = gate();
    const events = [];
    const pending = runJobs([
      { resources: ['a'], run: () => { throw new Error('failed'); } },
      { resources: ['b'], run: async () => { started.resolve(); await release.promise; events.push('finished'); } },
      { resources: ['a'], run: () => { events.push('lock released'); } },
    ], 2);
    let settled = false;
    const observed = pending.catch(error => { settled = true; return error; });
    await started.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect((await observed).message).toBe('failed');
    expect(events).toContain('finished');
    expect(events).toContain('lock released');
  });

  it('keeps serial mode ordered and handles no jobs', async () => {
    const events = [];
    await runJobs([1, 2, 3].map(n => ({ resources: [], run: async () => { events.push(n); } })), 1);
    expect(events).toEqual([1, 2, 3]);
    expect(await runJobs([], 3)).toEqual([]);
  });

  it('makes concurrent project clients await one install, including on failure', async () => {
    for (const code of [0, 1]) {
      const install = gate();
      installCandidate.mockReset().mockReturnValue(install.promise);
      writeProjectKey.mockClear();
      const ctx = { meta: {} };
      const calls = [1, 2, 3].map(() => prepareProjectIsolation(ctx, {}, 'project-b', 'test-key'));
      expect(installCandidate).toHaveBeenCalledTimes(1);
      expect(writeProjectKey).toHaveBeenCalledTimes(1);
      expect(ctx.meta.projBInstalled).toBeUndefined();
      install.resolve({ code, stderr: 'test' });
      expect((await Promise.all(calls)).map(r => r.code)).toEqual([code, code, code]);
      expect(ctx.meta.projBInstalled).toBe(code === 0);
    }
  });

  it('requires opt-in on scenarios and keeps cold/upgrade/tampering cases exclusive', () => {
    const parallel = SCENARIOS.filter(sc => scenarioConcurrency(sc, 3) === 3).map(sc => sc.id.slice(0, 3));
    expect(parallel).toEqual(['s06', 's08', 's03', 's02', 's05', 's04']);
    expect(scenarioConcurrency({ id: 'future-scenario' }, 3)).toBe(1);
    for (const sc of SCENARIOS) expect(scenarioConcurrency(sc, 1)).toBe(1);
  });

  it('defaults to serial and rejects invalid limits before any setup', () => {
    expect(parseConcurrency(undefined)).toBe(1);
    expect(parseConcurrency('3')).toBe(3);
    expect(parseConcurrency('8', 10)).toBe(8);
    expect(() => parseConcurrency('11', 10)).toThrow('--concurrency');
    for (const value of [true, '', '0', '-1', '1.5', 'NaN', 'Infinity', '6']) {
      expect(() => parseConcurrency(value)).toThrow('--concurrency');
    }
    const cli = fileURLToPath(new URL('../harness/run.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'run', '--concurrency', '0'], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--concurrency');
    expect(result.stderr).not.toContain('API_KEY is required');
  });
});
