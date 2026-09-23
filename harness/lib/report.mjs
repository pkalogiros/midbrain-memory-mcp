import { runOutcome } from './checks.mjs';
import { renderLiveSmokeMarkdown } from './live-smoke-report.mjs';
import { reportToolCoverage } from './tool-contracts.mjs';
import { renderScriptedMarkdown } from './scripted-smoke-report.mjs';
import { attentionText, findingContext, failedCheckText } from './report-copy.mjs';
// Side-by-side report (design doc "Suggested report shape") + JSON results.
import { smokeReportSummary } from './dry-smoke-report.mjs';
import { costLabel } from './costs.mjs';
import { DRY_SMOKE_ROWS, DRY_SMOKE_SCOPE, drySmokeOutcome } from './dry-smoke-policy.mjs';
export const ROWS = [
  'Clean install',
  'Reproducibility',
  'Upgrade and self-repair',
  'Tool availability',
  'User capture',
  'Assistant capture',
  'Metadata',
  'Cross-client recall',
  'Fresh-session continuity',
  'Project and global isolation',
  'Freshness reconciliation',
  'No-match clean',
  'Duplicates and missing turns',
  'Rule and priming compliance',
  'Marker and prompt robustness',
  'Client-specific scenarios',
];

const RANK = { FAIL: 5, BLOCKED: 4, FLAKY: 3, PASS: 2, SKIP: 1 };
const BADGE = { PASS: '✅ PASS', FAIL: '❌ FAIL', BLOCKED: '⛔ BLOCKED', SKIP: '➖ SKIP', FLAKY: '⚠️ FLAKY' };

export function worst(statuses) {
  return statuses.reduce((w, s) => ((RANK[s] ?? 0) > (RANK[w] ?? 0) ? s : w), statuses[0] || null);
}

