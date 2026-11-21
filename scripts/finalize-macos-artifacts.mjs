import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { macosBuildEnvironment, physicalPath } from './macos-artifact-paths.mjs';
import { fileURLToPath } from 'node:url';

/** Called only after the numeric release ID and uploaded digests read back.
 * Cleanup failure cannot turn a published release into an invitation to republish. */
export function finalizeMacosArtifacts({ version, outputDir }, { platform = process.platform, run = execFileSync, environment = process.env } = {}) {
  if (platform !== 'darwin') return { status: 'not-macos' };
  const receipt = path.resolve(outputDir, 'macos-artifact-cleanup.json');
  try {
    const env = macosBuildEnvironment(fileURLToPath(new URL('..', import.meta.url)), environment, 'darwin');
    // Electron packages land in OPEN_SUPER_AGENT_DESKTOP_OUTPUT. Default roots are scanned
    // first, so an output inside a task keeps that task's hold/activation guards.
    const roots = [...new Set([env.OPEN_SUPER_AGENT_ARTIFACT_ROOT, env.CARGO_TARGET_DIR, environment.OPEN_SUPER_AGENT_DESKTOP_OUTPUT].filter(Boolean).map(physicalPath))];
    const extra = roots.length ? ['--root', '/Volumes/gdrive/taro-tmp.noindex', '--root', '/Volumes/gdrive/taro-tmp', '--root', '/Volumes/gdrive/dev-cache/open-super-agent-release-target.noindex', '--root', '/Volumes/gdrive/dev-cache/open-super-agent-release-target', '--root', '/Volumes/gdrive/dev-cache/open-super-agent-macos.noindex', '--root', '/Volumes/gdrive/dev-cache/open-super-agent-macos', ...roots.flatMap(root => ['--root', root])] : [];
    const result = run('python3', [fileURLToPath(new URL('./cleanup-macos-artifacts.py', import.meta.url)), '--apply', '--keep-version', version, '--receipt', receipt, ...extra],
      { encoding:'utf8', timeout:160000, maxBuffer:1024*1024 });
    return { status: 'checked', ...JSON.parse(result.trim()) };
  } catch {
    return { status:'deferred', receipt, reason:'Cleanup could not prove an idle safe artifact set; publication succeeded. Inspect the workspace, do not republish.' };
  }
}
