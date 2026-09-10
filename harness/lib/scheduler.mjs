// Jobs sharing a client never overlap. Independent clients can overlap their
// model turns and read-back waits. Scenario boundaries remain full barriers.
export function parseConcurrency(value, maximum = 5) {
  if (value === undefined) return 1;
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(n) || n < 1 || n > maximum) {
    throw new Error(`--concurrency must be an integer from 1 to ${maximum}`);
  }
  return n;
}

export function scenarioConcurrency(scenario, concurrency) {
  return scenario.parallel === true ? concurrency : 1;
}

export function scenarioResources(scenario, args, ctx) {
  if (args.client) return [args.client.id];
  const seed = ctx.meta?.s02Writes?.[args.writer.id];
  // S01 has finished for every client before this barrier. S02 only operates
  // on its reader when the writer's checkpoint is already complete.
  if (ctx.options.modelChecks && scenario.id === 's02-cross-client-recall' && seed?.wTurn && seed?.rb) return [args.reader.id];
  return [args.writer.id, args.reader.id];
}

export async function runJobs(jobs, concurrency = 1) {
  concurrency = parseConcurrency(concurrency);
  const pending = jobs.map((job, index) => ({ ...job, index }));
  const running = new Map();
  const held = new Set();
  const results = new Array(jobs.length);
  const errors = new Map();
  while (pending.length || running.size) {
    for (let i = 0; i < pending.length && running.size < concurrency;) {
      const job = pending[i];
      if (job.resources.some(key => held.has(key))) {
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      for (const key of job.resources) held.add(key);
      const promise = Promise.resolve().then(() => job.run()).then(
        value => { results[job.index] = value; },
        error => { errors.set(job.index, error); },
      ).then(() => {
        for (const key of job.resources) held.delete(key);
        running.delete(job.index);
      });
      running.set(job.index, promise);
    }
    if (running.size) await Promise.race(running.values());
  }
  // Drain every worker before callers can tear down the registry or test home.
  if (errors.size) throw errors.get(Math.min(...errors.keys()));
  return results;
}