export function buildMatrix(cells, clientIds, rows = ROWS) {
  const m = {};
  for (const row of rows) {
    m[row] = {};
    for (const c of clientIds) {
      const mine = cells.filter((x) => x.row === row && x.client === c);
      m[row][c] = mine.length ? worst(mine.map((x) => x.status)) : null;
    }
  }
  return m;
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderMarkdown(results) {
  if (results.run.kind === 'scripted-smoke') return renderScriptedMarkdown(results);
  if (results.run.kind === 'live-smoke') return renderLiveSmokeMarkdown(results);
  const { run, candidate, clients, cells, isolation } = results;
  const dry = run.kind === 'dry-smoke';
  const rows = dry ? DRY_SMOKE_ROWS : ROWS;
  const ids = clients.map((c) => c.id);
  const matrix = buildMatrix(cells, ids, rows);
  const lines = [];
  lines.push(`# MidBrain ${dry ? 'dry-smoke integration' : 'multi-client parity'} report — run ${run.runId}`);
  lines.push('');
  lines.push(dry ? `Result: **${drySmokeOutcome(cells, isolation.ok, run.complete, ids)}**. FAIL, BLOCKED or incomplete coverage exits nonzero.\n\n${DRY_SMOKE_SCOPE}` : `Result: **${run.finishedAt ? runOutcome(cells, isolation.ok) : 'INCOMPLETE'}**. BLOCKED means incomplete coverage and does not itself fail the run.`, '');
  if (dry) {
    const summary = smokeReportSummary(results);
    lines.push(`Assertions: **${summary.passed}/${summary.assertions} passed** · ${summary.blocked} blocked cells · ${summary.missing.length} missing coverage cells · Elapsed: ${summary.elapsed}`, '');
  }
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Run type | ${dry ? 'Dry-smoke — no model calls; local fixture API' : run.followup ? 'Follow-up model checks — not full required coverage' : run.modelChecks ? 'Model checks only — infrastructure unverified' : run.profile === 'high' ? 'High — broad coverage with one cross-client cycle' : run.profile === 'xhigh' ? 'XHigh — full matrix' : run.quickSimple ? 'Simple — three prompts per client' : run.simple ? 'Simple cycle — not full required coverage' : run.required ? 'Required matrix' : 'Focused validation'} |`);
  if (run.followup) {
    lines.push(`| Verified baseline | ${esc(run.followup.baselineRunId)}; results SHA-256 ${esc(run.followup.reportSha256)} |`);
    lines.push('| Prior evidence | Project isolation, upgrade and client-specific checks were verified in the baseline, not rerun or counted as new passes. |');
  }
  if (run.modelChecks && !run.followup) lines.push('| Coverage limit | Project isolation, upgrade and client-specific cases were not run or verified. This report cannot serve as a baseline or release sign-off. |');
  if (run.promptCount !== undefined) lines.push(`| Returned turn records | ${run.promptCount}; ${Object.entries(run.promptsByClient || {}).map(([id, n]) => `${id}=${n}`).join(', ')} |`);
  if (run.costs) lines.push(`| Prompt attempts | ${run.costs.totalTurns}; includes failed launches |`);
  for (const [id, costs] of Object.entries(run.costs?.clients || {})) lines.push(`| ${esc(id)} cost | ${esc(costLabel(costs))} |`);
  lines.push(dry ? '| Model calls | 0 — no provider credentials or model prompts |' : `| Model cost accounting | ${esc(costLabel(run.costs))}; excludes unreported usage, runner and backend costs. |`);
  if (!dry) lines.push(`| Client concurrency | ${run.concurrency ?? 1} (cold capture, upgrade and client-specific scenarios serial) |`);
  if (run.crossClientPairs) lines.push(`| Planned cross-client links | ${run.crossClientPairs.map(p => `${esc(p.writer)} → ${esc(p.reader)}`).join(', ') || 'None selected'} |`);
  lines.push(`| Candidate | \`${candidate.name}\` ${candidate.version} @ \`${candidate.shortSha}\`${candidate.dirty ? ' (dirty tree)' : ''} (${candidate.mode} mode, branch ${candidate.branch}) |`);
  if (candidate.pack && !candidate.pack.error) lines.push(`| Source archive | ${candidate.pack.filename}, ${candidate.pack.entryCount} entries, ${candidate.pack.integrity} |`);
  if (candidate.tarballSha256) lines.push(`| Tested archive SHA-256 | ${candidate.tarballSha256} |`);
  lines.push(`| Host | ${run.platform}/${run.arch} ${run.osRelease}, node ${run.node} |`);
  lines.push(`| Run marker | \`${run.marker}\` |`);
  lines.push(`| Started / finished | ${run.startedAt} / ${run.finishedAt} |`);
  if (!dry) lines.push(`| Read-back ceiling / index grace | ${run.readbackTimeoutMs} ms / ${run.indexGraceMs} ms |`);
  lines.push(`| Isolation (real home untouched) | ${isolation.ok ? BADGE.PASS : BADGE.FAIL}${isolation.drift.length ? ` — ${isolation.drift.length} surface(s) drifted` : ''} |`);
  lines.push('');
  lines.push('## What needs attention', '', attentionText(cells.map(c => findingContext(c, run.models)), { markdown: true }), '');
  if (dry && Object.keys(results.contextPreviews || {}).length) {
    lines.push('## MCP context preview', '', 'Observed tool definitions, arguments, results and errors. This is a preview, not a native model request; no model request was created or sent.', '');
    for (const [id, preview] of Object.entries(results.contextPreviews)) lines.push(`- ${id}: ${preview.calls.length} attempts · [readable log](${preview.artifacts.markdown}) · [JSON](${preview.artifacts.json}) · [event log](${preview.artifacts.events})${preview.recordingComplete ? '' : ' · INCOMPLETE'}`);
    lines.push('');
  }
  if (dry) {
    lines.push('## Per-tool coverage', '', 'Discovery alone is not execution. Positive results require a recorded call and a passing assertion. N/A means the tool has no arguments; NOT COVERED is an explicit gap.', '');
    for (const client of clients) {
      lines.push(`### ${client.displayName}`, '', '| Tool | Discovered | Schema | Positive | Invalid input | Failure recovery |', '|---|---|---|---|---|---|');
      for (const t of reportToolCoverage(results, client.id)) lines.push(`| ${t.name} | ${t.discovered ? 'YES' : 'NO'} | ${t.schema} | ${t.positive} | ${t.invalid} | ${t.recovery} |`);
      lines.push('');
    }
  }
  lines.push('## Clients');
  lines.push('');
  lines.push('| Client | Version | Runnable | Config shape (hashes) | Known exceptions |');
  lines.push('|---|---|---|---|---|');
  for (const c of clients) {
    const shape = Object.entries(c.configShape || {}).map(([k, v]) => `${k}=${v}`).join('<br>');
    lines.push(`| ${c.displayName} (\`${c.id}\`) | ${esc(c.version || '—')} | ${c.runnable ? 'yes' : `no: ${esc(c.blockedReason)}`} | ${esc(shape) || '—'} | ${(c.knownExceptions || []).map(esc).join('<br>') || '—'} |`);
  }
  lines.push('');
  lines.push('## Matrix');
  lines.push('');
  lines.push(`| Check | ${clients.map((c) => c.displayName).join(' | ')} |`);
  lines.push(`|---|${clients.map(() => '---').join('|')}|`);
  for (const row of rows) {
    lines.push(`| ${row} | ${ids.map((id) => (matrix[row][id] ? BADGE[matrix[row][id]] : '—')).join(' | ')} |`);
  }
  lines.push('');
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIP: 0, FLAKY: 0 };
  for (const c of cells) counts[c.status] = (counts[c.status] || 0) + 1;
  lines.push(`Cells: ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  lines.push('');
  if (isolation.drift.length) {
    lines.push('## Isolation drift (surfaces only, never contents)');
    lines.push('');
    for (const d of isolation.drift) lines.push(`- \`${d.surface}\`: ${d.before} → ${d.after}`);
    lines.push('');
  }
  lines.push('## Technical evidence', '', 'PASS means the expectation was verified. FAIL means it was not verified. BLOCKED means a prerequisite prevented the check. A failed check alone does not establish a memory defect.');
  lines.push('');
  for (const cell of cells) {
    lines.push(`### ${cell.row} · ${cell.clientDisplay || cell.client} · ${cell.scenario} — ${BADGE[cell.status]}`);
    lines.push('');
    if (cell.status !== 'PASS') lines.push(findingContext(cell, run.models).context, '');
    if (cell.diagnosis) lines.push(cell.diagnosis.what, '', `Next step: ${cell.diagnosis.next}`, '');
    if (cell.notes) lines.push(`${cell.notes}`, '');
    if (cell.prompt) lines.push(`Prompt: \`${esc(cell.prompt)}\``, '');
    if (cell.expected) lines.push(`Expected: ${cell.expected}`, '');
    if (cell.blockedReason) lines.push(`Blocked: ${cell.blockedReason}`, '');
    if (cell.checks && cell.checks.length) {
      lines.push('| Check | Result | Detail |');
      lines.push('|---|---|---|');
      for (const ch of cell.checks) lines.push(`| ${esc(ch.ok ? ch.name : failedCheckText(ch))} | ${ch.ok ? '✅' : '❌'} | ${esc(ch.detail)} |`);
      lines.push('');
    }
    if (cell.evidence && cell.evidence.length) {
      lines.push(`Evidence: ${cell.evidence.map((e) => `\`${e}\``).join(', ')}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
