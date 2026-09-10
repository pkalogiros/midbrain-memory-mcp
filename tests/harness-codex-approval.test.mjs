import { describe, expect, it } from 'vitest';
import { validateHooks, approveCodexHooks } from '../harness/lib/codex-approval.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunContext, childEnv } from '../harness/lib/context.mjs';
import scenario from '../harness/scenarios/s10-client-specific.mjs';

const home = '/isolated/home', project = `${home}/work/test`;
function inventory(trustStatus = 'untrusted') {
  return { data: [{ cwd: project, errors: [], warnings: [], hooks: Object.entries({
    postToolUse: 'tool', userPromptSubmit: 'user', stop: 'assistant',
  }).map(([eventName, role]) => ({ eventName, command: `'${home}/.midbrain/bin/codex-hook' ${role}`,
    handlerType: 'command', sourcePath: `${home}/.codex/hooks.json`, source: 'user',
    enabled: true, isManaged: false, async: false, matcher: null, timeoutSec: 10,
    key: eventName, currentHash: `sha256:${role}`, trustStatus,
  })) }] };
}

describe('native Codex approval inventory', () => {
  it('refuses a mismatched home before starting Codex', async () => {
    await expect(approveCodexHooks({ dirs: { run: '/run', home: '/run/home' } }, '/run/home/work', { HOME: '/host' }, '/run/evidence'))
      .rejects.toThrow('isolated run home');
  });
  it('accepts exactly the three installed hooks, then the same hashes trusted by Codex', () => {
    const before = validateHooks(inventory(), home, project, 'untrusted');
    expect(validateHooks(inventory('trusted'), home, project, 'trusted', before)).toEqual(before);
  });
  it.each([
    ['extra hook', x => x.data[0].hooks.push({ ...x.data[0].hooks[0], command: 'echo surprise' })],
    ['different command', x => x.data[0].hooks[0].command += ' && echo surprise'],
    ['different source', x => x.data[0].hooks[0].sourcePath = '/host/.codex/hooks.json'],
    ['already trusted', x => x.data[0].hooks[0].trustStatus = 'trusted'],
    ['managed trust', x => x.data[0].hooks[0].isManaged = true],
    ['disabled hook', x => x.data[0].hooks[0].enabled = false],
    ['duplicate event', x => x.data[0].hooks[0] = x.data[0].hooks[1]],
    ['load error', x => x.data[0].errors.push({ message: 'bad config' })],
    ['load warning', x => x.data[0].warnings.push('unknown source')],
  ])('rejects %s before any approval', (_, mutate) => {
    const value = inventory(); mutate(value);
    expect(() => validateHooks(value, home, project, 'untrusted')).toThrow();
  });
  it('rejects changed definitions between review and persisted trust', () => {
    const before = validateHooks(inventory(), home, project, 'untrusted');
    const after = inventory('trusted'); after.data[0].hooks[0].currentHash = 'changed';
    expect(() => validateHooks(after, home, project, 'trusted', before)).toThrow('changed');
  });
});

it.each(['passing', 'capture before approval', 'missing capture afterward', 'approval failed'])('retains native before/after capture scoring: %s', async condition => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-approval-scoring-'));
  try {
    const ctx = createRunContext({ root });
    const cwd = ctx.projectDir('test');
    let approved = false;
    const rows = () => ['user', 'assistant'].map(role => ({ role, memory_metadata: { client: 'codex', session_id: 'session', cwd: '~/work/test' } }));
    const client = { id: 'codex', expectedCaptureLabel: 'codex', specific: ['hook-trust-persisted'],
      async runTurn({ hookTrust, evidenceDir, label }) {
        expect(hookTrust).toBe('persisted');
        expect(approved).toBe(label === 'after-approval');
        return { exitCode: 0, finalText: 'marker', sessionId: 'session', rawPath: path.join(evidenceDir, `${label}.ndjson`) };
      },
      async approveHooks(received, project, evidenceDir) {
        expect(received.options.interactive).toBeFalsy();
        expect(project).toBe(cwd);
        fs.writeFileSync(path.join(evidenceDir, 'approval-ui.txt'), 'native receipt');
        approved = true;
        return condition === 'approval failed' ? 1 : 0;
      },
    };
    const api = { async waitForRows() {
      const captured = approved ? condition !== 'missing capture afterward' : condition === 'capture before approval';
      return { rows: captured ? rows() : [], timedOut: !captured };
    } };
    const [cell] = await scenario.run({ ctx, client, api, project: cwd });
    expect(cell.status).toBe(condition === 'passing' ? 'PASS' : 'FAIL');
    expect(cell.evidence.some(file => file.endsWith('/approval-ui.txt'))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Explicit local integration check: pinned real CLI, no valid key or model request.
it.skipIf(process.env.MIDBRAIN_TEST_CODEX_APPROVAL !== '1')('persists approval through real Codex 0.150.1 in two fresh homes', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-approval-')));
  try {
    for (let n = 0; n < 2; n++) {
      const ctx = createRunContext({ root });
      const cwd = ctx.projectDir('probe');
      const codex = path.join(ctx.dirs.home, '.codex');
      fs.mkdirSync(codex);
      fs.writeFileSync(path.join(codex, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-harness-offline-placeholder' }));
      fs.writeFileSync(path.join(codex, 'config.toml'), `[features]\nhooks = true\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
      fs.writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(
        Object.entries({ UserPromptSubmit: 'user', PostToolUse: 'tool', Stop: 'assistant' }).map(([event, role]) => [event,
          [{ hooks: [{ type: 'command', command: `'${ctx.dirs.home}/.midbrain/bin/codex-hook' ${role}`, timeout: 10 }] }],
        ]),
      ) }));
      expect(await approveCodexHooks(ctx, cwd, childEnv(ctx), ctx.dirs.evidence)).toBe(0);
      expect(fs.readFileSync(path.join(ctx.dirs.evidence, 'approval-ui.txt'), 'utf8')).toContain('unchanged definitions trusted');
      await expect(approveCodexHooks(ctx, cwd, childEnv(ctx), ctx.dirs.evidence)).rejects.toThrow('trust state');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 180000);
