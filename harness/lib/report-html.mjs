import { runOutcome } from './checks.mjs';
import { failedCheckText, findingContext } from './report-copy.mjs';
import { ROWS, buildMatrix } from './report.mjs';
import { combineCosts } from './costs.mjs';
import { renderDrySmokeHtml } from './dry-smoke-report.mjs';
import { renderLiveSmokeHtml } from './live-smoke-report.mjs';
import { renderScriptedHtml } from './scripted-smoke-report.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const duration = ms => Number.isFinite(ms) ? `${Math.floor(Math.round(ms / 1000) / 60)}m ${Math.round(ms / 1000) % 60}s` : 'Not recorded';
const badge = status => `<span class="badge ${status === 'PASS' ? 'pass' : /FAIL/.test(status || '') ? 'fail' : 'neutral'}">${esc(status || 'Not run')}</span>`;
const table = (heads, rows) => `<div class="scroll"><table><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const stats = entries => `<div class="stats">${entries.map(([label, value]) => `<div><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('')}</div>`;

const money = n => `$${Number(n || 0).toFixed(4)}`;
const coverage = c => c ? `${c.reportedTurns + (c.estimatedTurns || 0) + (c.planTurns || 0)} / ${c.totalTurns}` : 'Not recorded';
const apiCost = c => c && (c.reportedTurns || c.estimatedTurns) ? money(c.reportedUsd + (c.estimatedUsd || 0)) : '—';

function costsPanel(costs) {
  if (!costs?.totalTurns) return '<p>Not recorded.</p>';
  const missing = costs.totalTurns - costs.reportedTurns - (costs.estimatedTurns || 0) - (costs.planTurns || 0);
  return `<h2>Model costs</h2>${stats([['Available API subtotal', costs.reportedTurns || costs.estimatedTurns ? money(costs.reportedUsd + (costs.estimatedUsd || 0)) : 'Not recorded'], ['Codex plan equivalent', costs.planTurns ? money(costs.planEquivalentUsd) : '—'], ['Attempts with cost records', coverage(costs)]])}
    <p>The API subtotal combines reported amounts and estimates. The plan equivalent estimates what ChatGPT-backed usage would cost through the API; it is <strong>not an extra charge</strong>.</p>
    ${table(['Client', 'Reported', 'Estimated', 'Plan equivalent', 'Cost records'], Object.entries(costs.clients || {}).map(([id, c]) => [esc(id), c.reportedTurns ? money(c.reportedUsd) : '—', c.estimatedTurns ? money(c.estimatedUsd) : '—', c.planTurns ? money(c.planEquivalentUsd) : '—', esc(coverage(c))]))}
    <p class="muted">${missing ? `${missing} prompt attempts have no cost record. ` : ''}${costs.incompleteTurns ? `${costs.incompleteTurns} interrupted-turn estimates may omit some usage. ` : ''}This is not a complete invoice. Runner and backend costs are excluded. A dash means no amount recorded in that category.</p>`;
}


function attention(items) {
  if (!items.length) return '<p>No failing or blocked checks recorded.</p>';
  const groups = new Map();
  for (const item of items) {
    const reason = item.reason || item.blockedReason || '';
    const readback = reason.startsWith('MidBrain API readback failed:');
    const diagnosis = item.diagnosis || (readback ? { key: 'readback', category: 'Service or runtime', title: 'Could not verify saved memories', what: 'The request to read saved memories back failed. This does not prove that the update was lost.', next: 'Check the MidBrain API, then rerun the affected checks.' } : { key: `check:${item.row}`, category: 'Needs investigation', title: item.row, what: 'The expected outcome was not verified. See the recorded observations below.', next: 'Review the affected checks before deciding on a fix.' });
    if (!groups.has(diagnosis.key)) groups.set(diagnosis.key, { diagnosis, items: [] });
    groups.get(diagnosis.key).items.push({ ...item, reason });
  }
  const ordered = [...groups.values()].sort((a, b) => Number(b.diagnosis.category === 'Service or runtime') - Number(a.diagnosis.category === 'Service or runtime'));
  return `<p class="muted">Grouped by what happened. One interrupted test can affect several checks; the counts below are not separate bugs. Original scores are preserved.</p>` + ordered.map(({ diagnosis: d, items: affected }) => {
    const tests = new Map();
    for (const item of affected) {
      const key = [item.round, item.client, item.model, item.scenario || item.row, item.writer].join(':');
      if (!tests.has(key)) tests.set(key, { ...item, rows: [], checks: [] });
      const test = tests.get(key); test.rows.push(item.row); test.checks.push(...(item.checks || []));
    }
    const blocked = affected.every(i => i.status === 'BLOCKED');
    return `<section class="issue"><div class="issue-heading"><h3>${esc(d.title)}</h3><span class="badge neutral">${esc(d.category)}</span></div><ul class="affected-context">${[...tests.values()].map(i => `<li><strong>${esc(i.context)}</strong><br>${esc(i.test)}</li>`).join('')}</ul><p>${esc(d.what)}</p><p><strong>Next step:</strong> ${esc(d.next)}</p><p class="muted">${affected.length} ${blocked ? 'blocked' : 'affected'} ${affected.length === 1 ? 'check' : 'checks'} · ${tests.size} ${tests.size === 1 ? 'test execution' : 'test executions'} · ${esc([...new Set(affected.map(i => i.client))].join(', '))}</p><details><summary>Which tests were affected?</summary>${[...tests.values()].map(i => `<div class="affected-test"><h4>${esc(i.context)}</h4><p>${esc(i.test)}</p><p class="muted">Original result: ${esc(i.status)} · ${esc(i.rows.join('; '))}</p><details><summary>Recorded observations and original checks</summary>${i.reason ? `<p>${esc(i.reason)}</p>` : ''}<ul>${[...new Set(i.checks.map(c => typeof c === 'string' ? c : c.name))].map(c => `<li>${esc(failedCheckText(c))}</li>`).join('')}</ul></details></div>`).join('')}</details></section>`;
  }).join('');
}

function page(title, verdict, scope, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · MidBrain</title><style>
  :root{color-scheme:light;font-family:system-ui,sans-serif;color:#193b34;background:#f5f6f1}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;padding:48px 28px}header{border-bottom:1px solid #cbd8cf;padding-bottom:28px}h1{font-size:clamp(30px,5vw,48px);letter-spacing:-.04em;margin:14px 0}h2{margin:36px 0 16px;font-size:23px}p{line-height:1.65}.eyebrow,small{text-transform:uppercase;letter-spacing:.09em;font-size:11px;color:#526b60}.scope{background:#fff4d7;border-left:4px solid #c6922e;padding:14px 18px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:24px 0}.stats>div{background:white;padding:20px;border:1px solid #d6dfd7;border-radius:10px}.stats strong{display:block;font-size:25px;margin-top:7px}.badge{display:inline-block;white-space:nowrap;font-size:12px;font-weight:700;border-radius:5px;padding:6px 9px}.pass{background:#dceddf;color:#235632}.fail{background:#f8dfdc;color:#8d3026}.neutral{background:#e8ebe7;color:#56645b}.scroll{overflow:auto;border:1px solid #d6dfd7;border-radius:9px;background:white}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:13px 15px;border-bottom:1px solid #e1e7e0;vertical-align:top}th{background:#e8eee5}td:first-child{min-width:110px}td{overflow-wrap:anywhere}details{background:white;border:1px solid #d6dfd7;border-radius:8px;margin:10px 0;padding:16px}summary{cursor:pointer;font-weight:600}li{line-height:1.65;margin:7px 0}code{overflow-wrap:anywhere}.muted{color:#526b60;font-size:13px}.issue{background:white;border:1px solid #d6dfd7;border-radius:10px;padding:20px;margin:14px 0}.issue-heading{display:flex;justify-content:space-between;align-items:start;gap:16px}.affected-test{padding:14px 0;border-bottom:1px solid #e1e7e0}.affected-test:last-child{border-bottom:0}h4{margin:0;font-size:15px}h3{font-size:18px;margin:0;line-height:1.4}.issue p{margin:12px 0}.issue details{margin:0;border:0;border-top:1px solid #e1e7e0;border-radius:0;padding:14px 0 0}.issue li p{font-family:monospace;font-size:12px;overflow-wrap:anywhere}footer{font-size:12px;color:#526b60;border-top:1px solid #cbd8cf;margin-top:38px;padding-top:20px}@media(max-width:600px){main{padding:26px 16px}.stats{grid-template-columns:1fr 1fr}.stats strong{font-size:21px}}@media print{body{background:white}main{padding:0}.scroll{overflow:visible}table{font-size:10px}th,td{padding:7px}details{break-inside:avoid}.stats>div{padding:10px}}
  </style><main><header><div class="eyebrow">MidBrain / integration testing</div><h1>${esc(title)}</h1>${badge(verdict)}<p class="scope">${esc(scope)}</p></header>${body}<footer>Offline results summary. Raw transcripts and credential-bearing test homes are not embedded. Where model costs are shown, they exclude unreported usage, runner and backend costs.</footer></main></html>`;
}

export function renderRunHtml({ schemaVersion, run, candidate, clients, cells, isolation, contextPreviews, liveScenarios, scriptedEvidence }) {
  if (run.kind === 'scripted-smoke') return renderScriptedHtml({ schemaVersion, run, candidate, clients, cells, isolation, scriptedEvidence });
  if (run.kind === 'live-smoke') return renderLiveSmokeHtml({ schemaVersion, run, candidate, clients, cells, isolation, liveScenarios });
  if (run.kind === 'dry-smoke') return renderDrySmokeHtml({ schemaVersion, run, candidate, clients, cells, isolation, contextPreviews });
  const failed = cells.filter(c => c.status !== 'PASS');
  const outcome = run.finishedAt ? runOutcome(cells, isolation?.ok === true) : 'INCOMPLETE';
  const scope = run.profile === 'high' ? 'High: all scenarios and upgrades, with one cross-client cycle. Not the required release gate.' : run.profile === 'xhigh' ? 'XHigh: full matrix and upgrades. Release approval still requires passing the required evidence gate.' : run.quickSimple ? 'Simple: capture, fresh-session recall and an unrelated question; three prompts per client by default.' : run.followup ? `Model checks with prior infrastructure evidence from baseline ${run.followup.baselineRunId}. Those checks were not rerun; this is not full required coverage.` : run.modelChecks ? 'Infrastructure unverified. Six-prompt model checks only; upgrade, project isolation and client-specific cases were omitted.' : run.required ? 'Required matrix execution. A passing report still requires the separate release evidence verification.' : 'Reduced or focused coverage. This report is not full required release sign-off.';
  const matrix = buildMatrix(cells, clients.map(c => c.id));
  const failures = attention(failed.map(c => (findingContext({ ...c, checks: (c.checks || []).filter(ch => !ch.ok) }, run.models))));
  return page('Run results', outcome, scope,
    stats([['Elapsed', duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))], ['Prompt attempts', run.costs?.totalTurns ?? run.promptCount ?? 'Not recorded'], ['Passed checks', cells.filter(c => c.status === 'PASS').length], ['Failed checks', cells.filter(c => c.status === 'FAIL').length], ['Blocked checks', cells.filter(c => c.status === 'BLOCKED').length]]) +
    `<p>Run <code>${esc(run.runId)}</code> · Candidate <code>${esc(candidate.version)} @ ${esc(candidate.shortSha)}</code>${candidate.dirty ? ' (dirty source)' : ''} · Workers: ${esc(run.concurrency ?? 1)} · Real-home isolation: ${badge(isolation?.ok === true ? 'PASS' : isolation?.ok === false ? 'FAIL' : 'Not recorded')}</p>` +
    `<h2>What needs attention</h2>${failures}${costsPanel(run.costs)}<details><summary>Models and client versions</summary>${table(['Client', 'Version', 'Model'], clients.map(c => [esc(c.displayName || c.id), esc(c.version || 'Not recorded'), esc(run.models?.[c.id] || 'Not recorded')]))}</details><h2>Coverage matrix</h2>${table(['Check', ...clients.map(c => c.displayName || c.id)], ROWS.map(row => [esc(row), ...clients.map(c => badge(matrix[row][c.id]))]))}`);
}

export function renderSweepHtml(summary) {
  const rows = summary.rounds || [];
  const counts = rows.reduce((a, r) => { for (const [k, n] of Object.entries(r.counts || {})) a[k] = (a[k] || 0) + n; return a; }, {});
  const costs = summary.costs || combineCosts(rows.map(r => r.costs));
  const scope = summary.profile === 'high' ? 'High: all scenarios and upgrades, with a directed cross-client cycle for each round’s selected clients. Not release sign-off.' : summary.profile === 'xhigh' ? 'XHigh: all scenarios and upgrades, with every ordered cross-client pair for each round’s selected clients. Not release sign-off.' : summary.profile === 'simple' ? 'Simple: three prompts per client covering capture, fresh-session recall and an unrelated answer. Upgrade and client-specific checks are omitted.' : summary.infrastructureVerified ? `Model checks with verified prior baseline ${summary.baseline}; not full required coverage.` : 'Infrastructure unverified. This sweep compares model behavior; upgrade, project isolation and client-specific cases were omitted.';
  const finished = rows.length && rows.every(r => r.report);
  const findings = rows.flatMap(r => r.failures || []);
  const serviceChecks = findings.filter(f => f.diagnosis?.category === 'Service or runtime').length;
  const interpretation = serviceChecks ? `<p><strong>Service and runtime problems affected ${serviceChecks} checks.</strong> ${findings.length - serviceChecks} other checks need separate review. The findings below explain what happened and where to start.</p>` : '';
  return page('Model sweep results', !rows.length || !finished ? 'INCOMPLETE' : rows.some(r => r.ok === false || r.isolation === false || r.counts?.FAIL || r.counts?.FLAKY) ? 'FAIL' : counts.BLOCKED ? 'BLOCKED' : 'PASS', scope,
    `<p>${finished ? '<strong>The sweep finished and produced results.</strong> ' : ''}Passed checks met their expectations. Failed checks did not. Blocked checks could not be evaluated because a prerequisite failed. BLOCKED means incomplete coverage and does not itself fail the run.</p>` +
    stats([['Elapsed', duration(summary.durationMs)], ['Passed checks', counts.PASS || 0], ['Failed checks', counts.FAIL || 0], ['Blocked checks', counts.BLOCKED || 0]]) +
    `<p class="muted">${esc(costs.totalTurns || 'Unknown')} prompt attempts · ${esc(summary.totalWorkers)} workers · ${esc(summary.parallelRuns)} parallel rounds · Real-home isolation: ${badge(rows.length && rows.every(r => r.isolation === true) ? 'PASS' : rows.some(r => r.isolation === false) ? 'FAIL' : 'Not recorded')}</p>` +
    interpretation + `<h2>What needs attention</h2>${attention(rows.flatMap(r => (r.failures || []).map(f => findingContext({ ...f, round: r.name }, r.models))))}` +
    `<h2>Round comparison</h2>${table(['Round', 'Time', 'Passed', 'Failed', 'Blocked', 'API subtotal'], rows.map(r => [esc(r.name), esc(duration(r.durationMs)), esc(r.counts?.PASS ?? '—'), esc(r.counts?.FAIL ?? '—'), esc(r.counts?.BLOCKED ?? '—'), esc(apiCost(r.costs))]))}<p class="muted">API subtotals include estimates. Subscription equivalents and accounting gaps are shown below.</p>` +
    costsPanel(costs) +
    `<details><summary>Models used in each round</summary>${table(['Round', 'Client', 'Model'], rows.flatMap(r => Object.entries(r.models || {}).map(([id, model]) => [esc(r.name), esc(id), esc(model)])))}</details>`);
}
