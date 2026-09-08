import { pathToFileURL } from 'node:url';
// Real NanoClaw v2 runner, pinned at an inspected upstream revision. The
// harness supplies a local mailbox transport; it never simulates provider
// messages, invokes capture hooks, or patches the runner/provider source.
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, realpathSync } from 'node:fs';
import { spawnCapture } from './proc.mjs';
import { BlockedError } from './checks.mjs';
import { childEnv, HARNESS_DIR } from './context.mjs';
import { walk } from './evidence.mjs';
import { HarnessApi, sleep } from './api.mjs';
import { createMailbox, enqueue, readMailbox } from './nanoclaw-mailbox.mjs';

export const NANOCLAW_SHA = '6656b326a900dcfba4be8ca76412d954cfc915b5';
export const NANOCLAW_REPO = 'https://github.com/nanocoai/nanoclaw.git';
export const CAPTURE_CWD = '/workspace/agent';
// Dev packages live in a temporary install context so product self-repair does
// not replace the frozen dev hooks with registry hooks. Registry mode uses npx.
const PACKAGE = path.join('/tmp/midbrain/node_modules', "midbrain-memory-mcp");
const STATE = '/home/node/.claude/.midbrain';

export function dockerEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([k]) => ['PATH', 'HOME', 'USERPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK'].includes(k)));
}

export function containerUrl(value) {
  const url = new URL(value);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.href;
}

export function ownedMount(root, file) {
  const relative = path.relative(realpathSync(root), realpathSync(file));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('NanoClaw mount must be inside this run: ' + file);
  // --mount uses comma-separated fields. Reject paths Docker would reinterpret.
  if (file.includes(',')) throw new Error('NanoClaw mount paths cannot contain commas');
  return file;
}

export function selectReply(rows, id) {
  return rows.filter(r => r.in_reply_to === id && r.kind === 'chat').map(r => {
    try { return JSON.parse(r.content).text || ''; } catch { return ''; }
  }).filter(Boolean).join('\n');
}

export function parseTranscript(text, prompt) {
  const rows = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const escapedPrompt = prompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const start = rows.findLastIndex(r => {
    if (r.type !== 'user') return false;
    const content = r.message?.content;
    const text = typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    return text.includes(prompt) || text.includes(escapedPrompt);
  });
  const toolCalls = [];
  const byId = new Map();
  const nativeMessages = new Map();
  let sessionId = null;
  if (start < 0) return { sessionId, toolCalls };
  for (const r of rows.slice(start)) {
    if (r.sessionId) sessionId = r.sessionId;
    if (r.type === 'assistant' && r.message?.stop_reason === 'end_turn') {
      const text = (r.message.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (text && r.message.id) nativeMessages.set(r.message.id, { id: r.message.id, text });
    }
    for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (r.type === 'assistant' && b.type === 'tool_use' && !byId.has(b.id)) {
        const c = { id: b.id, name: b.name, input: b.input, result: null, ok: null };
        byId.set(b.id, c); toolCalls.push(c);
      } else if (b.type === 'tool_result' && byId.has(b.tool_use_id)) {
        const c = byId.get(b.tool_use_id);
        c.result = typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join('\n');
        c.ok = !b.is_error;
      }
    }
  }
  return { sessionId, toolCalls, nativeAssistantMessages: [...nativeMessages.values()] };
}

function writeJson(file, data) { writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); }
function hash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

export class NanoClawRuntime {
  constructor(ctx, candidate) {
    this.ctx = ctx;
    this.candidate = candidate;
    this.root = path.join(ctx.dirs.home, 'nanoclaw');
    this.groups = new Map();
    this.sessions = new Map();
    this.containers = new Set();
    this.network = process.env.MIDBRAIN_HARNESS_NANOCLAW_NETWORK || (process.platform === 'linux' ? 'host' : null);
    const reachable = url => this.network === 'host' ? url : containerUrl(url);
    this.apiBase = process.env.MIDBRAIN_HARNESS_API_URL || 'https://memory.midbrain.ai';
    this.containerApi = process.env.MIDBRAIN_HARNESS_CONTAINER_API_URL || reachable(this.apiBase);
    this.registryUrl = ctx.registry ? (process.env.MIDBRAIN_HARNESS_CONTAINER_REGISTRY_URL || reachable(ctx.registry.url)) : null;
  }

