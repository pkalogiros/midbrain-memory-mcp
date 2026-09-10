// Identity contract for the optional self-contained NanoClaw runtime image.
export const NANOCLAW_SHA = '6656b326a900dcfba4be8ca76412d954cfc915b5';
export const NANOCLAW_REPO = 'https://github.com/nanocoai/nanoclaw.git';
export const PACKAGE_ASSETS = ['container/CLAUDE.md', 'container/agent-runner/bun.lock', 'src/mailbox/sqlite/schema.ts', 'LICENSE'];

export function validatePackage(manifest, image) {
  const labels = image?.Config?.Labels || {};
  if (manifest.schemaVersion !== 1 || manifest.sourceSha !== NANOCLAW_SHA ||
      !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId) || image?.Id !== manifest.imageId ||
      manifest.platform !== `${image.Os}/${image.Architecture}` ||
      labels['dev.midbrain.harness.package'] !== '1' ||
      labels['dev.midbrain.harness.nanoclaw-sha'] !== NANOCLAW_SHA ||
      labels['dev.nanoclaw.agent-runner-lock-sha256'] !== manifest.lockHash) {
    throw new Error('NanoClaw package identity mismatch (image, revision, platform or lockfile)');
  }
  if (Object.keys(manifest.assets || {}).length !== PACKAGE_ASSETS.length ||
      PACKAGE_ASSETS.some(file => !/^[a-f0-9]{64}$/.test(manifest.assets[file])) ||
      manifest.assets['container/agent-runner/bun.lock'] !== manifest.lockHash) {
    throw new Error('NanoClaw package asset manifest is incomplete or invalid');
  }
}
