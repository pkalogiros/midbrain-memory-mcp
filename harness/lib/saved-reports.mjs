import { findingContext, attentionText } from './report-copy.mjs';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { renderMarkdown } from './report.mjs';
import { renderRunHtml, renderSweepHtml } from './report-html.mjs';
import { recordedCosts, combineCosts, costLabel } from './costs.mjs';

export function describeFailure(cell, turn = {}) {
  const failed = (cell.checks || []).filter(c => !c.ok);
  const names = failed.map(c => c.name).join('\n');
  const tools = turn.toolCalls || [];
  const service = (key, title, what, next) => ({ key, title, what, next, category: 'Service or runtime' });
  if (cell.blockedReason?.startsWith('MidBrain API readback failed:')) return service('readback', 'The test could not check what MidBrain saved', 'The test sent an update, but its request to read the saved memories back failed. It stopped before asking the client to recall the update. This does not prove the update was lost.', 'Check the MidBrain API and its logs, then rerun the update-and-recall checks.');
  if (failed.some(c => /Docker run failed/.test(c.detail || ''))) return service('docker', 'NanoClaw could not start this test', 'Docker could not launch the test container. There is no model answer to judge for these attempts.', 'Check that Docker can start the NanoClaw container, then retry these questions.');
  if (/UnknownIssuer|invalid peer certificate/.test(turn.errorDetail || '')) return service('certificate', 'Codex logged a secure-connection error', 'Codex returned an answer, but also logged a certificate-validation error. The runner marked the turn failed because of that error; the answer itself was not the failed check.', 'Investigate the certificate error and whether the connection recovered. Review the runner’s handling of recovered errors.');
  if (turn.timedOut) return service('turn-timeout', 'The client did not finish before the time limit', 'The turn hit its time limit without a final answer. The saved evidence also records interrupted tool work. This does not establish that the saved fact was missing.', 'Check the client and memory-service connection, then rerun the interrupted question.');
  const authError = tools.filter(t => /memory_search/.test(t.name || '')).map(t => String(t.result || '').match(/^Memory search failed: API (401|403)\b/)).find(Boolean);
  if (authError) return service('authentication', 'MidBrain rejected the memory search', `The search returned HTTP ${authError[1]} (${authError[1] === '401' ? 'authentication failed' : 'access denied'}). The client could not retrieve the saved fact, so recall could not be judged. This is not evidence that the client forgot it.`, 'Check the API’s authentication service and the client’s credential setup, then retry the search.');
  if (tools.some(t => /CONNECT_TIMEOUT/.test(String(t.result || '')))) return service('memory-connection', 'The memory service did not connect', 'The second client could not connect to MidBrain, so it could not look up the fact saved by the first client. The search, retrieval and answer checks all failed as a consequence.', 'Check MidBrain’s MCP connection and startup logs, then rerun the affected cross-client test.');
  if (/reader made at least one MidBrain tool call|memory-first:|anchor preserved:/.test(names) && /unavailable|not available/.test(turn.finalText || '') && !tools.some(t => /memory_search/.test(t.name || ''))) return service('tool-unavailable', 'The client could not use memory search', 'No memory search was recorded. The client’s answer said the search tool was unavailable, so it could not look up the saved fact.', 'Check whether MidBrain connected and exposed its search tool in that client session.');
  const missingEvidence = failed.some(c => c.name.startsWith('stored evidence contains '));
  const missingAnswer = failed.some(c => c.name.startsWith('answer contains '));
  if (missingEvidence && !missingAnswer) return { key: 'unsupported-answer', category: 'Recall verification', title: 'The answer matched, but the search evidence did not support it', what: 'The client returned the expected fact. However, the recorded search results did not contain that fact, so this test could not verify that the answer came from memory.', next: 'Inspect the native search results and the harness’s evidence capture; rerun the same lookup before drawing a conclusion.' };
  if (missingAnswer && (cell.checks || []).some(c => c.ok && c.name.startsWith('stored evidence contains '))) return { key: 'answer-mismatch', category: 'Recall behavior', title: 'MidBrain found the fact, but the client did not return it', what: 'The search results contained the expected fact. The client’s final answer omitted it. Retrieval worked; the answer did not satisfy the question.', next: 'Review how the client uses recalled text. It should answer the current question, rather than follow instructions inside an old memory.' };
  return { key: `check:${cell.row}`, category: 'Needs investigation', title: 'This check needs closer inspection', what: 'The expected outcome was not verified. The saved evidence does not establish a more specific cause.', next: 'Review the affected test and its original checks below.' };
}

