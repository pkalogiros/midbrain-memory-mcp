import path from 'node:path';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

// Standard short-context rates, USD per million tokens, verified 2026-09-10.
// Sources: developers.openai.com/api/docs/pricing and platform.claude.com/docs/en/about-claude/pricing.
export function estimateUsage(model, usage, provider = 'anthropic') {
  if (!usage) return null;
  const rates = /claude-haiku-4-5/.test(model) ? [1, .1, 1.25, 2, 5]
    : /claude-sonnet-4-5/.test(model) ? [3, .3, 3.75, 6, 15]
    : model === 'gpt-5.6-sol' ? [4, .4, 5, 5, 20] : null;
  if (!rates || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  const read = usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? 0;
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const input = provider === 'openai' ? Math.max(0, usage.input_tokens - read - write) : usage.input_tokens;
  return (input * rates[0] + read * rates[1] + (write - hour) * rates[2] + hour * rates[3] + usage.output_tokens * rates[4]) / 1e6;
}

// Streaming clients may emit several blocks for one provider request.
export function estimateMessages(messages) {
  const unique = new Map();
  for (const message of messages) if (message?.id && message.usage) unique.set(message.id, { id: message.id, model: message.model, usage: message.usage });
  const usage = [...unique.values()];
  const values = usage.map(m => estimateUsage(m.model, m.usage));
  return { usage, estimatedCost: values.length && values.every(n => n !== null) ? values.reduce((a, b) => a + b, 0) : null };
}

export function summarizeCosts(turns) {
  const empty = () => ({ reportedUsd: 0, reportedTurns: 0, estimatedUsd: 0, estimatedTurns: 0, planEquivalentUsd: 0, planTurns: 0, incompleteTurns: 0, totalTurns: 0 });
  const clients = {};
  for (const item of turns) {
    const turn = item.turn || item;
    const row = clients[item.client || turn.client] ||= empty();
    row.totalTurns++;
    if (turn.costIncomplete) row.incompleteTurns++;
    const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (valid(turn.cost)) { row.reportedUsd += turn.cost; row.reportedTurns++; }
    else if (valid(turn.estimatedCost)) {
      const plan = turn.billingMode === 'chatgpt';
      row[plan ? 'planEquivalentUsd' : 'estimatedUsd'] += turn.estimatedCost;
      row[plan ? 'planTurns' : 'estimatedTurns']++;
    }
  }
  const totals = empty();
  for (const row of Object.values(clients)) for (const key of Object.keys(totals)) totals[key] += row[key];
  return { ...totals, complete: totals.totalTurns > 0 && totals.totalTurns === totals.reportedTurns + totals.estimatedTurns + totals.planTurns && totals.incompleteTurns === 0, clients };
}

export function combineCosts(summaries) {
  const total = summarizeCosts([]);
  for (const summary of summaries.filter(Boolean)) {
    for (const key of Object.keys(total).filter(k => typeof total[k] === 'number')) total[key] += summary[key] || 0;
    for (const [id, row] of Object.entries(summary.clients || {})) {
      const target = total.clients[id] ||= {};
      for (const [key, value] of Object.entries(row)) target[key] = (target[key] || 0) + value;
    }
  }
  total.complete = summaries.every(s => s?.complete) && total.totalTurns > 0;
  return total;
}

export function recordedCosts(directory) {
  const turns = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.prompt.json')) {
        const result = file.replace(/\.prompt\.json$/, '.json');
        const turn = JSON.parse(readFileSync(existsSync(result) ? result : file, 'utf8'));
        const raw = file.replace(/\.prompt\.json$/, '.ndjson');
        if (turn.client === 'claude' && turn.cost == null && turn.estimatedCost == null && existsSync(raw)) {
          const messages = readFileSync(raw, 'utf8').split('\n').flatMap(line => {
            try { const event = JSON.parse(line); return event.type === 'assistant' && !event.isApiErrorMessage ? [event.message] : []; } catch { return []; }
          });
          Object.assign(turn, estimateMessages(messages), { costIncomplete: true, costSource: 'Native assistant usage; 2026-09-10 standard Anthropic rates; interrupted turn may be incomplete' });
        }
        turns.push(turn);
      }
    }
  }
  walk(path.join(directory, 'evidence'));
  return summarizeCosts(turns);
}

export function costLabel(costs) {
  if (!costs || !(costs.reportedTurns + (costs.estimatedTurns || 0) + (costs.planTurns || 0))) return 'Not recorded';
  const covered = costs.reportedTurns + (costs.estimatedTurns || 0) + (costs.planTurns || 0);
  return `$${costs.reportedUsd.toFixed(4)} reported + $${(costs.estimatedUsd || 0).toFixed(4)} estimated API spend; $${(costs.planEquivalentUsd || 0).toFixed(4)} ChatGPT API-equivalent (not a charge) · ${covered}/${costs.totalTurns} prompt attempts${covered === costs.totalTurns ? '' : ' · partial, not total spend'}${costs.incompleteTurns ? ` · ${costs.incompleteTurns} interrupted estimates may omit unreported usage` : ''}`;
}
