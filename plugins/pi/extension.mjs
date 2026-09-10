import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MidbrainApi } from '../../shared/midbrain-api.mjs';
import { Pi } from '../../shared/clients/pi.mjs';
import { buildCaptureMetadata } from '../../shared/capture-metadata.mjs';
import { logFile, makeLogger } from '../../shared/logger.mjs';

export async function capturePi(event, ctx, deps = {}) {
  const message = event.message;
  if (!['user', 'assistant'].includes(message?.role)) return;
  const text = typeof message.content === 'string' ? message.content : (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (!text.trim()) return;
  const logger = deps.logger || makeLogger(logFile('midbrain-pi.log'));
  try {
    const api = await (deps.createApi || (cwd => MidbrainApi.create(new Pi(), cwd)))(ctx.cwd);
    await api.storeEpisodic(text, message.role, logger, buildCaptureMetadata({ client: 'pi', cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }));
  } catch (error) { logger.error(`PI CAPTURE ERROR (${message.role}): ${error.message}`); }
}

// Uses the existing MCP server unchanged; the extension is a native protocol bridge.
export function registerMidbrain(pi, options = {}) {
  const logger = makeLogger(logFile('midbrain-pi.log'));
  let client;
  const registered = new Set();
  pi.on('session_start', async (_event, ctx) => {
    await client?.close();
    client = new Client({ name: 'midbrain-pi', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({
        command: options.command || 'npx', args: options.args || ['-y', 'midbrain-memory-mcp@latest'],
        cwd: ctx.cwd,
        env: { ...process.env, MIDBRAIN_CLIENT: 'pi', MIDBRAIN_PROJECT_DIR: ctx.cwd, ...(options.dev ? { MIDBRAIN_DEV: '1' } : {}) },
        stderr: 'inherit',
      }));
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const name = `midbrain_${tool.name}`;
        if (registered.has(name)) continue;
        pi.registerTool({
          name, label: `MidBrain ${tool.name}`, description: tool.description || tool.name,
          parameters: tool.inputSchema,
          async execute(_id, params, signal) {
            const result = await client.callTool({ name: tool.name, arguments: params }, undefined, { signal });
            if (result.isError) throw new Error(result.content?.map(b => b.text || '').join('\n') || 'MidBrain tool failed');
            return { content: result.content, details: {} };
          },
        });
        registered.add(name);
      }
    } catch (error) {
      logger.error(`PI MCP ERROR: ${error.message}`);
      await client.close().catch(() => {});
      ctx.ui?.notify('MidBrain tools could not start; see the MidBrain Pi log.', 'error');
    }
  });
  pi.on('message_end', (event, ctx) => capturePi(event, ctx));
  pi.on('session_shutdown', async () => { await client?.close(); });
}
