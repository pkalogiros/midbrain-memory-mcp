import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRunContext, REPO_ROOT } from '../harness/lib/context.mjs';
import { smokeEnv } from '../harness/lib/dry-smoke-policy.mjs';
import { writeGlobalKey, writeGlobalHostConfig } from '../harness/lib/home.mjs';
import { startLiveSmokeApi } from '../harness/lib/live-smoke-fixture.mjs';
import { readLiveTrace } from '../harness/lib/live-smoke-evidence.mjs';

describe('live-smoke recording proxy', () => {
  it('passes real tool schemas/results unchanged, records failures and enforces a shared budget', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'live-smoke-proxy-'));
    const ctx = createRunContext({ root });
    const api = await startLiveSmokeApi();
    const clients = [];
    try {
      writeGlobalKey(ctx, api.key); writeGlobalHostConfig(ctx, api.url);
      const traceDir = path.join(ctx.dirs.run, 'trace'); mkdirSync(traceDir);
      const spec = path.join(ctx.dirs.run, 'proxy.json');
      writeFileSync(spec, JSON.stringify({ entry: { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')] }, traceDir, maxMcpCalls: 2 }));
      const connect = async () => {
        const client = new Client({ name: 'proxy-test', version: '1' }); clients.push(client);
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO_ROOT, 'harness/lib/live-smoke-proxy.mjs'), spec], env: smokeEnv(ctx, { MIDBRAIN_CLIENT: 'generic', MIDBRAIN_DEV: '1' }), stderr: 'pipe' }));
        return client;
      };
      const first = await connect();
      expect((await first.listTools()).tools).toHaveLength(12);
      const s = api.activate('recovery');
      const call = query => first.callTool({ name: 'memory_search', arguments: { query, memory_type: 'semantic', limit: 1 } });
      expect(JSON.stringify(await call(s.errorQuery))).toContain(s.errorValue);
      expect(JSON.stringify(await call(s.query))).toContain(s.value);
      const second = await connect();
      const denied = await second.callTool({ name: 'memory_search', arguments: { query: s.query, memory_type: 'semantic', limit: 1 } });
      expect(denied.isError).toBe(true);
      expect(api.requests).toHaveLength(2);
      const trace = readLiveTrace(traceDir);
      expect(trace.calls).toHaveLength(3);
      expect(trace.issues).toContain('MCP call budget exceeded');
      expect(trace.calls.every(c => c.status !== 'pending')).toBe(true);
      expect(readdirSync(traceDir).filter(f => f.endsWith('.ndjson')).map(f => readFileSync(path.join(traceDir, f), 'utf8')).join('')).not.toContain(api.key);
    } finally {
      await Promise.all(clients.map(c => c.close().catch(() => {})));
      await api.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
