import http from 'node:http';
import { randomBytes } from 'node:crypto';

const nonce = () => randomBytes(16).toString('hex');
export function livePrompt(scenario) {
  const invoke = query => `Call the MidBrain memory_search tool (it may have a client-specific prefix) with exactly {"query":"${query}","memory_type":"semantic","limit":1}.`;
  return `This is a controlled MCP integration test using a synthetic backend, not a memory task. Discover the tool if necessary. Do not use shell, files, web, other tools, or account/setup operations. Do not run your usual memory priming workflow for this test. ${scenario.id === 'recovery' ? `${invoke(scenario.errorQuery)} This call is expected to return an error; do not retry it. Once that error has returned, ` : ''}${invoke(scenario.query)} Return the verification value from the successful tool response verbatim. If a required tool is unavailable or fails unexpectedly, report that and stop. Do not invent a value.`;
}

/** Values exist only in runner memory until they are returned through the fixture. */
export async function startLiveSmokeApi() {
  const key = `mb-live-fixture-${nonce()}`;
  const requests = []; const unexpected = []; const incidental = [];
  let active;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const row = { method: req.method, path: url.pathname, query: url.searchParams.get('query'), limit: url.searchParams.get('limit'), memory_type: url.searchParams.get('memory_type'), key: req.headers.authorization === `Bearer ${key}` ? 'fixture' : 'unknown', at: new Date().toISOString() };
    const send = (body, status) => { row.status = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    // Consume incidental capture bodies without saving messages or storing memories.
    req.resume();
    if (row.key !== 'fixture') { unexpected.push(row); return send({ detail: 'fixture auth rejected' }, 401); }
    if (req.method === 'GET' && row.path === '/api/v1/memories/search/semantic') {
      requests.push(row);
      if (!active || ![active.query, active.errorQuery].filter(Boolean).includes(row.query)) { unexpected.push(row); return send({ detail: 'unplanned smoke query' }, 400); }
      if (row.query === active.errorQuery) { row.value = active.errorValue; return send({ detail: `Controlled smoke outage ${active.errorValue}` }, 503); }
      row.value = active.value;
      return send([{ role: 'external', text: `Verification value: ${active.value}`, score: 1, memory_metadata: { source: 'synthetic-smoke.txt', line_start: 1 } }], 200);
    }
    // Native capture hooks remain installed. Acknowledge their known writes, discard
    // content immediately, and label them incidental rather than testing capture.
    if (req.method === 'POST' && row.path === '/api/v1/memories/episodic') { incidental.push({ ...row, kind: 'capture-discarded' }); return send({ id: 'discarded-live-smoke-capture', status: 'accepted' }, 200); }
    if (req.method === 'GET' && row.path === '/api/v1/memories/episodic' && url.searchParams.get('page') === '1' && row.limit === '1') { incidental.push({ ...row, kind: 'recency-peek' }); return send({ items: [], total: 0 }, 200); }
    unexpected.push(row); send({ detail: 'unexpected live-smoke endpoint' }, 400);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, key, requests, unexpected, incidental,
    activate(id) {
      active = { id, query: `LIVE_${nonce()}`, value: `VERIFIED_${nonce()}`, ...(id === 'recovery' ? { errorQuery: `ERROR_${nonce()}`, errorValue: `CONTROLLED_${nonce()}` } : {}) };
      return { ...active, prompt: livePrompt(active) };
    },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
