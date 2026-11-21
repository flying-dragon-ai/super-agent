import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createMacUpdateArchive } from '../../scripts/electron-macos-artifacts.mjs';
import { releaseArtifactNames, stageNamedReleaseArtifact } from '../../../scripts/release-artifact-names.mjs';

test('update archive contains the open-super-agent bundle without renaming its contents', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-super-agent-artifacts-'));
  const stage = path.join(root, 'stage.noindex'), app = path.join(stage, 'open-super-agent.app');
  try {
    await mkdir(path.join(app, 'Contents'), { recursive: true });
    await writeFile(path.join(app, 'Contents', 'fixture.txt'), 'retained app content');
    const archive = path.join(root, 'open-super-agent.app.tar.gz');
    createMacUpdateArchive({ stage, archive });
    const entries = execFileSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(entries.length > 0 && entries.every(name => name.startsWith('open-super-agent.app/')));
    assert.equal(execFileSync('/usr/bin/tar', ['-xOzf', archive, 'open-super-agent.app/Contents/fixture.txt'], { encoding: 'utf8' }), 'retained app content');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exported mobile and CLI artifacts get the current brand without changing bytes or overwriting files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'open-super-agent-release-files-'));
  try {
    const names = releaseArtifactNames('1.2.3');
    assert.equal(names.macos, 'open-super-agent_1.2.3_aarch64.dmg');
    assert.equal(names.windows, 'open-super-agent_1.2.3_x64-setup.exe');
    for (const kind of ['android', 'ios', 'cli']) {
      const source = path.join(root, 'exported' + path.extname(names[kind]));
      await writeFile(source, 'signed bytes stay identical');
      const result = await stageNamedReleaseArtifact({ kind, source, version: '1.2.3', output: path.join(root, 'release') });
      assert.equal(path.basename(result.file), names[kind]);
      assert.equal(result.bytes, 27);
      await assert.rejects(stageNamedReleaseArtifact({ kind, source, version: '1.2.3', output: path.join(root, 'release') }), { code: 'EEXIST' });
    }
    assert.throws(() => releaseArtifactNames('../other'), /stable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
