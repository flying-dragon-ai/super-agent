/** com.opensuperagent.client channels. Never publish the new identity under legacy
 * <platform>-v tags: old installed updaters cannot migrate a package identity.
 * Unverified architectures must not receive an update. */
export function desktopUpdatePlatform(platform = 'windows') {
  if (platform === 'windows') return { name: 'Windows', prefix: 'windows-open-super-agent-v', manifest: 'windows-open-super-agent-latest.json', target: 'windows-x86_64', extension: '.exe' };
  if (platform === 'macos') return { name: 'macOS', prefix: 'macos-open-super-agent-v', manifest: 'macos-open-super-agent-latest.json', target: 'darwin-aarch64', extension: '.app.tar.gz' };
  throw new Error('Unsupported desktop update platform');
}
