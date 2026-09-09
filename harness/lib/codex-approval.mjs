// Inspect through Codex's read-only API; persist approval only through its native UI.
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCapture } from './proc.mjs';

const ROLES = { postToolUse: 'tool', userPromptSubmit: 'user', stop: 'assistant' };
const quote = value => `'${value.replace(/'/g, "'\\''")}'`;

export function validateHooks(value, home, project, trust, previous) {
  const entry = value?.data?.[0];
  if (value?.data?.length !== 1 || entry.cwd !== project || entry.errors?.length || entry.warnings?.length || entry.hooks?.length !== 3) {
    throw new Error('Codex must discover exactly three MidBrain hooks without load errors or warnings');
  }
  const identities = {};
  for (const hook of entry.hooks) {
    const role = ROLES[hook.eventName];
    if (!role || identities[hook.eventName] || hook.handlerType !== 'command' ||
        hook.command !== `${quote(path.join(home, '.midbrain/bin/codex-hook'))} ${role}` ||
        hook.sourcePath !== path.join(home, '.codex/hooks.json') || hook.source !== 'user' ||
        hook.enabled !== true || hook.isManaged !== false || hook.async !== false ||
        hook.matcher != null || hook.timeoutSec !== 10 || hook.trustStatus !== trust ||
        !hook.key || !hook.currentHash) throw new Error('Unexpected Codex hook definition or trust state; approval refused');
    identities[hook.eventName] = { key: hook.key, hash: hook.currentHash };
  }
  if (previous && Object.keys(ROLES).some(event => JSON.stringify(identities[event]) !== JSON.stringify(previous[event]))) {
    throw new Error('Codex hook definitions changed during approval');
  }
  return identities;
}

export function listHooks(env, project) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd: project, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', result, failure;
    const finish = error => { failure ||= error; child.kill('SIGTERM'); };
    const timer = setTimeout(() => finish(new Error('Codex hook inventory timed out')), 30000);
    const hard = setTimeout(() => child.kill('SIGKILL'), 35000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => finish(new Error('Codex hook inventory input closed')));
    child.on('error', () => { clearTimeout(timer); clearTimeout(hard); reject(new Error('Could not start Codex hook inventory')); });
    child.on('close', () => {
      clearTimeout(timer); clearTimeout(hard);
      if (failure || !result) reject(failure || new Error('Codex hook inventory exited without a result'));
      else resolve(result);
    });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(new Error('Codex hook inventory exceeded its output limit'));
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); } catch { return finish(new Error('Invalid Codex hook inventory response')); }
        buffer = buffer.slice(end + 1);
        if (message.error) return finish(new Error('Codex rejected hook inventory request'));
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'hooks/list', params: { cwds: [project] } });
        } else if (message.id === 2) { result = message.result; finish(); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'midbrain_harness', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

export async function approveCodexHooks(ctx, project, env, evidenceDir) {
  if (ctx.dirs.home !== path.join(ctx.dirs.run, 'home') || env.HOME !== ctx.dirs.home ||
      env.CODEX_HOME !== path.join(ctx.dirs.home, '.codex') || !project.startsWith(ctx.dirs.home + path.sep)) {
    throw new Error('Native approval must use the isolated run home and project');
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Native hook approval needs a POSIX terminal (Linux or macOS)');
  const version = await spawnCapture('codex', ['--version'], { env, timeoutMs: 10000 });
  if (version.code !== 0 || version.stdout.trim() !== 'codex-cli 0.150.1') throw new Error('Native hook approval is validated only with Codex 0.150.1');
  const receipt = path.join(evidenceDir, 'approval-ui.txt');
  const before = validateHooks(await listHooks(env, project), ctx.dirs.home, project, 'untrusted');
  writeFileSync(receipt, `Codex 0.150.1 native hook approval\nBefore: three untrusted MidBrain hooks\n${JSON.stringify(before, null, 2)}\n`);
  const driver = fileURLToPath(new URL('./codex-approval-pty.py', import.meta.url));
  const session = await spawnCapture('python3', [driver, project], { cwd: project, env: { ...env, TERM: 'xterm-256color' }, timeoutMs: 70000,
    stdoutFile: path.join(evidenceDir, 'approval-terminal.log') });
  appendFileSync(path.join(evidenceDir, 'approval-terminal.log'), session.stderr);
  if (session.code !== 0 || session.timedOut) throw new Error('Native Codex hook approval failed; see private approval-terminal.log');
  validateHooks(await listHooks(env, project), ctx.dirs.home, project, 'trusted', before);
  writeFileSync(receipt, `Codex 0.150.1 native hook approval\nBefore: three untrusted MidBrain hooks\nAction: Review hooks, then trust through the native hook browser\nAfter: fresh Codex process reports all three unchanged definitions trusted\n${JSON.stringify(before, null, 2)}\n`);
  return 0;
}
