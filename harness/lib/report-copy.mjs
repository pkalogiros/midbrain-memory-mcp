export function failedCheckText(check) {
  const name = typeof check === 'string' ? check : check.name;
  if (name.startsWith('stored evidence contains ')) return name.replace('stored evidence contains ', 'Search results did not contain ');
  if (name.startsWith('answer contains ')) return name.replace('answer contains ', 'The answer did not contain ');
  const explanations = { 'reader made at least one MidBrain tool call': 'No memory search was recorded for the second client.', 'a MidBrain call input contains the marker verbatim': 'No recorded memory query included the exact task identifier.', 'successful MidBrain result contains the writer verification value': 'No successful recorded memory result contained the fact saved by the first client.', 'reader final answer contains the hidden writer value': 'The second client’s answer did not contain the fact saved by the first client.' };
  return explanations[name] || `The test expected this, but did not verify it: ${name}`;
}

export const testName = scenario => ({ 's01-capture': 'Saving a conversation', 's03-fresh-session-continuity': 'Remembering a fact in a new session', 's02-cross-client-recall': 'One client recalling another client’s fact', 's05-freshness-reconciliation': 'Remembering an updated fact', 's06-no-match-clean': 'Answering an unrelated question' }[scenario] || scenario || 'Behavior check');


export const clientName = id => ({ claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes', nanoclaw: 'NanoClaw', pi: 'Pi', opencode: 'OpenCode' }[id] || id || 'Unknown client');

export function findingContext(item, models = {}) {
  const model = item.model || models[item.client] || 'model not recorded';
  const writer = item.writer || (item.notes || '').match(/(?:writer[= ]|recall from )(\w+)/)?.[1];
  return {
    ...item, model, writer, writerModel: models[writer] || item.writerModel,
    context: `${clientName(item.client)} · ${model}${item.round ? ` · ${item.round} round` : ''}`,
    test: writer ? `Recall across clients: ${clientName(writer)} (${models[writer] || item.writerModel || 'model not recorded'}) saved the fact; ${clientName(item.client)} (${model}) was asked to recall it.` : testName(item.scenario),
  };
}

export function attentionText(items, { markdown = false } = {}) {
  const groups = new Map();
  for (const raw of items.filter(i => ['FAIL', 'BLOCKED', 'FLAKY'].includes(i.status))) {
    const item = findingContext(raw);
    const key = [item.round, item.client, item.model, item.scenario || item.row, item.writer, item.diagnosis?.key].join(':');
    if (!groups.has(key)) groups.set(key, { ...item, rows: [] });
    groups.get(key).rows.push(item.row);
  }
  return [...groups.values()].map(item => {
    const d = item.diagnosis;
    return [`${markdown ? '### ' : ''}${item.context} — ${d?.title || 'The expected outcome was not verified'}`, item.test,
      d?.what || item.reason || item.blockedReason || 'Review the saved checks for this test.',
      `Next step: ${d?.next || 'Inspect the saved evidence before deciding on a fix.'}`,
      `Recorded checks: ${item.status} — ${item.rows.join('; ')}`].join('\n\n');
  }).join('\n\n') || 'No failed or blocked checks recorded.';
}

// The requested model is a pin; a client default must not be presented as an observed model.
export function requestedModel(client) {
  return process.env[`MIDBRAIN_HARNESS_${client.id.toUpperCase()}_MODEL`] || client.options?.model || ({ nanoclaw: 'claude-sonnet-4-5', pi: 'claude-haiku-4-5' }[client.id]) || 'client default';
}
