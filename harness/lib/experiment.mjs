import { readFileSync } from 'node:fs';
import { check, memoryEvidence } from './checks.mjs';

export const SIMPLE_SCENARIOS = { capture: 's01', recall: 's03', unrelated: 's06' };
const defaults = {
  capture: 'Remember this fact for task {{marker}}: the verification value is {{value}}. Acknowledge briefly and include the task identifier.',
  recall: 'Search MidBrain for task {{marker}} and return its exact verification value. Do not guess.',
  unrelated: 'What is the capital of Australia? Answer in one short sentence.',
};
export function loadExperiment(file, knownClients) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const allowed = ['clients', 'models', 'scenarios', 'prompts'];
  if (!config || Array.isArray(config) || Object.keys(config).some(k => !allowed.includes(k))) throw new Error('Experiment supports clients, models, scenarios and prompts only. Keep credentials in the environment.');
  const clients = config.clients || Object.keys(config.models || {});
  if (!Array.isArray(clients) || !clients.length || new Set(clients).size !== clients.length || clients.some(c => !knownClients.includes(c))) throw new Error('Experiment clients must be a nonempty list of known client IDs.');
  if (config.models && (typeof config.models !== 'object' || Array.isArray(config.models) || Object.entries(config.models).some(([id, m]) => !clients.includes(id) || typeof m !== 'string' || !m.trim()))) throw new Error('Models must map selected clients to nonempty model names.');
  const scenarios = config.scenarios || Object.keys(SIMPLE_SCENARIOS);
  if (!Array.isArray(scenarios) || !scenarios.length || new Set(scenarios).size !== scenarios.length || scenarios.some(s => !SIMPLE_SCENARIOS[s]) || (scenarios.includes('recall') && !scenarios.includes('capture'))) throw new Error('Choose capture, recall and/or unrelated; recall requires capture.');
  if (config.prompts && (typeof config.prompts !== 'object' || Array.isArray(config.prompts))) throw new Error('prompts must be an object.');
  for (const [name, spec] of Object.entries(config.prompts || {})) {
    if (!SIMPLE_SCENARIOS[name] || !spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(k => !['prompt','criteria'].includes(k))) throw new Error('Each prompt supports prompt and criteria only.');
    if (spec.prompt !== undefined && (typeof spec.prompt !== 'string' || !spec.prompt.trim())) throw new Error('Prompt must be a nonempty string.');
    const prompt = spec.prompt || defaults[name];
    if (name === 'capture' && (!prompt.includes('{{marker}}') || !prompt.includes('{{value}}'))) throw new Error('Capture prompt must include {{marker}} and {{value}}.');
    if (name === 'recall' && (!prompt.includes('{{marker}}') || prompt.includes('{{value}}'))) throw new Error('Recall prompt must include {{marker}} and must not disclose {{value}}.');
    if ([...prompt.matchAll(/{{(.*?)}}/g)].some(m => !['marker','value','client'].includes(m[1]))) throw new Error('Unknown prompt placeholder. Use {{marker}}, {{value}} or {{client}}.');
    if (spec.criteria !== undefined && (!spec.criteria || typeof spec.criteria !== 'object' || Array.isArray(spec.criteria))) throw new Error('criteria must be an object.');
    for (const [kind, values] of Object.entries(spec.criteria || {})) {
      if (!['contains','notContains','memoryContains'].includes(kind) || !Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v)) throw new Error('Criteria must be nonempty string arrays: contains, notContains, memoryContains.');
    }
    if (name === 'unrelated' && spec.prompt && !Object.keys(spec.criteria || {}).length) throw new Error('A custom unrelated prompt requires explicit criteria.');
  }
  return { ...config, clients, scenarios };
}
export const expand = (text, vars) => text.replace(/{{(marker|value|client)}}/g, (_, key) => vars[key] ?? '');
export function experimentPrompt(ctx, name, vars) {
  return expand(ctx.options.experiment?.prompts?.[name]?.prompt || defaults[name], vars);
}
export function experimentChecks(ctx, name, turn, vars) {
  return Object.entries(ctx.options.experiment?.prompts?.[name]?.criteria || {}).flatMap(([kind, values]) => values.map(v => {
    const value = expand(v, vars);
    const found = kind === 'memoryContains' ? memoryEvidence(turn).some(s => s.includes(value)) : turn.finalText.includes(value);
    return check(`custom ${kind}: ${value}`, kind === 'notContains' ? !found : found);
  }));
}
