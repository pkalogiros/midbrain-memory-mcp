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
