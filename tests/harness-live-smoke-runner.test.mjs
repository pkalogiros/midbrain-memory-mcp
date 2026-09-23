import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../harness/lib/context.mjs';
import { runLiveSmoke } from '../harness/lib/live-smoke.mjs';
import { renderSavedReports } from '../harness/lib/saved-reports.mjs';

// Exercise the actual installer, worker, parsers, MCP proxy, API and reports.
// Package freezing has its own tests; only that expensive preparation and the
// provider-facing native executable are replaced in this orchestration test.
vi.mock('../harness/lib/candidate.mjs', () => ({
  freezeCandidate: async () => ({ mode: 'dev', repoRoot: REPO_ROOT, name: 'test-fixture-candidate', version: '0.0.0' }),
  assertCandidate: () => {},
}));
vi.mock('../harness/lib/env.mjs', async importOriginal => ({ ...await importOriginal(), loadDotEnv: () => [] }));

it.skipIf(process.platform === 'win32')('runs two real MCP scenarios through a simulated native stream, records evidence, and regenerates reports', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'live-smoke-runner-'));
  const bins = path.join(root, 'bin'); mkdirSync(bins);
  const require = createRequire(import.meta.url);
  const sdk = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href;
  const transport = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href;
  const executable = path.join(bins, 'claude');
  // No provider calls: this test double translates the supplied prompt into MCP
  // calls and emits Claude-shaped native events for the production parser.
  writeFileSync(executable, `#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {Client} from ${JSON.stringify(sdk)};
import {StdioClientTransport} from ${JSON.stringify(transport)};
if(process.argv.includes('--version')) { console.log('simulated-native-test-client'); process.exit(0); }
const prompt=process.argv[process.argv.indexOf('-p')+1];
const entry=JSON.parse(readFileSync(process.env.HOME+'/.claude.json','utf8')).mcpServers['midbrain-memory'];
const client=new Client({name:'simulated-native-test',version:'1'});
await client.connect(new StdioClientTransport({command:entry.command,args:entry.args,env:{...process.env,...entry.env},stderr:'pipe'}));
await client.listTools();
let final='';let i=0;
try {for(const match of prompt.matchAll(/with exactly (\\{[^}]+\\})/g)) {
 const input=JSON.parse(match[1]);const id='test-'+(++i);
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'mcp__midbrain-memory__memory_search',input}]}}));
 const result=await client.callTool({name:'memory_search',arguments:input});
 const content=result.content.map(c=>c.text||'').join('\\n');
 console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content}]}}));
 final=content.match(/VERIFIED_[a-f0-9]+/)?.[0]||final;
}} finally {await client.close();}
console.log(JSON.stringify({type:'result',result:final,is_error:false,num_turns:i+1}));
`, { mode: 0o700 });
  const config = path.join(root, 'models.json');
  writeFileSync(config, JSON.stringify({ models: { claude: 'simulated-test-model' }, timeoutMs: 20000 }));
  vi.stubEnv('PATH', `${bins}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-provider-secret-not-a-real-key');
  const previousCode = process.exitCode;
  try {
    const report = await runLiveSmoke({ config, root, execute: true });
    expect(report.run.promptAttempts, JSON.stringify({ failed: report.cells.flatMap(c => c.checks.filter(ch => !ch.ok)), fixture: JSON.parse(readFileSync(path.join(report.run.runDir, 'evidence/fixture-requests.json'), 'utf8')) })).toBe(2);
    expect(report.cells.map(c => [c.row, c.status])).toEqual([['Installation', 'PASS'], ['Call and consume', 'PASS'], ['Error and recovery', 'PASS']]);
    expect(report.liveScenarios.map(s => s.trace.calls.length)).toEqual([1, 2]);
    expect(report.isolation.ok).toBe(true);
    const run = report.run.runDir;
    const saved = readFileSync(path.join(run, 'results.json'), 'utf8');
    expect(saved).not.toContain('test-provider-secret-not-a-real-key');
    expect(readFileSync(path.join(run, 'report.html'), 'utf8')).toContain('Native sessions and MCP exchanges');
    expect(readFileSync(path.join(run, 'junit.xml'), 'utf8')).toContain('failures="0"');
    expect(renderSavedReports(run)).toBe(path.join(run, 'report.html'));
    expect(readFileSync(path.join(run, 'results.json'), 'utf8')).toBe(saved);
    expect(readdirSync(path.join(run, 'evidence/claude/recovery/mcp-events')).some(f => f.endsWith('.ndjson'))).toBe(true);
  } finally { process.exitCode = previousCode; vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
