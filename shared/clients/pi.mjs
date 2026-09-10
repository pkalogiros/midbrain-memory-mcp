import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { BaseClient, readKeyFile } from './base.mjs';
import { writeCredential } from './credential-writer.mjs';
import { home, REPO_ROOT, writeFileIfChanged } from './utils.mjs';

export const PI_MARKER = '// MidBrain-owned Pi extension';
export const piHome = () => path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(home(), '.pi', 'agent'));
const extensionDir = () => path.join(piHome(), 'extensions', 'midbrain-memory');

function loader(isDev = false) {
  const options = isDev ? { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')], dev: true } : {};
  return `${PI_MARKER}${isDev ? ' (dev)' : ''}\nimport { registerMidbrain } from './runtime.mjs';\nexport default pi => registerMidbrain(pi, ${JSON.stringify(options)});\n`;
}

export class Pi extends BaseClient {
  get id() { return 'pi'; }
  get displayName() { return 'Pi'; }
  isInstalled() { return existsSync(piHome()); }
  async resolveClientKey() {
    const source = path.join(home(), '.config', this.id, '.midbrain-key');
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }
  async writeKey(key, { replaceApproved = false } = {}) {
    const targetPath = path.join(home(), '.config', this.id, '.midbrain-key');
    await writeCredential({ clientId: this.id, scope: 'client', targetPath, key, replaceApproved });
    return 'Key: ~/.config/pi/.midbrain-key (chmod 600)';
  }
  async installGlobal({ isDev = false } = {}) {
    const dir = extensionDir();
    const entry = path.join(dir, 'index.ts');
    if (existsSync(dir)) {
      const current = await fs.readFile(entry, 'utf8').catch(() => '');
      if (!current.startsWith(PI_MARKER + '\n') && !current.startsWith(PI_MARKER + ' (dev)\n')) throw new Error(`Preserving unowned Pi extension at ${dir}`);
    }
    const runtime = await fs.readFile(path.join(REPO_ROOT, 'dist', 'midbrain-pi.mjs'), 'utf8');
    await writeFileIfChanged(path.join(dir, 'runtime.mjs'), runtime);
    await writeFileIfChanged(entry, loader(isDev));
    return [`${entry}: native capture and MidBrain tools installed; restart Pi`];
  }
  // The global extension resolves the active cwd per session; no second capture instance.
  async installProject(_projectDir, opts = {}) { return this.installGlobal(opts); }
  projectConfigFiles() { return []; }
  async isFresh() {
    const entry = path.join(extensionDir(), 'index.ts');
    if (!existsSync(entry)) return true;
    const current = await fs.readFile(entry, 'utf8');
    if (current.startsWith(PI_MARKER + ' (dev)\n') || !current.startsWith(PI_MARKER + '\n')) return true;
    const runtime = await fs.readFile(path.join(extensionDir(), 'runtime.mjs'), 'utf8').catch(() => '');
    return current === loader() && runtime === await fs.readFile(path.join(REPO_ROOT, 'dist', 'midbrain-pi.mjs'), 'utf8');
  }
  async repairHooks() { return await this.isFresh() ? [] : this.installGlobal(); }
}