  async docker(args, options = {}) {
    return spawnCapture('docker', args, { env: dockerEnv(), timeoutMs: 60000, ...options });
  }

  async checkedDocker(args, options = {}) {
    const r = await this.docker(args, options);
    if (r.code !== 0) throw new Error('Docker ' + args[0] + ' failed: ' + this.redact(r.stderr.slice(-1600)));
    return r;
  }

  redact(text) {
    for (const value of Object.values(this.ctx.secrets)) if (value) text = text.split(value).join('<redacted>');
    return text;
  }

  async oneShot(args, { checked = true, ...options } = {}) {
    const name = 'mbh-nano-' + randomUUID();
    this.containers.add(name);
    try {
      const invoke = checked ? this.checkedDocker.bind(this) : this.docker.bind(this);
      return await invoke(['run', '--rm', '--name', name, '--label', 'dev.midbrain.harness.run=' + this.ctx.runId, ...args], options);
    } finally { await this.removeContainer(name); }
  }

  async prepare() {
    mkdirSync(this.root, { recursive: true });
    const source = process.env.MIDBRAIN_HARNESS_NANOCLAW_SOURCE;
    const checkout = path.join(this.ctx.dirs.tools, 'nanoclaw-checkout');
    if (!source) {
      const env = childEnv(this.ctx);
      const r = await spawnCapture('git', ['clone', '--no-checkout', '--filter=blob:none', NANOCLAW_REPO, checkout], { env, timeoutMs: 180000 });
      if (r.code !== 0) throw new BlockedError('NanoClaw source clone failed: ' + r.stderr.slice(-300));
      const c = await spawnCapture('git', ['checkout', '--detach', NANOCLAW_SHA], { cwd: checkout, env, timeoutMs: 180000 });
      if (c.code !== 0) throw new BlockedError('Cannot check out pinned NanoClaw revision');
    }
    const src = source ? path.resolve(source) : checkout;
    const identity = await spawnCapture('git', ['rev-parse', 'HEAD'], { cwd: src, env: childEnv(this.ctx) });
    const dirty = await spawnCapture('git', ['status', '--porcelain'], { cwd: src, env: childEnv(this.ctx) });
    if (identity.stdout.trim() !== NANOCLAW_SHA || dirty.code !== 0 || dirty.stdout.trim()) throw new BlockedError('NanoClaw source must be a clean checkout of ' + NANOCLAW_SHA);
    // Only tracked files from the verified revision enter the run/image;
    // ignored .env files in a developer's source checkout must stay there.
    const tree = await spawnCapture('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: src, env: childEnv(this.ctx) });
    if (tree.code !== 0) throw new BlockedError('Cannot enumerate pinned NanoClaw source');
    const roots = ['container/Dockerfile', 'container/entrypoint.sh', 'container/cli-tools.json', 'container/install-cli-tools.sh', 'container/CLAUDE.md', 'container/agent-runner/package.json', 'container/agent-runner/bun.lock', 'src/mailbox/sqlite/schema.ts'];
    for (const rel of tree.stdout.trim().split('\n').filter(rel => roots.includes(rel) || rel.startsWith('container/agent-runner/src/'))) {
      const target = path.join(this.root, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(src, rel), target);
    }
    mkdirSync(path.join(this.root, '.claude/skills'), { recursive: true });
    const lockHash = hash(path.join(this.root, 'container/agent-runner/bun.lock'));
    const baseTag = process.env.MIDBRAIN_HARNESS_NANOCLAW_IMAGE || 'midbrain-harness-nanoclaw:' + NANOCLAW_SHA.slice(0, 12);
    let inspected = await this.docker(['image', 'inspect', baseTag]);
    if (inspected.code !== 0) {
      if (process.env.MIDBRAIN_HARNESS_NANOCLAW_IMAGE) throw new BlockedError('Configured NanoClaw image is not available locally');
      const build = await this.docker(['build', '--build-arg', 'AGENT_RUNNER_LOCK_SHA256=' + lockHash, '--label', 'dev.midbrain.harness.nanoclaw-sha=' + NANOCLAW_SHA, '-t', baseTag, '-f', 'Dockerfile', '.'], { cwd: path.join(this.root, 'container'), timeoutMs: 1800000 });
      writeFileSync(path.join(this.ctx.dirs.evidence, 'nanoclaw-build.log'), this.redact(build.stdout + build.stderr));
      if (build.code !== 0) throw new BlockedError('NanoClaw image build failed; see nanoclaw-build.log');
      inspected = await this.checkedDocker(['image', 'inspect', baseTag]);
    }
    const base = JSON.parse(inspected.stdout)[0];
    if (base.Config?.Labels?.['dev.nanoclaw.agent-runner-lock-sha256'] !== lockHash) throw new BlockedError('NanoClaw image lockfile label does not match the pinned source; rebuild the image');
    this.baseImage = base.Id;
    this.image = base.Id;
    if (this.candidate.mode === 'dev') {
      const packDir = path.join(this.ctx.dirs.tools, 'nanoclaw-candidate');
      mkdirSync(packDir, { recursive: true });
      const info = { filename: path.basename(this.candidate.tarball) };
      const tarball = path.join(packDir, info.filename);
      cpSync(this.candidate.tarball, tarball);
      if (hash(tarball) !== this.candidate.tarballSha256) throw new Error('Frozen NanoClaw candidate tarball changed');
      const baseRef = 'midbrain-harness-base:' + this.ctx.runId;
      await this.checkedDocker(['tag', base.Id, baseRef]);
      writeFileSync(path.join(packDir, 'Dockerfile'), 'FROM ' + baseRef + '\nUSER root\nCOPY ' + info.filename + ' /tmp/candidate.tgz\nRUN npm install --prefix /tmp/midbrain /tmp/candidate.tgz --omit=dev --ignore-scripts --no-audit --no-fund && rm /tmp/candidate.tgz\nUSER node\n');
      const tag = 'midbrain-harness-candidate:' + this.ctx.runId;
      const build = await this.checkedDocker(['build', '-t', tag, '.'], { cwd: packDir, timeoutMs: 600000 });
      writeFileSync(path.join(this.ctx.dirs.evidence, 'nanoclaw-candidate-build.log'), this.redact(build.stdout + build.stderr));
      this.image = JSON.parse((await this.checkedDocker(['image', 'inspect', tag])).stdout)[0].Id;
      this.tarballSha256 = hash(tarball);
    }
    this.identity = { sourceSha: NANOCLAW_SHA, baseImage: base.Id, image: this.image, lockHash, tarballSha256: this.tarballSha256 || null, mode: this.candidate.mode };
    writeJson(path.join(this.ctx.dirs.run, 'nanoclaw.json'), this.identity);
  }

  mount(file, target, readonly = false) {
    return ['--mount', 'type=bind,src=' + ownedMount(this.ctx.dirs.run, file) + ',dst=' + target + (readonly ? ',readonly' : '')];
  }

  userArgs() {
    const uid = process.getuid?.() || 1000;
    const gid = process.getgid?.() || 1000;
    // Keep host-mounted files owned by the invoking user. All unmounted home
    // state is ephemeral and writable by that uid, including the legacy shim.
    return ['--user', `${uid}:${gid}`, '--tmpfs', `/home/node:exec,uid=${uid},gid=${gid},mode=0700`, '-e', 'HOME=/home/node'];
  }

  networkArgs() {
    // Linux host networking reaches the loopback-only registry. Docker Desktop
    // bridges its host alias; custom networks can override API/registry URLs.
    return this.network ? ['--network', this.network] : ['--add-host', 'host.docker.internal:host-gateway'];
  }

  async group(project) {
    ownedMount(this.ctx.dirs.run, project);
    let group = this.groups.get(project);
    const projectKey = path.join(project, '.midbrain/.midbrain-key');
    const key = existsSync(projectKey) ? readFileSync(projectKey, 'utf8').trim() : this.ctx.secrets.MIDBRAIN_HARNESS_API_KEY;
    if (group) {
      if (group.key !== key) throw new Error('NanoClaw group credential changed after initialization');
      return group;
    }
    const id = randomUUID();
    const dir = path.join(this.root, 'data/v2-sessions', id);
    const claude = path.join(dir, '.claude-shared');
    // A NanoClaw group owns its agent files; it shares the project's memory
    // binding without overwriting host-client instructions or local memories.
    const agent = path.join(dir, 'agent');
    const logs = path.join(dir, 'logs');
    for (const d of [claude, agent, logs, path.join(claude, '.midbrain')]) mkdirSync(d, { recursive: true, mode: 0o777 });
    const state = path.join(claude, '.midbrain');
    // Same group setup surfaces as /add-midbrain. File credentials are bound
    // to the custom API in the durable state, also visible to stripped hooks.
    writeFileSync(path.join(state, '.midbrain-key'), key + '\n', { mode: 0o600 });
    writeJson(path.join(state, 'config.json'), { apiUrl: this.containerApi });
    writeFileSync(path.join(claude, '.midbrain-capture-client'), 'nanoclaw\n');
    writeJson(path.join(claude, 'settings.json'), {});
    const envFile = path.join(dir, 'provider.env');
    const secret = this.ctx.secrets.ANTHROPIC_API_KEY;
    if (!secret || /[\r\n]/.test(secret)) throw new Error('A single-line ANTHROPIC_API_KEY is required');
    writeFileSync(envFile, 'ANTHROPIC_API_KEY=' + secret + '\n', { mode: 0o600 });
    const pkgEnv = { MIDBRAIN_API_KEY: key, MIDBRAIN_CLIENT: 'claude', MIDBRAIN_CAPTURE_CLIENT: 'nanoclaw', MIDBRAIN_STATE_DIR: STATE, MIDBRAIN_LOG_DIR: '/workspace/logs', ...(this.candidate.mode === 'dev' ? { MIDBRAIN_DEV: '1' } : {}) };
    const mcp = this.candidate.mode === 'dev' ? { command: 'node', args: [PACKAGE + '/index.js'], env: pkgEnv } : { command: 'npx', args: ['-y', 'midbrain-memory-mcp@latest'], env: pkgEnv };
    const config = { provider: 'claude', assistantName: 'Harness', groupName: 'Harness', agentGroupId: id, mcpServers: { 'midbrain-memory': mcp }, model: process.env.MIDBRAIN_HARNESS_NANOCLAW_MODEL || 'claude-sonnet-4-5' };
    writeJson(path.join(agent, 'container.json'), config);
    const rules = await import(pathToFileURL(path.join(this.candidate.repoRoot, 'shared/agent-rules.mjs')).href);
    writeFileSync(path.join(agent, 'CLAUDE.md'), readFileSync(path.join(this.root, 'container/CLAUDE.md'), 'utf8'));
    await rules.writeAgentRules(path.join(agent, 'CLAUDE.md'), { client: 'nanoclaw' });
    const instructions = path.join(dir, 'instructions.prepend.md');
    writeFileSync(instructions, 'For requests to reply exactly, put that exact text inside the required <message to="harness"> delivery wrapper.\n');
    group = { id, dir, claude, agent, logs, envFile, key, config, instructions };
    const setupArgs = this.candidate.mode === 'dev' ? ['node', PACKAGE + '/install.mjs', '--dev'] : ['npx', '-y', 'midbrain-memory-mcp@latest', 'install'];
    const setup = await this.oneShot([...this.userArgs(), ...this.networkArgs(), ...this.mount(claude, '/home/node/.claude'), ...this.mount(agent, CAPTURE_CWD), ...this.mount(logs, '/workspace/logs'), ...this.mount(logs, '/home/node/.local/state/midbrain'), '-e', 'MIDBRAIN_STATE_DIR=' + STATE, ...this.registryEnv(), '--workdir', CAPTURE_CWD, '--entrypoint', setupArgs[0], this.image, ...setupArgs.slice(1), '--non-interactive', '--no-login']);
    writeFileSync(path.join(dir, 'setup.log'), this.redact(setup.stdout + setup.stderr));
    this.groups.set(project, group);
    return group;
  }

  registryEnv() { return this.registryUrl ? ['-e', 'npm_config_registry=' + this.registryUrl] : []; }

  async turn({ project, prompt, sessionId, resume = false, evidenceDir, label = 'turn' }) {
    const group = await this.group(project);
    let session = resume && sessionId ? this.sessions.get(sessionId) : null;
    if (resume && (!session || session.group !== group)) throw new Error('Unknown NanoClaw session or session belongs to a different group');
    if (!session) {
      const id = randomUUID();
      const dir = path.join(group.dir, id);
      mkdirSync(dir, { recursive: true, mode: 0o777 });
      session = { id, dir, group, startedAt: Date.now() };
      await createMailbox(dir, this.root, id);
    }
    const api = new HarnessApi({ baseUrl: this.apiBase, key: group.key });
    const previousRows = resume ? await api.listEpisodicSince(new Date(session.startedAt).toISOString()) : [];
    const previousIds = new Set(previousRows.map(r => r.id));
    const inboundId = randomUUID();
    await enqueue(session.dir, inboundId, session.id, prompt);
    const container = 'mbh-nano-' + randomUUID();
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const rawPath = path.join(evidenceDir, label + '.mailbox.json');
    let snapshot = { ack: null, messages: [], continuation: null };
    let timedOut;
    let running = true;
    let parsed = { sessionId: null, toolCalls: [] };
    let exitCode = 0;
    let mailboxError = '';
    this.containers.add(container);
    try {
      await this.checkedDocker(['run', '-d', ...this.userArgs(), '--name', container, '--label', 'dev.midbrain.harness.run=' + this.ctx.runId, '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', ...this.networkArgs(), ...this.mount(session.dir, '/workspace'), ...this.mount(path.join(session.dir, 'inbound.db'), '/workspace/inbound.db', true), ...this.mount(group.agent, CAPTURE_CWD), ...this.mount(group.instructions, CAPTURE_CWD + '/instructions.prepend.md', true), ...this.mount(path.join(group.agent, 'container.json'), CAPTURE_CWD + '/container.json', true), ...this.mount(group.claude, '/home/node/.claude'), ...this.mount(group.logs, '/workspace/logs'), ...this.mount(group.logs, '/home/node/.local/state/midbrain'), ...this.mount(path.join(this.root, 'container/agent-runner/src'), '/app/src', true), '--env-file', group.envFile, ...this.registryEnv(), '--workdir', CAPTURE_CWD, '--entrypoint', 'bun', this.image, 'run', '/app/src/index.ts']);
      const deadline = started + Number(process.env.MIDBRAIN_HARNESS_TURN_TIMEOUT_MS || 300000);
      while (Date.now() < deadline) {
        try { snapshot = await readMailbox(session.dir, inboundId); } catch (e) {
          // VirtioFS can expose a writer's rollback journal before its lock.
          // Never recover/write the runner-owned DB from the host; retry a
          // fresh read once the writer commits, within the turn deadline.
          if (!/readonly database|database is locked|database is busy/i.test(e.message)) throw e;
          mailboxError = e.message;
        }
        if (snapshot.ack === 'failed' || (snapshot.ack === 'completed' && selectReply(snapshot.messages, inboundId))) break;
        const state = JSON.parse((await this.checkedDocker(['inspect', '--format', '{{json .State}}', container])).stdout);
        if (!state.Running) { running = false; exitCode = state.ExitCode || 1; break; }
        await sleep(1000);
      }
      timedOut = running && !(snapshot.ack === 'completed' && selectReply(snapshot.messages, inboundId));
      // Delivery can precede the final Stop hook. Wait for every observed
      // native reply, including formatting retries, before removing the container.
      if (!timedOut && running && snapshot.continuation) {
        await api.waitForRows({
          sinceIso: startedAt,
          predicate: r => r.role === 'assistant' && r.memory_metadata?.session_id === snapshot.continuation && !previousIds.has(r.id),
          ready: rows => {
            const file = walk(path.join(group.claude, 'projects'), f => path.basename(f) === snapshot.continuation + '.jsonl')[0];
            const replies = file && parseTranscript(readFileSync(file, 'utf8'), prompt).nativeAssistantMessages;
            return replies?.length > 0 && rows.length >= replies.length;
          },
          timeoutMs: 30000, intervalMs: 1000, settleMs: 5000,
        });
      }
    } finally {
      const logs = await this.docker(['logs', container]);
      writeFileSync(path.join(evidenceDir, label + '.container.log'), this.redact(logs.stdout + logs.stderr));
      await this.removeContainer(container);
      writeFileSync(rawPath, this.redact(JSON.stringify(snapshot, null, 2)), { mode: 0o600 });
    }
    const sid = snapshot.continuation;
    const transcript = sid && walk(path.join(group.claude, 'projects'), f => path.basename(f) === sid + '.jsonl')[0];
    if (transcript) {
      const text = this.redact(readFileSync(transcript, 'utf8'));
      writeFileSync(path.join(evidenceDir, label + '.transcript.jsonl'), text, { mode: 0o600 });
      parsed = parseTranscript(text, prompt);
    }
    if (sid) this.sessions.set(sid, session);
    return { client: 'nanoclaw', sessionId: sid, nanoSessionId: session.id, containerId: container, inboundId, prompt, finalText: this.redact(selectReply(snapshot.messages, inboundId)), toolCalls: parsed.toolCalls, nativeAssistantMessages: parsed.nativeAssistantMessages, init: null, exitCode, timedOut, isError: snapshot.ack !== 'completed' || !transcript || !parsed.sessionId, durationMs: Date.now() - started, rawPath, stderr: timedOut ? mailboxError : '', nativeCapture: true, evidenceDir };
  }

  async installedVersion() {
    const r = await this.oneShot([...this.userArgs(), ...this.networkArgs(), ...this.registryEnv(), '--entrypoint', 'npx', this.image, '-y', 'midbrain-memory-mcp@latest', '--version']);
    return r.stdout.trim();
  }

  async probe() {
    const group = [...this.groups.values()][0];
    if (!group) return { code: 1, connected: false, text: 'No configured NanoClaw group' };
    const probe = path.join(this.ctx.dirs.tools, 'nanoclaw-probe.mjs');
    cpSync(path.join(HARNESS_DIR, 'container/nanoclaw-probe.mjs'), probe);
    const r = await this.oneShot([...this.userArgs(), ...this.networkArgs(), ...this.mount(probe, '/probe.mjs', true), ...this.mount(group.agent, CAPTURE_CWD), ...this.mount(group.claude, '/home/node/.claude'), ...this.mount(group.logs, '/workspace/logs'), ...this.mount(group.logs, '/home/node/.local/state/midbrain'), ...this.registryEnv(), '--entrypoint', 'node', this.image, '/probe.mjs'], { checked: false });
    writeFileSync(path.join(this.ctx.dirs.evidence, 'nanoclaw-mcp-probe.log'), this.redact(r.stdout + r.stderr));
    let tools = [];
    try { tools = JSON.parse(r.stdout.trim()).tools; } catch { /* failed probe */ }
    const required = ['memory_search', 'grep', 'get_episodic_memories_by_date', 'list_files', 'read_file', 'check_session_status', 'memory_diagnostics', 'memory_setup_project', 'list_agents', 'create_agent', 'set_agent', 'set_user_api_key'];
    return { code: r.code, connected: r.code === 0 && required.every(t => tools.includes(t)), text: 'NanoClaw MCP tools: ' + tools.join(', ') + (r.code ? '; see nanoclaw-mcp-probe.log' : '') };
  }

  async removeContainer(name) {
    if (!this.containers.has(name)) return;
    const r = await this.docker(['rm', '-f', name]);
    if (r.code !== 0 && !r.stderr.includes('No such container')) throw new Error('Cannot remove run-owned NanoClaw container ' + name);
    this.containers.delete(name);
  }

  async cleanup() {
    const results = await Promise.allSettled([...this.containers].map(name => this.removeContainer(name)));
    const failure = results.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
