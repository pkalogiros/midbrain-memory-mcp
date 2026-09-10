// Side-by-side report (design doc "Suggested report shape") + JSON results.
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

export function buildMatrix(cells, clientIds) {
  const m = {};
  for (const row of ROWS) {
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
  const { run, candidate, clients, cells, isolation } = results;
  const ids = clients.map((c) => c.id);
  const matrix = buildMatrix(cells, ids);
  const lines = [];
  lines.push(`# MidBrain multi-client parity report — run ${run.runId}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Run type | ${run.simple ? 'Simple cycle — not full required coverage' : run.required ? 'Required matrix' : 'Focused validation'} |`);
  if (run.crossClientPairs) lines.push(`| Planned cross-client links | ${run.crossClientPairs.map(p => `${esc(p.writer)} → ${esc(p.reader)}`).join(', ') || 'None selected'} |`);
  lines.push(`| Candidate | \`${candidate.name}\` ${candidate.version} @ \`${candidate.shortSha}\`${candidate.dirty ? ' (dirty tree)' : ''} (${candidate.mode} mode, branch ${candidate.branch}) |`);
  if (candidate.pack && !candidate.pack.error) lines.push(`| Source archive | ${candidate.pack.filename}, ${candidate.pack.entryCount} entries, ${candidate.pack.integrity} |`);
  if (candidate.tarballSha256) lines.push(`| Tested archive SHA-256 | ${candidate.tarballSha256} |`);
  lines.push(`| Host | ${run.platform}/${run.arch} ${run.osRelease}, node ${run.node} |`);
  lines.push(`| Run marker | \`${run.marker}\` |`);
  lines.push(`| Started / finished | ${run.startedAt} / ${run.finishedAt} |`);
  lines.push(`| Read-back ceiling / index grace | ${run.readbackTimeoutMs} ms / ${run.indexGraceMs} ms |`);
  lines.push(`| Isolation (real home untouched) | ${isolation.ok ? BADGE.PASS : BADGE.FAIL}${isolation.drift.length ? ` — ${isolation.drift.length} surface(s) drifted` : ''} |`);
  lines.push('');
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
  for (const row of ROWS) {
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
  lines.push('## Cell details');
  lines.push('');
  for (const cell of cells) {
    lines.push(`### ${cell.row} · ${cell.clientDisplay || cell.client} · ${cell.scenario} — ${BADGE[cell.status]}`);
    lines.push('');
    if (cell.notes) lines.push(`${cell.notes}`, '');
    if (cell.prompt) lines.push(`Prompt: \`${esc(cell.prompt)}\``, '');
    if (cell.expected) lines.push(`Expected: ${cell.expected}`, '');
    if (cell.blockedReason) lines.push(`Blocked: ${cell.blockedReason}`, '');
    if (cell.checks && cell.checks.length) {
      lines.push('| Check | Result | Detail |');
      lines.push('|---|---|---|');
      for (const ch of cell.checks) lines.push(`| ${esc(ch.name)} | ${ch.ok ? '✅' : '❌'} | ${esc(ch.detail)} |`);
      lines.push('');
    }
    if (cell.evidence && cell.evidence.length) {
      lines.push(`Evidence: ${cell.evidence.map((e) => `\`${e}\``).join(', ')}`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
