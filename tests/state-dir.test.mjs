/**
 * Unit tests for shared/state-dir.mjs
 *
 * MIDBRAIN_STATE_DIR relocates MidBrain's durable state under a single base
 * (in NanoClaw: ~/.claude/.midbrain, the durable .claude-shared mount) so the
 * hook shim, API key, keystore, host config, and offline cache survive a cold
 * --rm spawn. It is OPT-IN: unset means every path resolves exactly as before,
 * so host installs are byte-identical.
 */

import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";

import {
  stateBaseDir,
  globalConfigDir,
  shimBinDir,
  cacheDir,
  isStateDirOverridden,
  nanoClawStateDir,
  activateNanoClawStateDir,
} from "../shared/state-dir.mjs";

import { stableShimPath } from "../shared/clients/shim.mjs";
import { globalKeystorePath } from "../shared/keystore.mjs";

const HOME = os.homedir();

afterEach(() => {
  delete process.env.MIDBRAIN_STATE_DIR;
});

describe("state-dir defaults (MIDBRAIN_STATE_DIR unset)", () => {
  it.each(["claude", "codex", "hermes"])(
    "%s stable shim path is unchanged (~/.midbrain/bin/<client>-hook[.cmd])",
    (client) => {
      const suffix = process.platform === "win32" && client !== "codex" ? ".cmd" : "";
      expect(stableShimPath(client)).toBe(
        path.join(HOME, ".midbrain", "bin", `${client}-hook${suffix}`),
      );
    },
  );

  it("global keystore path is unchanged", () => {
    expect(globalKeystorePath()).toBe(
      path.join(HOME, ".config", "midbrain", ".midbrain-keystore.json"),
    );
  });

  it("activates the mounted NanoClaw root only when no explicit root exists", () => {
    expect(activateNanoClawStateDir()).toBe(nanoClawStateDir());
    expect(process.env.MIDBRAIN_STATE_DIR).toBe(path.join(HOME, ".claude", ".midbrain"));
  });
  it("globalConfigDir is ~/.config/midbrain", () => {
    expect(globalConfigDir()).toBe(path.join(HOME, ".config", "midbrain"));
  });

  it("shimBinDir is ~/.midbrain/bin", () => {
    expect(shimBinDir()).toBe(path.join(HOME, ".midbrain", "bin"));
  });

  it("cacheDir is ~/.cache/midbrain", () => {
    expect(cacheDir()).toBe(path.join(HOME, ".cache", "midbrain"));
  });

  it("stateBaseDir is null and isStateDirOverridden is false", () => {
    expect(stateBaseDir()).toBeNull();
    expect(isStateDirOverridden()).toBe(false);
  });
});

describe("state-dir override (MIDBRAIN_STATE_DIR set)", () => {
  const BASE = "/home/node/.claude/.midbrain";

  it("routes config, shim bin, and cache under the base", () => {
    process.env.MIDBRAIN_STATE_DIR = BASE;
    expect(globalConfigDir()).toBe(BASE);
    // The shim keeps a bin/ subdir; combined with the .midbrain base this
    // preserves the .midbrain/bin/<client>-hook tail the ownership regex needs.
    expect(shimBinDir()).toBe(path.join(BASE, "bin"));
    expect(cacheDir()).toBe(path.join(BASE, "cache"));
    expect(stateBaseDir()).toBe(BASE);
    expect(isStateDirOverridden()).toBe(true);
  });

  it("preserves an explicit nonblank root", () => {
    process.env.MIDBRAIN_STATE_DIR = BASE;
    expect(activateNanoClawStateDir()).toBe(BASE);
    expect(process.env.MIDBRAIN_STATE_DIR).toBe(BASE);
  });

  it("trims surrounding whitespace", () => {
    process.env.MIDBRAIN_STATE_DIR = `  ${BASE}  `;
    expect(globalConfigDir()).toBe(BASE);
  });

  it("an empty or whitespace-only value is treated as unset", () => {
    process.env.MIDBRAIN_STATE_DIR = "   ";
    expect(globalConfigDir()).toBe(path.join(HOME, ".config", "midbrain"));
    expect(isStateDirOverridden()).toBe(false);
  });

  it("the shim bin path still contains the .midbrain/bin tail for ownership matching", () => {
    process.env.MIDBRAIN_STATE_DIR = BASE;
    expect(shimBinDir().replace(/\\/g, "/")).toContain(".midbrain/bin");
  });
});

describe("install output never injects MIDBRAIN_STATE_DIR", () => {
  it("MIDBRAIN_STATE_DIR is not a reserved/rebuilt env key and is not emitted by adapters", async () => {
    // The installer/adapters must not write MIDBRAIN_STATE_DIR into any client
    // MCP config; only the NanoClaw skill sets it (in the group MCP env). Guard
    // against a regression that would relocate a normal host install's state.
    const { RESERVED_ENV_KEYS } = await import("../shared/clients/utils.mjs");
    // It is intentionally NOT in RESERVED_ENV_KEYS (that set is about stripping
    // host-detection hints); the real guarantee is that no adapter emits it.
    // Scan adapter sources for an assignment.
    const fs = await import("fs/promises");
    const adapters = [
      "shared/clients/claude.mjs",
      "shared/clients/codex.mjs",
      "shared/clients/hermes.mjs",
      "shared/clients/opencode.mjs",
      "shared/clients/generic.mjs",
    ];
    for (const file of adapters) {
      const src = await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src, `${file} must not write MIDBRAIN_STATE_DIR`).not.toMatch(
        /MIDBRAIN_STATE_DIR\s*[:=]/,
      );
    }
    expect(RESERVED_ENV_KEYS.has("MIDBRAIN_STATE_DIR")).toBe(false);
  });
});
