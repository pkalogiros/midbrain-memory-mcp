import s01 from './s01-capture.mjs';
import s02 from './s02-cross-client-recall.mjs';
import s03 from './s03-fresh-session-continuity.mjs';
import s04 from './s04-project-global-isolation.mjs';
import s05 from './s05-freshness-reconciliation.mjs';
import s06 from './s06-no-match-clean.mjs';
import s08 from './s08-marker-robustness.mjs';
import s09 from './s09-upgrade-continuity.mjs';
import s10 from './s10-client-specific.mjs';

// Execution order matters: s01 must be the first turn of the run (cold first
// turn evidence); s10 tampers with the install and therefore runs last.
export const SCENARIOS = [s01, s06, s08, s03, s02, s05, s04, s09, s10];

export function selectScenarios(ids) {
  if (!ids || !ids.length) return SCENARIOS;
  const norm = ids.map((s) => s.trim().toLowerCase());
  const chosen = SCENARIOS.filter((s) => norm.some((n) => s.id === n || s.id.startsWith(`${n}-`) || s.id.slice(0, 3) === n));
  const unknown = norm.filter((n) => !SCENARIOS.some((s) => s.id === n || s.id.startsWith(`${n}-`) || s.id.slice(0, 3) === n));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')} (known: ${SCENARIOS.map((s) => s.id).join(', ')})`);
  return chosen;
}
