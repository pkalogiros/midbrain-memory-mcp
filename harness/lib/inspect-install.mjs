// Runs INSIDE the throwaway-home environment (HOME etc. already set by the
// parent). Uses the product's own adapters to report install freshness so the
// harness never re-implements config parsing. Prints one JSON object.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2];
const id = process.argv[3];
const registry = await import(pathToFileURL(path.join(repo, 'shared', 'clients', 'registry.mjs')).href);
const shim = await import(pathToFileURL(path.join(repo, 'shared', 'clients', 'shim.mjs')).href);

const client = registry.getClient(id);
const out = { id, installed: null, fresh: null, shim: null };
try { out.installed = client.isInstalled(); } catch (e) { out.installedError = e.message; }
try { out.fresh = typeof client.isFresh === 'function' ? await client.isFresh() : null; } catch (e) { out.freshError = e.message; }
if (['claude', 'codex', 'hermes'].includes(id)) {
  try {
    const status = await shim.shimStatus(id);
    out.shim = { path: shim.stableShimPath(id), ...status };
  } catch (e) {
    out.shimError = e.message;
  }
}
process.stdout.write(JSON.stringify(out));
