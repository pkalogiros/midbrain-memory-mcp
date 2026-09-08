// Deterministic check helpers and the cell status rules (design doc §5.1).
export class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BlockedError';
    this.blocked = true;
  }
}

export function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: detail === undefined || detail === null ? '' : String(detail) };
}

export function statusFromChecks(checks) {
  if (!checks || checks.length === 0) return 'BLOCKED';
  return checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
}

export function runExitCode(cells, isolationOk) {
  return isolationOk && cells.length > 0 && cells.every(c => c.status === 'PASS') ? 0 : 1;
}

export const NO_MATCH_FORBIDDEN = [
  /midbrain/i,
  /memory_search/i,
  /check_session_status/i,
  /episodic/i,
  /not found after search/i,
  /\bMBH-/,
];

export function isMidbrainTool(call) {
  const n = String(call?.name || '');
  return /midbrain/i.test(n) || /midbrain/i.test(String(call?.server || ''));
}

export function isDiscoveryTool(call) {
  const n = String(call?.name || '');
  return /^ToolSearch$/i.test(n) || /tool_search/i.test(n) || /tool_describe/i.test(n);
}

export function isMemoryOrDiscovery(call) {
  return isMidbrainTool(call) || isDiscoveryTool(call);
}

export function inputText(call) {
  try {
    return typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {});
  } catch {
    return '';
  }
}

export function resultText(call) {
  const r = call?.result;
  if (r === null || r === undefined) return '';
  if (typeof r === 'string') return r;
  try { return JSON.stringify(r); } catch { return ''; }
}

export function resultLooksEmpty(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return /no (results|matches|memories|episodic)|not found|0 results|nothing (found|matched)/i.test(t) && t.length < 400;
}

export function forbiddenHits(text, patterns = NO_MATCH_FORBIDDEN) {
  return patterns.filter((p) => p.test(String(text || ''))).map((p) => p.source);
}

/** S7: memory-first ordering, anchor preservation, search-deeper. */
export function complianceChecks(turn, marker) {
  const calls = turn.toolCalls || [];
  const first = calls[0];
  const memCalls = calls.filter(isMidbrainTool);
  const checks = [];
  checks.push(check(
    'memory-first: first tool call is MidBrain discovery or search',
    first ? isMemoryOrDiscovery(first) : false,
    first ? `first=${first.name}` : 'no tool calls',
  ));
  checks.push(check(
    'anchor preserved: marker appears verbatim in a MidBrain query',
    memCalls.some((c) => inputText(c).includes(marker)),
    `memory calls=${memCalls.length}`,
  ));
  const emptyIdx = memCalls.findIndex((c) => resultLooksEmpty(resultText(c)));
  if (emptyIdx >= 0) {
    const later = memCalls.slice(emptyIdx + 1);
    const widened = later.some((c) => {
      const inp = c.input && typeof c.input === 'object' ? c.input : {};
      const lim = Number(inp.limit ?? inp.arguments?.limit);
      return (Number.isFinite(lim) && lim >= 50) || c.name !== memCalls[emptyIdx].name;
    });
    checks.push(check(
      'search deeper: an empty result was followed by a wider or different search',
      widened,
      `empty at memory call #${emptyIdx + 1}, later memory calls=${later.length}`,
    ));
  } else {
    checks.push(check('search deeper: not triggered (no empty MidBrain result)', true, 'n/a'));
  }
  return checks;
}

// Answers alone are never retrieval evidence. Values are disclosed only to the
// writer; every required value must occur in a successful MidBrain result.
export function recallChecks(turn, anchor, values) {
  const calls = (turn.toolCalls || []).filter(c => isMidbrainTool(c) && c.ok === true);
  return [
    check('successful MidBrain query preserves the exact anchor', calls.some(c => inputText(c).includes(anchor))),
    ...values.flatMap(value => [
      check(`stored evidence contains ${value}`, calls.some(c => resultText(c).includes(value))),
      check(`answer contains ${value}`, turn.finalText.includes(value)),
    ]),
  ];
}

export function currentAnswerChecks(text, expected) {
  let answer;
  try { answer = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid answer */ }
  return [
    check('answer names the current value unambiguously', answer?.current === expected),
    check('answer cites evidence', typeof answer?.evidence === 'string' && answer.evidence.trim().length > 0),
  ];
}

export function captureCountChecks(rows, turn) {
  const users = rows.filter(r => r.role === 'user');
  const assistants = rows.filter(r => r.role === 'assistant');
  const native = turn.nativeAssistantMessages;
  const checks = [check('exactly one captured user request', users.length === 1, `user rows=${users.length}`)];
  if (!native) {
    checks.push(check('exactly one captured assistant response', assistants.length === 1, `assistant rows=${assistants.length}`));
    return checks;
  }
  const expected = native.map(m => m.text).sort();
  const actual = assistants.map(r => String(r.text ?? r.content ?? '')).sort();
  checks.push(check('every native assistant response captured exactly once', expected.length > 0 && JSON.stringify(expected) === JSON.stringify(actual), `native=${expected.length} captured=${actual.length}`));
  return checks;
}
