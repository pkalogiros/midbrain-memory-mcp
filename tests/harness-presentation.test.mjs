import { expect, it } from 'vitest';
import { renderRunHtml, renderSweepHtml } from '../harness/lib/report-html.mjs';
import { summarizeCosts } from '../harness/lib/costs.mjs';
import { spawnCapture } from '../harness/lib/proc.mjs';

it('renders escaped results and explicit coverage without pretending missing costs are zero', () => {
  const results = { run: { runId: 'sample', modelChecks: true, models: { claude: '<script>bad()</script>' }, promptCount: 6 }, candidate: {}, clients: [{ id: 'claude', displayName: 'Claude' }], isolation: { ok: true }, cells: [{ client: 'claude', row: 'Recall', status: 'FAIL', checks: [{ name: '<img onerror=bad()>', ok: false }] }] };
  const html = renderRunHtml(results);
  expect(html).toContain('Infrastructure unverified');
  expect(html).toContain('FAIL');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<img onerror');
  expect(html).toContain('Not recorded');
  expect(renderSweepHtml({ rounds: [], ok: false, durationMs: 0 })).toContain('INCOMPLETE');
});

it('counts reported costs separately from unreported turns, including a real zero', () => {
  expect(summarizeCosts([{ client: 'claude', cost: 0 }, { client: 'claude', cost: 0.2 }, { client: 'codex' }])).toMatchObject({ reportedUsd: 0.2, reportedTurns: 2, totalTurns: 3, complete: false });
});

it('streams stderr before exit and supports cancellation', async () => {
  const controller = new AbortController();
  const lines = [];
  const descendant = process.platform === 'win32' ? '' : 'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"inherit"});';
  const result = await spawnCapture(process.execPath, ['-e', descendant + 'console.error("ready"); setInterval(() => {}, 1000)'], {
    timeoutMs: 3000, signal: controller.signal,
    onStderrLine: line => { lines.push(line); controller.abort(); },
  });
  expect(lines).toEqual(['ready']);
  expect(result.timedOut).toBe(false);
  expect(result.code).not.toBe(0);
});

it('separates API estimates from subscription equivalents and prices cached tokens once', async () => {
  const { estimateUsage } = await import('../harness/lib/costs.mjs');
  expect(estimateUsage('gpt-5.6-sol', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 }, 'openai')).toBeCloseTo(.00312);
  expect(estimateUsage('claude-haiku-4-5', { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 200 }, output_tokens: 100 })).toBeCloseTo(.0021);
  expect(estimateUsage('unknown', { input_tokens: 100, output_tokens: 1 })).toBeNull();
  expect(summarizeCosts([{ client: 'claude', cost: .1 }, { client: 'hermes', estimatedCost: .2 }, { client: 'codex', estimatedCost: .3, billingMode: 'chatgpt' }])).toMatchObject({ reportedUsd: .1, estimatedUsd: .2, planEquivalentUsd: .3, complete: true, totalTurns: 3 });
});

it('deduplicates NanoClaw usage across text blocks while retaining tool requests', async () => {
  const { parseTranscript } = await import('../harness/lib/nanoclaw.mjs');
  const message = id => ({ type: 'assistant', message: { id, model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 100 }, content: [] } });
  const rows = [message('old'), { type: 'user', message: { content: 'test prompt' } }, message('tool'), message('final'), message('final')];
  const result = parseTranscript(rows.map(r => JSON.stringify(r)).join('\n'), 'test prompt');
  expect(result.usage).toHaveLength(2);
  expect(result.estimatedCost).toBeCloseTo(.0012);
});

it('combines rounds without losing client coverage or mixing plan equivalents into spend', async () => {
  const { combineCosts } = await import('../harness/lib/costs.mjs');
  const round = summarizeCosts([{ client: 'claude', cost: .1 }, { client: 'codex', estimatedCost: .2, billingMode: 'chatgpt' }]);
  expect(combineCosts([round, round])).toMatchObject({ reportedUsd: .2, planEquivalentUsd: .4, totalTurns: 4, complete: true, clients: { codex: { planTurns: 2 } } });
});

