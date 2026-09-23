import { check, isDiscoveryTool, resultText } from './checks.mjs';
import { DRY_SMOKE_CLIENTS } from './dry-smoke-policy.mjs';

export const LIVE_ROWS = ['Installation', 'Call and consume', 'Error and recovery'];
export const LIVE_SCOPE = 'Real model turns in native clients, exercising the packaged MCP against a synthetic local API. This tests explicitly requested tool execution and result delivery, not memory quality, spontaneous tool selection, production service reliability or capture correctness.';

export function liveOpenCodeConfig(current, model) {
  return { ...current, model, small_model: model, enabled_providers: [model.split('/')[0]],
    autoupdate: false, share: 'disabled', compaction: { auto: false, prune: false },
    agent: { title: { disable: true }, summary: { disable: true } } };
}

export function buildLivePlan(flags, config) {
  for (const key of Object.keys(flags)) if (!['_', 'config', 'clients', 'root', 'execute', 'plan', 'install-clients'].includes(key)) throw new Error(`live-smoke does not accept --${key}`);
  if (flags._?.length) throw new Error('live-smoke does not accept positional arguments');
  for (const key of ['execute', 'plan', 'install-clients']) if (flags[key] !== undefined && flags[key] !== true) throw new Error(`--${key} is a boolean flag`);
  if (flags.execute && flags.plan) throw new Error('Choose --plan or --execute');
  for (const key of ['config', 'clients', 'root']) if (flags[key] !== undefined && (typeof flags[key] !== 'string' || !flags[key].trim())) throw new Error(`--${key} requires a value`);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('A JSON configuration object is required');
  for (const key of Object.keys(config)) if (!['models', 'timeoutMs', 'maxMcpCalls'].includes(key)) throw new Error(`Unknown live-smoke config field: ${key}`);
  if (!config.models || Array.isArray(config.models) || typeof config.models !== 'object') throw new Error('Configure an explicit model for every selected client');
  const clients = flags.clients ? flags.clients.split(',').map(s => s.trim()) : Object.keys(config.models);
  if (!clients.length || new Set(clients).size !== clients.length) throw new Error('Select at least one client, without duplicates');
  for (const id of [...clients, ...Object.keys(config.models)]) if (!DRY_SMOKE_CLIENTS.includes(id)) throw new Error(`Unsupported live-smoke client: ${id}`);
  const models = {};
  for (const id of clients) {
    const model = config.models[id];
    if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,149}$/.test(model) || /latest|select_|replace|your.model|placeholder/i.test(model)) throw new Error(`Set an explicit model ID for ${id}; implicit/latest/placeholder models are not accepted`);
    if (id === 'opencode' && !/^(anthropic|openai)\/.+/.test(model)) throw new Error('OpenCode model must use anthropic/model or openai/model');
    models[id] = model;
  }
  const timeoutMs = config.timeoutMs ?? 90000;
  const maxMcpCalls = config.maxMcpCalls ?? 4;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 180000) throw new Error('timeoutMs must be 10000–180000');
  if (!Number.isInteger(maxMcpCalls) || maxMcpCalls < 2 || maxMcpCalls > 8) throw new Error('maxMcpCalls must be 2–8');
  return { kind: 'live-smoke', execute: flags.execute === true, clients, models, timeoutMs, maxMcpCalls, scenarios: clients.length * 2,
    credentials: Object.fromEntries(clients.map(id => [id, id === 'codex' || (id === 'opencode' && models[id].startsWith('openai/')) ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'])),
    limits: 'Two fresh native sessions per client; no harness retries or model fallback. Each session has a wall-clock deadline and MCP call cap. Native provider retries and internal requests may occur. This is not a hard dollar or token cap.' };
}

export function liveSmokeOutcome(report) {
  if (!report.run.complete) return 'INCOMPLETE';
  if (!report.isolation?.ok || report.run.error || report.cells.some(c => c.status === 'FAIL' || (c.status === 'PASS' && (!c.checks?.length || c.checks.some(ch => ch.ok !== true))))) return 'FAIL';
  const expected = report.clients.flatMap(c => LIVE_ROWS.map(row => [c.id, row]));
  if (!expected.length || expected.some(([id, row]) => report.cells.filter(c => c.client === id && c.row === row).length !== 1) || report.cells.length !== expected.length || report.cells.some(c => c.status !== 'PASS')) return 'BLOCKED';
  return 'PASS';
}

const searchNames = new Set(['mcp__midbrain-memory__memory_search', 'mcp__midbrain_memory__memory_search', 'midbrain-memory__memory_search', 'midbrain-memory_memory_search', 'midbrain_memory_search', 'mcp_midbrain_memory_memory_search', 'mcp_midbrain-memory_memory_search']);
const isSearch = c => searchNames.has(c.name) || (c.name === 'memory_search' && c.server === 'midbrain-memory');
const argsMatch = (args, query) => args?.query === query && args.memory_type === 'semantic' && args.limit === 1 && Object.keys(args).every(k => ['query', 'memory_type', 'limit'].includes(k));
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');

/** Four independent receipts must support the same round trip. Answers alone cannot pass. */
export function scoreLiveScenario(scenario, { turn, trace, requests, unexpected = [] }, maxMcpCalls = 4) {
  const native = turn.toolCalls || [];
  const wire = trace.calls || [];
  const targets = scenario.id === 'recovery' ? [
    { query: scenario.errorQuery, value: scenario.errorValue, status: 503 },
    { query: scenario.query, value: scenario.value, status: 200 },
  ] : [{ query: scenario.query, value: scenario.value, status: 200 }];
  const searches = native.filter(isSearch);
  const checks = [
    check('Native session finished successfully within its deadline', turn.exitCode === 0 && !turn.isError && !turn.timedOut && !turn.workerTimedOut),
    check('MCP evidence is complete and unambiguous', !trace.issues?.length && wire.length === targets.length && new Set(wire.map(c => c.id)).size === wire.length && wire.every(c => ['returned', 'tool-error'].includes(c.status))),
    check('Native client discovered the real search tool', trace.discoveries?.some(d => d.tools?.some(t => t.name === 'memory_search' && t.inputSchema?.type === 'object'))),
    check('Only requested MCP calls and tool discovery were used', native.length <= maxMcpCalls + 4 && native.every(c => isSearch(c) || isDiscoveryTool(c)) && searches.length === targets.length && new Set(searches.map(c => c.id)).size === searches.length && searches.every(c => c.id)),
    check('MCP call budget respected', wire.length <= maxMcpCalls && !trace.limitExceeded),
    check('Fixture received no unexpected requests', unexpected.length === 0),
  ];
  targets.forEach((target, index) => {
    const call = searches[index]; const exchange = wire[index]; const request = requests[index];
    checks.push(check(`${target.status === 503 ? 'Controlled error' : 'Successful call'}: native arguments and returned value match`, Boolean(call && argsMatch(call.input, target.query) && resultText(call).includes(target.value) && (target.status !== 200 || call.ok === true))));
    checks.push(check(`${target.status === 503 ? 'Controlled error' : 'Successful call'}: MCP transport agrees with native evidence`, Boolean(exchange?.name === 'memory_search' && argsMatch(exchange.args, target.query) && text(exchange.result).includes(target.value) && (target.status === 503 ? exchange.result?.isError === true : exchange.result?.isError !== true))));
    // memory_search overfetches 3x before filtering semantic results locally.
    checks.push(check(`${target.status === 503 ? 'Controlled error' : 'Successful call'}: fixture HTTP contract agrees`, Boolean(request?.query === target.query && request.method === 'GET' && request.path === '/api/v1/memories/search/semantic' && request.limit === '3' && request.memory_type === null && request.key === 'fixture' && request.status === target.status && request.value === target.value)));
  });
  checks.push(check('Exactly the expected backend requests were observed', requests.length === targets.length));
  if (scenario.id === 'recovery') checks.push(check('Recovery starts after the error returns on the same MCP connection', wire.length === 2 && wire[0].connection === wire[1].connection && Number.isFinite(Date.parse(wire[0].completedAt)) && Date.parse(wire[1].startedAt) >= Date.parse(wire[0].completedAt)));
  checks.push(check('Final answer contains the fresh value delivered through MCP', typeof turn.finalText === 'string' && turn.finalText.includes(scenario.value)));
  return checks;
}