export function withFailureContext(report) {
  const root = report.run.runDir;
  return { ...report, cells: report.cells.map(cell => {
    if (cell.status === 'PASS') return cell;
    let turn;
    if (root) for (const ref of [...(cell.evidence || [])].reverse()) {
      const file = path.resolve(root, ref);
      if (!file.startsWith(path.resolve(root) + path.sep) || !file.endsWith('.json') || !existsSync(file)) continue;
      try { const candidate = JSON.parse(readFileSync(file, 'utf8')); if (candidate.client === cell.client && Array.isArray(candidate.toolCalls)) { turn = candidate; break; } } catch { /* Unreadable evidence stays unclassified. */ }
    }
    return findingContext({ ...cell, diagnosis: describeFailure(cell, turn) }, report.run.models);
  }) };
}

export function failureSummary(report) {
  return withFailureContext(report).cells.filter(c => c.status !== 'PASS').map(c => ({ model: c.model, writer: c.writer, writerModel: report.run.models?.[c.writer], notes: c.notes, client: c.client, row: c.row, status: c.status, reason: c.blockedReason || c.reason, scenario: c.scenario, diagnosis: c.diagnosis, checks: (c.checks || []).filter(ch => !ch.ok).map(ch => ch.name) }));
}

// Presentation-only refresh. Original results, hashes and verdicts remain untouched.
export function renderSavedReports(directory) {
  const sweep = path.join(directory, 'sweep.json');
  if (existsSync(sweep)) {
    const summary = JSON.parse(readFileSync(sweep, 'utf8'));
    for (const round of summary.rounds) {
      if (!round.report) continue;
      const runDir = path.dirname(round.report);
      const report = JSON.parse(readFileSync(path.join(runDir, 'results.json'), 'utf8'));
      const observedCosts = recordedCosts(runDir);
      round.costs = observedCosts.totalTurns ? observedCosts : report.run.costs;
      round.isolation = report.isolation?.ok ?? null;
      round.failures = failureSummary(report);
      renderSavedReports(runDir);
    }
    summary.costs = combineCosts(summary.rounds.map(r => r.costs));
    writeFileSync(path.join(directory, 'costs.json'), JSON.stringify(summary.costs, null, 2) + '\n');
    const markdown = path.join(directory, 'report.md');
    if (existsSync(markdown)) writeFileSync(markdown, readFileSync(markdown, 'utf8').replace('| Result | Prompts |', '| Result | Returned turns |').split(/\n## (?:What needs attention|Native reported costs|Model cost accounting)/)[0] + '\n## What needs attention\n\n' + attentionText(summary.rounds.flatMap(r => (r.failures || []).map(f => findingContext({ ...f, round: r.name }, r.models))), { markdown: true }) + '\n' + '\n## Model cost accounting\n\nTotal: ' + costLabel(summary.costs) + '\n\n' + summary.rounds.map(r => `- ${r.name}: ${costLabel(r.costs)}`).join('\n') + '\n\nModel accounting excludes unmetered runner/backend costs. Original verdict JSON is unchanged.\n');
    const out = path.join(directory, 'report.html');
    writeFileSync(out, renderSweepHtml(summary));
    return out;
  }
  const report = JSON.parse(readFileSync(path.join(directory, 'results.json'), 'utf8'));
  const observedCosts = recordedCosts(directory);
  report.run.costs = observedCosts.totalTurns ? observedCosts : report.run.costs;
  writeFileSync(path.join(directory, 'costs.json'), JSON.stringify(report.run.costs, null, 2) + '\n');
  writeFileSync(path.join(directory, 'report.md'), renderMarkdown(withFailureContext(report)));
  const out = path.join(directory, 'report.html');
  writeFileSync(out, renderRunHtml(withFailureContext(report)));
  return out;
}
