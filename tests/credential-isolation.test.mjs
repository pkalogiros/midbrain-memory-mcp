/**
 * Mock-independent credential isolation regression (PRD-035 S4).
 *
 * These tests exercise real filesystem writers with dummy credentials, covering
 * placement, permissions, and promotion. Real-home credentials are compared
 * only through hashes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { Codex } from "../shared/clients/codex.mjs";
import { Claude } from "../shared/clients/claude.mjs";
import { Generic } from "../shared/clients/generic.mjs";
import { Hermes } from "../shared/clients/hermes.mjs";
import { NanoClaw } from "../shared/clients/nanoclaw.mjs";
import { OpenCode } from "../shared/clients/opencode.mjs";
import { main } from "../install.mjs";
import { collectHashes, diffHashes, tripwireSurfaces } from "./helpers/global-tripwire.mjs";
import { assertSandboxed, makeTestEnv } from "./helpers/test-env.mjs";

const IS_WIN = process.platform === "win32";
const DUMMY_CREDENTIAL = "dummy-credential-for-isolation";
const REAL_CREDENTIAL_SURFACES = tripwireSurfaces()
  .filter((filePath) => filePath.endsWith(".midbrain-key"));

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectIsolatedWrite({ clients = [], target, write }) {
  const before = collectHashes(REAL_CREDENTIAL_SURFACES);
  const env = await makeTestEnv({ clients });
  try {
    const filePath = target(env);
    await assertSandboxed(env, filePath);
    await write(env);
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
    // Windows does not enforce POSIX file modes; chmod(0o600) is a no-op there.
    if (!IS_WIN) expect(stat.mode & 0o777).toBe(0o600);
    expect(diffHashes(before, collectHashes(REAL_CREDENTIAL_SURFACES))).toEqual([]);
  } finally {
    await env.restore();
  }
}

describe("credential writers stay inside the test sandbox without filesystem interception", () => {
  describe.each([false, true])("MIDBRAIN_STATE_DIR override: %s", (relocated) => {
    it.each([
      ["opencode", OpenCode], ["claude", Claude], ["codex", Codex],
      ["hermes", Hermes], ["nanoclaw", NanoClaw],
    ])(
      "isolates the %s adapter writer in its native client directory",
      async (id, Client) => {
        const client = new Client();
        await expectIsolatedWrite({
          target: (env) => path.join(env.home, ".config", id, ".midbrain-key"),
          write: async (env) => {
            if (relocated) process.env.MIDBRAIN_STATE_DIR = path.join(env.home, "relocated-state");
            await client.writeKey(DUMMY_CREDENTIAL);
            expect(await client.resolveClientKey()).toEqual({
              key: DUMMY_CREDENTIAL,
              source: path.join(env.home, ".config", id, ".midbrain-key"),
            });
          },
        });
      },
    );
  });

  it("isolates the installer global writer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectIsolatedWrite({
      clients: ["codex"],
      target: (env) => env.paths.globalKey,
      write: async () => {
        process.env.MIDBRAIN_API_KEY = DUMMY_CREDENTIAL;
        await main({ nonInteractive: true, skipRules: true, noLogin: true });
      },
    });
  });

  it("isolates the Generic project writer", async () => {
    await expectIsolatedWrite({
      target: (env) => path.join(env.root, "project", ".midbrain", ".midbrain-key"),
      write: (env) => new Generic().setProjectKey(
        path.join(env.root, "project"),
        DUMMY_CREDENTIAL,
      ),
    });
  });
});

const NO_KEY_MESSAGE =
  'No API key found. Run the installer interactively first or set MIDBRAIN_API_KEY.';

async function writeCredentialFixture(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${value}\n`, { mode: 0o600 });
}

function muteInstallerOutput() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('global credential promotion with the real filesystem', () => {
  it('preserves a direct global file byte-for-byte with distinct client keys', async () => {
    const env = await makeTestEnv({ clients: ['opencode', 'claude'] });
    try {
      muteInstallerOutput();
      const opencodeKey = path.join(env.home, '.config', 'opencode', '.midbrain-key');
      const claudeKey = path.join(env.home, '.config', 'claude', '.midbrain-key');
      await writeCredentialFixture(opencodeKey, 'opencode-client-dummy');
      await writeCredentialFixture(claudeKey, 'claude-client-dummy');
      await writeCredentialFixture(env.paths.globalKey, 'global-preserve-dummy');
      const before = await fs.readFile(env.paths.globalKey);
      const beforeStat = await fs.stat(env.paths.globalKey);

      await main({ nonInteractive: true, skipRules: true });

      expect(await fs.readFile(env.paths.globalKey)).toEqual(before);
      expect((await fs.stat(env.paths.globalKey)).mtimeMs).toBe(beforeStat.mtimeMs);
    } finally {
      await env.restore();
    }
  });

  it('makes zero writes when non-interactive client credentials differ', async () => {
    const env = await makeTestEnv({ clients: ['opencode', 'claude'] });
    try {
      muteInstallerOutput();
      const opencodeKey = path.join(env.home, '.config', 'opencode', '.midbrain-key');
      const claudeKey = path.join(env.home, '.config', 'claude', '.midbrain-key');
      await writeCredentialFixture(opencodeKey, 'opencode-distinct-dummy');
      await writeCredentialFixture(claudeKey, 'claude-distinct-dummy');
      const beforeOpenCode = await fs.stat(opencodeKey);
      const beforeClaude = await fs.stat(claudeKey);

      await expect(main({ nonInteractive: true, skipRules: true }))
        .rejects.toThrow(/Distinct eligible credentials/);

      await expect(fs.access(env.paths.globalKey)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.stat(opencodeKey)).mtimeMs).toBe(beforeOpenCode.mtimeMs);
      expect((await fs.stat(claudeKey)).mtimeMs).toBe(beforeClaude.mtimeMs);
    } finally {
      await env.restore();
    }
  });

  it('never promotes a project credential into the global file', async () => {
    const env = await makeTestEnv({ clients: ['opencode'] });
    try {
      muteInstallerOutput();
      const projectDir = path.join(env.root, 'project');
      const projectKey = path.join(projectDir, '.midbrain', '.midbrain-key');
      await writeCredentialFixture(projectKey, 'project-only-dummy');
      process.env.MIDBRAIN_PROJECT_DIR = projectDir;

      await expect(main({ nonInteractive: true, skipRules: true }))
        .rejects.toThrow(NO_KEY_MESSAGE);
      await expect(fs.access(env.paths.globalKey)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(projectKey, 'utf8')).toBe('project-only-dummy\n');
    } finally {
      await env.restore();
    }
  });
});
