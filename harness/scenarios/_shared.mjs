// Helpers shared by scenarios: run a turn and persist it, read rows back by marker.
import path from 'node:path';
import { rowText, rowMeta } from '../lib/api.mjs';
import { check, BlockedError } from '../lib/checks.mjs';
import { readLogTail, midbrainLogPath } from '../lib/evidence.mjs';

export async function runTurn({ ctx, client, project, prompt, scenarioId, label, sessionId, resume = false, hookTrust, acceptHooks }) {
  const evidenceDir = ctx.evidenceDir(client.id, scenarioId);
  const turn = await client.runTurn({ ctx, project, prompt, sessionId, resume, evidenceDir, label, hookTrust, acceptHooks });
  const file = path.join(evidenceDir, `${label}.json`);
  ctx.writeJson(file, turn);
  turn.jsonPath = file;
  ctx.turns.push({ client: client.id, scenario: scenarioId, label, turn });
  return turn;
}

export function relEvidence(ctx, p) {
  return p ? path.relative(ctx.dirs.run, p) : null;
}

export function markerPredicate(marker) {
  return (row) => rowText(row).includes(marker);
}

/** Wait for rows carrying `marker`; returns rows split by role. */
export async function readback(ctx, api, marker, { sinceIso, minUser = 1, minAssistant = 0 } = {}) {
  const minCount = minUser + minAssistant;
  const res = await api.waitForRows({
    sinceIso,
    predicate: markerPredicate(marker),
    minCount,
    timeoutMs: ctx.options.readbackTimeoutMs,
    intervalMs: ctx.options.pollIntervalMs,
  });
  const user = res.rows.filter((r) => r.role === 'user');
  const assistant = res.rows.filter((r) => r.role === 'assistant');
  if (!res.timedOut && (user.length < minUser || assistant.length < minAssistant)) {
    // Enough rows in total but the role split is short: give it one more window.
    const again = await api.waitForRows({
      sinceIso,
      predicate: (row) => markerPredicate(marker)(row),
      minCount: minCount + 1,
      timeoutMs: Math.min(ctx.options.readbackTimeoutMs, 30000),
      intervalMs: ctx.options.pollIntervalMs,
    });
    return splitRows(again, marker);
  }
  return splitRows(res, marker);
}

function splitRows(res, marker) {
  const user = res.rows.filter((r) => r.role === 'user');
  const assistant = res.rows.filter((r) => r.role === 'assistant');
  return { marker, rows: res.rows, user, assistant, timedOut: res.timedOut, elapsedMs: res.elapsedMs, polls: res.polls, lastError: res.lastError };
}

export function metadataChecks(rows, expectedLabel) {
  const metas = rows.map(rowMeta);
  const labels = [...new Set(metas.map((m) => m.client ?? '(none)'))];
  const sessions = [...new Set(metas.map((m) => m.session_id ?? '(none)'))];
  const cwds = metas.map((m) => m.cwd ?? '');
  return [
    check(`metadata.client is "${expectedLabel}" on every row`, rows.length > 0 && labels.length === 1 && labels[0] === expectedLabel, `labels=${labels.join(',')}`),
    check('metadata.session_id present and identical across the turn', rows.length > 0 && sessions.length === 1 && sessions[0] !== '(none)' && String(sessions[0]).trim() !== '', `sessions=${sessions.length}`),
    check('metadata.cwd present and home-relative on every row', rows.length > 0 && cwds.every((c) => typeof c === 'string' && c.startsWith('~')), `cwd sample=${cwds[0] || '(none)'}`),
  ];
}

export function turnChecks(turn) {
  return [
    check('client process exited 0 with a final message', turn.exitCode === 0 && !turn.timedOut && !turn.isError && turn.finalText.trim().length > 0, `exit=${turn.exitCode} timedOut=${turn.timedOut} isError=${turn.isError} textLen=${turn.finalText.length}`),
  ];
}

export function logSnippet(ctx, clientId, re) {
  const text = readLogTail(midbrainLogPath(ctx, clientId), 400000);
  return text.split('\n').filter((l) => re.test(l)).slice(-6).join(' | ');
}

export function cell({ row, scenario, client, checks = [], prompt = '', expected = '', evidence = [], notes = '', status, blockedReason }) {
  let st = status;
  if (!st) st = blockedReason ? 'BLOCKED' : (checks.length && checks.every((c) => c.ok) ? 'PASS' : (checks.length ? 'FAIL' : 'BLOCKED'));
  return { row, scenario, client: client.id, clientDisplay: client.displayName, status: st, checks, prompt, expected, evidence: evidence.filter(Boolean), notes, blockedReason: blockedReason || null };
}

export function blockedCells(rows, scenario, client, reason, extra = {}) {
  return rows.map((row) => cell({ row, scenario, client, blockedReason: reason, ...extra }));
}

export function sinceNow() {
  return new Date(Date.now() - 60000).toISOString();
}

export async function grace(ctx) {
  const ms = ctx.options.indexGraceMs;
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export function requireSecret(ctx, name) {
  if (!ctx.secrets[name]) throw new BlockedError(`secret ${name} not provided`);
  return ctx.secrets[name];
}
