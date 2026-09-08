// Read-back client for the real MidBrain API. Used only to VERIFY: the product
// under test does all the writing. Rows are filtered client-side because the
// episodic endpoint has no server-side client/session filter.
import { HARNESS_VERSION } from './context.mjs';

export const DEFAULT_API_BASE = 'https://memory.midbrain.ai';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function rowText(row) {
  return String(row.text ?? row.content ?? '');
}

export function rowMeta(row) {
  return row.memory_metadata || row.metadata || {};
}

export class HarnessApi {
  constructor({ baseUrl, key }) {
    this.base = (baseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.key = key;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.key}`,
      'X-Midbrain-User-Agent': `midbrain-harness/${HARNESS_VERSION}`,
      Accept: 'application/json',
    };
  }

  async get(pathAndQuery) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`${this.base}${pathAndQuery}`, { headers: this.headers(), signal: ctrl.signal });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, ok: res.ok, json, text };
    } finally {
      clearTimeout(t);
    }
  }

  async probe() {
    try {
      const r = await this.get('/api/v1/memories/episodic?page=1&limit=1');
      return { ok: r.ok, status: r.status };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }

  async listEpisodicSince(sinceIso, { limit = 200, maxPages = 10 } = {}) {
    const items = [];
    const since = Date.parse(sinceIso);
    for (let page = 1; page <= maxPages; page += 1) {
      const q = new URLSearchParams({ page: String(page), limit: String(limit), start_date: sinceIso });
      const r = await this.get(`/api/v1/memories/episodic?${q}`);
      if (!r.ok) throw new Error(`episodic read-back failed: HTTP ${r.status}`);
      const rows = Array.isArray(r.json)
        ? r.json
        : (r.json?.items || r.json?.results || r.json?.memories || r.json?.data || []);
      for (const row of rows) {
        const t = Date.parse(row.occurred_at || row.created_at || '');
        if (Number.isNaN(t) || Number.isNaN(since) || t >= since - 60000) items.push(row);
      }
      if (rows.length < limit) break;
    }
    return items;
  }

  /** Poll until `predicate` matches at least `minCount` rows or the ceiling passes. */
  async waitForRows({ sinceIso, predicate, minCount = 1, timeoutMs = 90000, intervalMs = 5000 }) {
    const started = Date.now();
    let rows = [];
    let lastError = null;
    let polls = 0;
    while (true) {
      polls += 1;
      try {
        rows = (await this.listEpisodicSince(sinceIso)).filter(predicate);
      } catch (e) {
        lastError = e.message;
      }
      const elapsedMs = Date.now() - started;
      if (rows.length >= minCount) return { rows, elapsedMs, timedOut: false, lastError, polls };
      if (elapsedMs + intervalMs > timeoutMs) return { rows, elapsedMs, timedOut: true, lastError, polls };
      await sleep(intervalMs);
    }
  }
}
