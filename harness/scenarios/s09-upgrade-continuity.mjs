import { cell } from './_shared.mjs';

export default {
  id: 's09-upgrade-continuity',
  title: 'Upgrade continuity',
  kind: 'single',
  parity: true,
  rows: ['Upgrade and self-repair'],
  async run({ ctx, client, candidate }) {
    const done = ctx.meta.upgradeCells && ctx.meta.upgradeCells[client.id];
    if (done) return [done];
    const expected = 'Install the previous published release from the loopback registry, capture, publish the candidate as latest, upgrade through the documented user path, verify old memory recalls and new sessions capture on the candidate.';
    const reason = candidate.mode === 'registry'
      ? 'run with --upgrade to execute the upgrade prelude before the matrix'
      : `candidate mode is "${candidate.mode}"; upgrade continuity requires --mode registry --upgrade`;
    return [cell({ row: 'Upgrade and self-repair', scenario: this.id, client, expected, blockedReason: reason })];
  },
};