it('keeps failed launches visible in cost coverage instead of dropping their prompts', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { recordedCosts } = await import('../harness/lib/costs.mjs');
  const root = mkdtempSync(join(tmpdir(), 'cost-attempt-'));
  try {
    mkdirSync(join(root, 'evidence'));
    writeFileSync(join(root, 'evidence', 'failed.prompt.json'), JSON.stringify({ client: 'nanoclaw' }));
    expect(recordedCosts(root)).toMatchObject({ totalTurns: 1, complete: false, clients: { nanoclaw: { totalTurns: 1, reportedTurns: 0 } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('recovers interrupted Claude costs from native assistant usage without duplicate blocks', async () => {
  const { estimateMessages } = await import('../harness/lib/costs.mjs');
  const message = { id: 'request-1', model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 100 } };
  expect(estimateMessages([message, message])).toMatchObject({ estimatedCost: .0006 });
  expect(estimateMessages([]).estimatedCost).toBeNull();
});

it('groups repeated API verification failures while preserving each affected check', () => {
  const failures = ['claude', 'codex'].flatMap(client => ['Freshness reconciliation', 'Rule and priming compliance'].map(row => ({ client, row, status: 'BLOCKED', reason: 'MidBrain API readback failed: This operation was aborted', checks: [] })));
  const html = renderSweepHtml({ rounds: [{ name: 'fast', models: {}, counts: { BLOCKED: 4 }, failures }], ok: false });
  expect(html.match(/Could not verify saved memories/g)).toHaveLength(1);
  expect(html).toContain('4 blocked checks');
  expect(html).toContain('does not prove that the update was lost');
  expect(html).toContain('claude');
  expect(html).toContain('Rule and priming compliance');
});

it('describes failed value checks as missing outcomes rather than positive assertions', () => {
  const html = renderSweepHtml({ rounds: [{ name: 'fast', models: {}, failures: [{ client: 'claude', row: 'Fresh-session continuity', status: 'FAIL', checks: ['stored evidence contains VALUE-example', 'answer contains VALUE-example'] }] }] });
  expect(html).toContain('Search results did not contain VALUE-example');
  expect(html).toContain('The answer did not contain VALUE-example');
  expect(html).not.toContain('stored evidence contains VALUE-example');
});

it('explains a failed recall chain from its observed cause, without implying four separate bugs', async () => {
  const { describeFailure } = await import('../harness/lib/saved-reports.mjs');
  const cell = { row: 'Cross-client recall', status: 'FAIL', checks: [{ name: 'reader made at least one MidBrain tool call', ok: false }] };
  expect(describeFailure(cell, { toolCalls: [{ name: 'ToolSearch', result: 'midbrain-memory (CONNECT_TIMEOUT): connection timed out' }] })).toMatchObject({ key: 'memory-connection', category: 'Service or runtime', title: 'The memory service did not connect' });
  expect(describeFailure(cell, { toolCalls: [{ name: 'memory_search', result: 'Memory search failed: API 401 (auth failed)' }] })).toMatchObject({ key: 'authentication' });
  expect(describeFailure({ ...cell, checks: [{ name: 'answer contains VALUE-example', ok: false }, { name: 'stored evidence contains VALUE-example', ok: true }] }, { toolCalls: [] })).toMatchObject({ key: 'answer-mismatch', category: 'Recall behavior' });
});


it('names the reader, writer, models and round before HTML disclosures and in text output', async () => {
  const { findingContext, attentionText } = await import('../harness/lib/report-copy.mjs');
  const models = { codex: 'gpt-5.6-sol', claude: 'claude-haiku-4-5' };
  const failure = { client: 'codex', scenario: 's02-cross-client-recall', row: 'Cross-client recall', status: 'FAIL', notes: 'recall from claude', diagnosis: { key: 'tool-unavailable', title: 'The client could not use memory search', what: 'No memory search was recorded.', next: 'Check the connection.' }, checks: [] };
  const html = renderSweepHtml({ rounds: [{ name: 'fast', models, failures: [failure] }] });
  const visible = html.split('<details>')[0];
  expect(visible).toContain('Codex · gpt-5.6-sol · fast round');
  expect(visible).toContain('Claude Code (claude-haiku-4-5) saved the fact; Codex (gpt-5.6-sol) was asked to recall it.');
  const text = attentionText([findingContext({ ...failure, round: 'fast' }, models)]);
  expect(text).toContain('Codex · gpt-5.6-sol · fast round');
  expect(text).toContain('Claude Code (claude-haiku-4-5)');
  expect(text).toContain('Next step: Check the connection.');
  expect(findingContext({ client: 'pi' }).context).toContain('model not recorded');
});


it('presents a completed blocked-only sweep as incomplete coverage without a failure verdict', () => {
  const html = renderSweepHtml({ ok: true, rounds: [{ name: 'fast', ok: true, report: 'report.md', isolation: true, counts: { PASS: 2, BLOCKED: 1 }, failures: [] }] });
  expect(html).toContain('class="badge neutral">BLOCKED</span>');
  expect(html).not.toContain('>FAIL</span>');
  expect(html).toContain('does not itself fail the run');
});
