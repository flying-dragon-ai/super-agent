// Fixture checks for the Windows Electron installer. Compiling with makensis
// and listing the payload proves structure only; installing, upgrading a Tauri
// install and uninstalling need real Windows acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWindowsInstaller, DEFAULT_PLUGINS_DIR, defaultPluginsDir, findMakensis, HELPER_BINARY, MAIN_BINARY, NSIS_TAURI_UTILS, planWindowsInstaller, setupNsisPlugins, TEMPLATE_DIR } from './windows-electron-installer.mjs';

const client = fileURLToPath(new URL('..', import.meta.url));
const tool = name => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map(dir => path.join(dir, name)).find(existsSync);
const makensis = tool('makensis'), sevenZip = tool('7zz') ?? tool('7z');
const pluginsDir = process.env.OPEN_SUPER_AGENT_NSIS_PLUGINS_DIR ?? DEFAULT_PLUGINS_DIR;
let root, helper;

async function packaged(name, { host = 'resources/host', extra = {} } = {}) {
  const dir = path.join(root, name, 'open-super-agent-win32-x64');
  const files = {
    [MAIN_BINARY]: 'MZ electron', 'ffmpeg.dll': 'MZ', 'resources.pak': 'pak', 'locales/zh-CN.pak': 'pak',
    'resources/app.asar': 'asar', 'resources/native/open-super-agent-desktop-updater.exe': 'MZ', 'resources/native/update-config.json': '{}',
    'resources/native/open-super-agent-desktop-native.node': 'MZ', 'resources/native/open-super-agent-migration-exporter.exe': 'MZ', [`${host}/node.exe`]: 'MZ node', [`${host}/dist/src/index.js`]: '// host',
    'resources/app.asar.unpacked/a file.txt': 'x', ...extra,
  };
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body);
  }
  return dir;
}

before(async () => {
  const base = process.env.OPEN_SUPER_AGENT_UPDATER_LAB_ROOT;
  assert.ok(base?.includes('.noindex'), 'OPEN_SUPER_AGENT_UPDATER_LAB_ROOT must point inside a .noindex lab directory');
  await mkdir(base, { recursive: true });
  root = await mkdtemp(path.join(base, 'nsis-'));
  helper = process.env.OPEN_SUPER_AGENT_WINDOWS_HELPER;
  if (!helper) { helper = path.join(root, 'helper.exe'); await writeFile(helper, 'MZ fixture helper'); }
});
after(async () => { if (root && !process.env.OPEN_SUPER_AGENT_UPDATER_LAB_KEEP) await rm(root, { recursive: true, force: true }); });

test('fixed identity equals the Tauri installer that existing users have', async () => {
  const nsi = await readFile(path.join(TEMPLATE_DIR, 'installer.nsi'), 'utf8');
  const tauri = JSON.parse(await readFile(path.join(client, 'src-tauri/tauri.conf.json'), 'utf8'));
  const windows = JSON.parse(await readFile(path.join(client, 'src-tauri/tauri.windows.conf.json'), 'utf8'));
  const cargo = await readFile(path.join(client, 'src-tauri/Cargo.toml'), 'utf8');
  const define = name => nsi.match(new RegExp(`^!define ${name} "([^"]*)"`, 'm'))?.[1];
  assert.equal(define('PRODUCTNAME'), 'Open Super Agent', 'installation namespace remains compatible');
  assert.equal(define('DISPLAYNAME'), tauri.productName);
  assert.match(nsi, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\\$\{DISPLAYNAME\}"/);
  assert.doesNotMatch(nsi, /StrCpy \$INSTDIR "\$(?:LOCALAPPDATA|PROGRAMFILES64?)\\\$\{PRODUCTNAME\}"/);
  assert.match(nsi, /CreateShortcut "\$DESKTOP\\\$\{DISPLAYNAME\}\.lnk"/);
  assert.match(nsi, /!macro openSuperAgentUpdateLegacyShortcut DIRECTORY[\s\S]*?IsShortcutTarget[\s\S]*?SetShortcutTarget/);
  assert.equal(define('MANUFACTURER'), tauri.bundle.publisher);
  assert.equal(define('BUNDLEID'), tauri.identifier);
  assert.equal(define('MAINBINARYNAME'), cargo.match(/^name = "([^"]+)"/m)[1]);
  assert.equal(`${define('MAINBINARYNAME')}.exe`, MAIN_BINARY);
  assert.equal(define('INSTALLMODE'), windows.bundle.windows.nsis.installMode);
  assert.equal(define('UNINSTKEY'), 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}');
  assert.equal(define('MANUPRODUCTKEY'), '${MANUKEY}\\${PRODUCTNAME}');
  assert.equal(define('INSTALLWEBVIEW2MODE'), 'skip');
  assert.deepEqual(tauri.plugins['deep-link'].desktop.schemes, ['opensuperagent']);
  assert.match(nsi, /WriteRegStr SHCTX "Software\\Classes\\opensuperagent\\shell\\open\\command"/);
  // Only the runtime placeholders of the "app running" messages remain.
  const code = nsi.split('\n').filter(line => !line.trim().startsWith(';')).join('\n');
  assert.doesNotMatch(code.replaceAll('"{{product_name}}"', ''), /\{\{/);
  for (const language of tauri.bundle.windows.nsis.languages) assert.match(nsi, new RegExp(`MUI_LANGUAGE "${language}"`));
  const hooks = await readFile(path.join(TEMPLATE_DIR, 'installer-hooks.nsh'), 'utf8');
  const original = await readFile(path.join(client, 'src-tauri/windows/installer-hooks.nsh'), 'utf8');
  for (const keep of ['!macro NSIS_HOOK_PREINSTALL', '!macro NSIS_HOOK_POSTINSTALL', '!macro NSIS_HOOK_PREUNINSTALL', '!macro NSIS_HOOK_POSTUNINSTALL',
    '--register-notification-shortcut', '--clear-notification-history', '--confirm-host-stopped', '--prepare-fresh-install', 'OpenSuperAgentRememberInstallation']) {
    assert.ok(original.includes(keep) && hooks.includes(keep), keep);
  }
});

test('plan installs every packaged file once, removes exactly those, and adds the helper', async () => {
  const appDir = await packaged('plan');
  const plan = await planWindowsInstaller({ appDir, helper, version: '1.2.3', outFile: path.join(root, 'plan.exe'), pluginsDir });
  assert.equal(plan.host, 'resources\\host');
  const targets = plan.resources.map(item => item.target);
  assert.ok(!targets.includes(MAIN_BINARY), 'the main binary comes from MAINBINARYSRCPATH');
  assert.ok(targets.includes(HELPER_BINARY) && targets.includes('resources\\native\\open-super-agent-desktop-updater.exe'));
  assert.equal(new Set(targets).size, targets.length);
  const installs = plan.includes.install.split('\n').filter(line => line.includes('File /a'));
  const deletes = plan.includes.uninstall.split('\n').filter(line => line.includes('Delete'));
  assert.equal(installs.length, targets.length); assert.equal(deletes.length, targets.length);
  assert.ok(plan.includes.install.includes('"/oname=resources\\app.asar.unpacked\\a file.txt"'));
  const removals = plan.includes.ancestors.split('\n').filter(Boolean).map(line => line.match(/\$INSTDIR\\(.*)"/)[1]);
  assert.ok(removals.indexOf('resources\\native') < removals.indexOf('resources'), 'children before parents');
  assert.equal(plan.defines.TB_VERSION, '1.2.3');
  assert.ok(Number(plan.defines.TB_ESTIMATED_SIZE) >= 1);
});

test('plan refuses packages the Tauri upgrade path could not own', async () => {
  const outFile = path.join(root, 'refused.exe');
  const refuse = async (name, options, pattern) => {
    const appDir = await packaged(name, options);
    await assert.rejects(planWindowsInstaller({ appDir, helper, version: '1.2.3', outFile, pluginsDir }), pattern);
    return appDir;
  };
  await refuse('both-hosts', { extra: { 'host/node.exe': 'MZ node', 'host/dist/src/index.js': '// old host' } }, /must not ship a top-level host/);
  const renamed = await packaged('renamed');
  await rm(path.join(renamed, MAIN_BINARY));
  await writeFile(path.join(renamed, 'open-super-agent.exe'), 'MZ');
  await assert.rejects(planWindowsInstaller({ appDir: renamed, helper, version: '1.2.3', outFile, pluginsDir }), /open-super-agent-client\.exe/);
  await refuse('owned-name', { extra: { [HELPER_BINARY]: 'MZ' } }, /installer-owned/);
  await refuse('receipt', { extra: { 'open-super-agent-notification-shortcut.json': '{}' } }, /installer-owned/);
  await refuse('reserved', { extra: { 'resources/aux.txt': 'x' } }, /not valid on Windows/);
  await refuse('dollar', { extra: { 'resources/a $x.txt': 'x' } }, /not valid on Windows or in NSIS/);
  // Case-insensitive volumes (default APFS) cannot even hold the colliding pair.
  const probe = path.join(root, 'case-probe');
  await mkdir(probe, { recursive: true }); await writeFile(path.join(probe, 'A'), 'a'); await writeFile(path.join(probe, 'a'), 'b');
  if ((await readdir(probe)).length === 2) await refuse('case', { extra: { 'resources/A.txt': 'a', 'resources/a.TXT': 'b' } }, /collision/);
  const linked = await packaged('link');
  await symlink('/etc/hosts', path.join(linked, 'resources/link'));
  await assert.rejects(planWindowsInstaller({ appDir: linked, helper, version: '1.2.3', outFile, pluginsDir }), /Symbolic links/);
  const noexporter = await packaged('noexporter');
  await rm(path.join(noexporter, 'resources/native/open-super-agent-migration-exporter.exe'));
  await assert.rejects(planWindowsInstaller({ appDir: noexporter, helper, version: '1.2.3', outFile, pluginsDir }), /open-super-agent-migration-exporter/);
  const nohost = await packaged('nohost');
  await rm(path.join(nohost, 'resources/host'), { recursive: true });
  await assert.rejects(planWindowsInstaller({ appDir: nohost, helper, version: '1.2.3', outFile, pluginsDir }), /Host runtime/);
  for (const version of ['1.2', '1.2.3-beta', '100000.0.0']) {
    await assert.rejects(planWindowsInstaller({ appDir: renamed.replace('renamed', 'plan'), helper, version, outFile, pluginsDir }), /stable/);
  }
});

test('makensis compiles the installer; the payload holds the App, helper and recovery copy', { skip: !makensis && 'makensis not installed' }, async () => {
  const appDir = await packaged('build', { host: 'host' });
  const outFile = path.join(root, 'out', 'open_super_agent_1.2.3_x64-setup.exe');
  const result = await buildWindowsInstaller({ appDir, helper, version: '1.2.3', outFile, pluginsDir }, { makensis, workDir: path.join(root, 'nsis-work') });
  assert.equal(result.host, 'host');
  assert.equal((await readFile(outFile)).subarray(0, 2).toString(), 'MZ');
  for (const forbidden of [/installer-diagnostics\.nsh/i, /installer-hooks\.nsh/i, /utils\.nsh/i, /English\.nsh/i, /SimpChinese\.nsh/i, /LangString/i, /function .* not referenced/i]) {
    assert.doesNotMatch(result.log, forbidden, `makensis emitted unexpected warning matching ${forbidden}:\n${result.log}`);
  }
  if (!sevenZip) return;
  const listing = execFileSync(sevenZip, ['l', '-ba', outFile]).toString();
  for (const entry of [MAIN_BINARY, HELPER_BINARY, 'resources\\app.asar', 'resources\\native\\open-super-agent-desktop-updater.exe', 'host\\node.exe', 'host\\dist\\src\\index.js', 'uninstall.exe']) {
    assert.ok(listing.replaceAll('/', '\\').includes(entry), `${entry} in payload`);
  }
  assert.match(listing, /open-super-agent-recovery\.exe/, 'the helper is also staged for recovery');
});

test('plugin directory and makensis resolve per platform', () => {
  assert.equal(defaultPluginsDir({ platform: 'darwin', env: {}, home: '/Users/a' }), '/Users/a/Library/Caches/tauri/NSIS/Plugins/x86-unicode/additional');
  assert.equal(defaultPluginsDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, home: 'C:\\Users\\a' }),
    'C:\\Users\\a\\AppData\\Local\\tauri\\NSIS\\Plugins\\x86-unicode\\additional');
  assert.equal(defaultPluginsDir({ platform: 'linux', env: {}, home: '/home/a' }), '/home/a/.cache/tauri/NSIS/Plugins/x86-unicode/additional');
  assert.equal(defaultPluginsDir({ platform: 'win32', env: { OPEN_SUPER_AGENT_NSIS_PLUGINS_DIR: 'D:\\nsis' } }), 'D:\\nsis');
  const programFiles = 'C:\\Program Files (x86)';
  assert.equal(findMakensis({ platform: 'win32', env: { 'ProgramFiles(x86)': programFiles }, exists: file => file === `${programFiles}\\NSIS\\makensis.exe` }), `${programFiles}\\NSIS\\makensis.exe`);
  assert.equal(findMakensis({ platform: 'win32', env: {}, exists: () => false }), 'makensis');
  assert.equal(findMakensis({ platform: 'darwin', env: { MAKENSIS: '/opt/nsis/makensis' } }), '/opt/nsis/makensis');
});

test('setup-nsis installs only the pinned plugin and never a mismatched or oversized download', async () => {
  const response = (bytes, length = bytes.length) => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(length) }), body: (async function* () { yield bytes; })() });
  const dir = path.join(root, 'plugins');
  let calls = 0;
  await assert.rejects(setupNsisPlugins({ pluginsDir: dir, fetchImpl: async () => { calls++; return response(Buffer.alloc(NSIS_TAURI_UTILS.size, 1)); } }), /does not match/);
  await assert.rejects(setupNsisPlugins({ pluginsDir: dir, fetchImpl: async () => response(Buffer.alloc(8), NSIS_TAURI_UTILS.size + 1) }), /larger than pinned/);
  await assert.rejects(setupNsisPlugins({ pluginsDir: dir, fetchImpl: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
  assert.ok(!existsSync(path.join(dir, 'nsis_tauri_utils.dll')));
  assert.equal(calls, 1);
  const source = path.join(pluginsDir, 'nsis_tauri_utils.dll');
  if (!existsSync(source)) return;
  const bytes = await readFile(source);
  const fetched = await setupNsisPlugins({ pluginsDir: dir, fetchImpl: async url => { assert.equal(url, NSIS_TAURI_UTILS.url); return response(bytes); } });
  assert.deepEqual(fetched, { path: path.join(dir, 'nsis_tauri_utils.dll'), downloaded: true });
  assert.deepEqual(await setupNsisPlugins({ pluginsDir: dir, fetchImpl: () => assert.fail('already verified') }), { path: fetched.path, downloaded: false });
  assert.deepEqual((await readdir(dir)).sort(), ['nsis_tauri_utils.dll']);
});

test('uninstall removes the login item only when it starts this installation', async () => {
  const nsi = await readFile(path.join(TEMPLATE_DIR, 'installer.nsi'), 'utf8');
  const uninstall = nsi.slice(nsi.indexOf('Section Uninstall'), nsi.indexOf('SectionEnd', nsi.indexOf('Section Uninstall')));
  const block = /\$\{If\} \$UpdateMode <> 1\n\s+Push \$R0\n\s+ReadRegStr \$R0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "\$\{PRODUCTNAME\}"\n((?:\s+\$\{(?:If|OrIf)\} \$R0 == .+\n)+)((?:\s+DeleteRegValue .+\n)+)\s+\$\{EndIf\}\n\s+Pop \$R0\n\s+\$\{EndIf\}/.exec(uninstall);
  assert.ok(block, 'the Run value is read and compared inside a non-update guard');
  // Every Run / StartupApproved deletion in the uninstaller is this guarded one.
  const deletions = uninstall.match(/DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\(?:Explorer\\StartupApproved\\)?Run"[^\n]*/g);
  assert.deepEqual(deletions, block[2].trim().split(/\n\s*/));
  assert.equal(deletions.length, 2);
  const nsisString = literal => literal.startsWith("'") || literal.startsWith('"') ? literal.slice(1, -1) : literal;
  const accepted = [...block[1].matchAll(/== (".*"|'.*')$/gm)].map(match => nsisString(match[1]));
  const INSTDIR = 'C:\\Users\\Lab\\AppData\\Local\\Open Super Agent', exe = `${INSTDIR}\\open-super-agent-client.exe`;
  // NSIS StrCmp (LogicLib ==) compares case-insensitively.
  const removes = value => accepted.some(pattern => pattern.replaceAll('$INSTDIR', INSTDIR).replaceAll('${MAINBINARYNAME}', 'open-super-agent-client').toLowerCase() === value.toLowerCase());
  for (const own of [`${exe} `, exe, `"${exe}"`, `${exe.toUpperCase()} `]) assert.ok(removes(own), `removes ${own}`);
  for (const other of ['D:\\Apps\\Open Super Agent\\open-super-agent-client.exe ', `${INSTDIR}2\\open-super-agent-client.exe `, `${exe} --minimized`, `${INSTDIR}\\other.exe `, '', ' ', `"${exe}" `]) {
    assert.ok(!removes(other), `keeps ${JSON.stringify(other)}`);
  }
});

test('after a Tauri upgrade the installer asks the helper, by fixed flag only, to drop the old host folder', async () => {
  const hooks = await readFile(path.join(TEMPLATE_DIR, 'installer-hooks.nsh'), 'utf8');
  const post = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'), hooks.indexOf('!macroend', hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL')));
  const calls = [...hooks.matchAll(/--remove-legacy-host-runtime[^\n]*/g)].map(match => match[0]);
  assert.deepEqual(calls, ["--remove-legacy-host-runtime' $R0"], 'exactly one call, without any path argument');
  const call = post.indexOf('--remove-legacy-host-runtime');
  assert.ok(call > post.lastIndexOf('OpenSuperAgentRegisterNotificationShortcut'), 'after the new files and shortcut registration');
  assert.match(post, /\$\{If\} \$\{FileExists\} "\$INSTDIR\\host\\\*\.\*"\n\s+ClearErrors\n\s+ExecWait '"\$INSTDIR\\\$\{OPEN_SUPER_AGENT_HELPERHELPER\}" --remove-legacy-host-runtime' \$R0/);
  // A refusal is reported, never an aborted installation.
  assert.doesNotMatch(post.slice(call), /Abort|MessageBox/);
  // No other hook deletes inside the installation directory recursively.
  assert.doesNotMatch(hooks, /RMDir \/r|RmDir \/r/i);
});

test('backup exit codes have localized, path-free diagnostics in both NSIS programs', async () => {
  const read = file => readFile(path.join(TEMPLATE_DIR, file), 'utf8');
  const [rust, dialog, hooks, utils, en, zh] = await Promise.all([
    readFile(path.join(client, 'src-tauri/src/fresh_install.rs'), 'utf8'),
    ...['installer-diagnostics.nsh', 'installer-hooks.nsh', 'utils.nsh', 'English.nsh', 'SimpChinese.nsh'].map(read),
  ]);
  const reasons = rust.match(/pub enum Reason \{([^}]+)\}/)[1];
  const exitCodes = [...reasons.matchAll(/= (\d+),/g)].map(match => Number(match[1]));
  const handled = [...dialog.matchAll(/\$\{Case\} (\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual([...handled, 60], exitCodes, '60 is handled separately as incomplete finalization');
  const required = new Set([...(dialog + hooks + utils).matchAll(/\$\((bird\w+)\)/g)].map(match => match[1]));
  for (const language of [en, zh]) {
    const strings = new Map([...language.matchAll(/^LangString (bird\w+) \S+ "(.+)"$/gm)].map(match => [match[1], match[2]]));
    for (const key of required) {
      assert.ok(strings.has(key), key);
      assert.doesNotMatch(strings.get(key).replaceAll('$\\r$\\n', ''), /\$|[\\/]/, key);
    }
    assert.notEqual(strings.get('birdInstallBackup'), strings.get('birdUninstallBackup'));
    assert.match(strings.get('birdCopy'), /Ctrl\+C/);
  }
  assert.doesNotMatch(dialog, /\$INSTDIR|\$APPDATA|\$PROFILE|\$TEMP|\$CMDLINE|ReadReg|FileRead|ExecWait/);
});

test('reset requires consent and safe backup states; later retries stay in their own stage', async () => {
  const hooks = await readFile(path.join(TEMPLATE_DIR, 'installer-hooks.nsh'), 'utf8');
  const macro = name => hooks.split('!macro ' + name)[1].split('!macroend')[0];
  const inOrder = (source, ...fragments) => {
    let start = 0;
    for (const fragment of fragments) {
      const index = source.indexOf(fragment, start);
      assert.ok(index >= start, 'missing or out of order: ' + fragment);
      start = index + fragment.length;
    }
  };
  const install = macro('NSIS_HOOK_PREINSTALL');
  const uninstall = macro('NSIS_HOOK_PREUNINSTALL');
  const backup = macro('BirdBackup');
  const stopHost = macro('OpenSuperAgentStopLocalHost');
  const registerShortcut = macro('OpenSuperAgentRegisterNotificationShortcut');
  inOrder(stopHost, 'bird_stop_retry_${_TB_STOP_ID}:', '!insertmacro CheckIfAppIsRunning "$INSTDIR\\${MAINBINARYNAME}.exe" "${DISPLAYNAME}"',
    'StrCpy $OpenSuperAgentHostStopper ""', '--stop-desktop-host');
  inOrder(install, '${IfNot} ${Silent}', '$PassiveMode <> 1', '$UpdateMode <> 1',
    '$OpenSuperAgentHadInstallation == ""', 'IDYES open_super_agent_fresh_install', 'open_super_agent_fresh_install:',
    'StrCpy $BirdBackupState "$(birdNotStarted)"', '!insertmacro OpenSuperAgentStopLocalHost 1', '!insertmacro BirdBackup');
  inOrder(uninstall, '!insertmacro OpenSuperAgentStopLocalHost 0', '${IfNot} ${Silent}', '$PassiveMode <> 1', '$UpdateMode <> 1',
    '$DeleteAppDataCheckboxState = 1', 'IDYES open_super_agent_uninstall_fresh', 'Abort', 'open_super_agent_uninstall_fresh:', '!insertmacro BirdBackup', 'StrCpy $DeleteAppDataCheckboxState 0');
  inOrder(backup, 'bird_backup_retry:', 'StrCpy $BirdBackupState "$(birdNotStarted)"', '!insertmacro CheckIfAppIsRunning', '--prepare-fresh-install-v2');
  inOrder(backup, '$R0 = 0', 'StrCpy $BirdBackupState "$(birdCompleted)"', '$R0 = 10', 'StrCpy $BirdBackupState "$(birdNoData)"');
  for (const code of ['B60', 'B-UNKNOWN', 'B$R0']) {
    assert.ok(backup.includes('"$(birdPreserve)" "' + code + '" ""'), code + ' must stop without retry');
  }
  const template = await readFile(path.join(TEMPLATE_DIR, 'installer.nsi'), 'utf8');
  assert.doesNotMatch(template, /RMDir\s+\/r\s+"\$(?:LOCAL)?APPDATA/i);
  const notificationRetry = uninstall.split('bird_notice_retry:')[1];
  inOrder(notificationRetry, 'ReadRegStr', 'CheckIfAppIsRunning', '--clear-notification-history', '"NOTICE-CLEAR" bird_notice_retry');
  assert.doesNotMatch(notificationRetry, /BirdBackup|prepare-fresh-install|RmDir/);
  assert.ok(registerShortcut.includes('!insertmacro BirdProblem') && registerShortcut.includes('"NOTICE-REGISTER"'), 'notification registration uses passive/silent-safe BirdProblem with retry');
});

test('running-app shutdown targets only this exe via Restart Manager, guides Task Manager recovery, and never blocks /S or /P', async () => {
  const read = file => readFile(path.join(TEMPLATE_DIR, file), 'utf8');
  const [nsi, hooks, diag, utils, en, zh] = await Promise.all(
    ['installer.nsi', 'installer-hooks.nsh', 'installer-diagnostics.nsh', 'utils.nsh', 'English.nsh', 'SimpChinese.nsh'].map(read),
  );

  // Never kill processes by name anywhere in the installer templates.
  for (const [name, src] of [['installer.nsi', nsi], ['installer-hooks.nsh', hooks], ['installer-diagnostics.nsh', diag], ['utils.nsh', utils]]) {
    assert.doesNotMatch(src, /taskkill|Stop-Process|tskill/i, `${name} must not kill processes by name`);
  }

  // Community report (#50): a background App held data files open and could
  // respawn the Host. Close this installation's App before stopping the Host,
  // and before any backup move, on every path that stops the Host.
  const stopMacro = hooks.slice(hooks.indexOf('!macro OpenSuperAgentStopLocalHost'), hooks.indexOf('!macroend', hooks.indexOf('!macro OpenSuperAgentStopLocalHost')));
  assert.ok(stopMacro.includes('CheckIfAppIsRunning'), 'OpenSuperAgentStopLocalHost closes the App');
  assert.ok(stopMacro.indexOf('CheckIfAppIsRunning') < stopMacro.indexOf('--stop-desktop-host'), 'the App closes before the Host stop request');
  const backupMacro = hooks.slice(hooks.indexOf('!macro BirdBackup'), hooks.indexOf('!macroend', hooks.indexOf('!macro BirdBackup')));
  assert.ok(backupMacro.indexOf('CheckIfAppIsRunning') >= 0 && backupMacro.indexOf('CheckIfAppIsRunning') < backupMacro.indexOf('--prepare-fresh-install'), 'the App closes before data moves');
  const preUninstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_PREUNINSTALL'));
  assert.ok(preUninstall.indexOf('!insertmacro OpenSuperAgentStopLocalHost') >= 0 && preUninstall.indexOf('!insertmacro OpenSuperAgentStopLocalHost') < preUninstall.indexOf('!insertmacro BirdBackup'), 'uninstall stops the Host (after closing the App) before backing up');

  // CheckIfAppIsRunning targets only executablePath via Restart Manager, skips prompts in /S and /P, uses monotonic labels, and retries on failure.
  assert.match(utils, /!define UniqueID \$\{__COUNTER__\}/);
  assert.match(utils, /!insertmacro RestartManager_RegisterFile \$R0 "\$\{executablePath\}"/);
  assert.match(utils, /IfSilent kill_\$\{UniqueID\} 0\n\s+\$\{IfThen\} \$PassiveMode != 1 \$\{\|\} MessageBox MB_OKCANCEL \$R2 IDOK kill_\$\{UniqueID\} IDCANCEL cancel_\$\{UniqueID\} \$\{\|\}/);
  assert.match(utils, /!insertmacro BirdProblem "\$\(birdAppStage\)" "\$\(birdAppCloseFailed\)" "\$\(birdCloseApp\)" "APP-CLOSE" app_check_retry_\$\{UniqueID\}/);

  // App-close failure copy explains background execution and Task Manager recovery in both languages, with matching LangString key sets and safe length.
  const parse = (src, lang) => new Map([...src.replace(/^\uFEFF/, '').matchAll(new RegExp(`^LangString (\\S+) \\$\\{${lang}\\} "([^"]*)"$`, 'gm'))].map(m => [m[1], m[2]]));
  const enMap = parse(en, 'LANG_ENGLISH');
  const zhMap = parse(zh, 'LANG_SIMPCHINESE');
  assert.deepEqual([...enMap.keys()].sort(), [...zhMap.keys()].sort(), 'English.nsh and SimpChinese.nsh have identical LangString keys');
  assert.match(enMap.get('birdAppCloseFailed'), /background/i);
  assert.match(enMap.get('birdCloseApp'), /Task Manager/i);
  assert.match(enMap.get('birdCloseApp'), /Retry/i);
  assert.match(zhMap.get('birdAppCloseFailed'), /后台/);
  assert.match(zhMap.get('birdCloseApp'), /任务管理器/);
  assert.match(zhMap.get('birdCloseApp'), /重试/);

  // Every BirdProblem and consent MessageBox carries /SD and is gated against Silent + Passive mode.
  assert.match(diag, /MessageBox MB_ICONSTOP\|MB_OK "\$BirdMessage" \/SD IDOK/);
  assert.match(diag, /MessageBox MB_ICONEXCLAMATION\|MB_RETRYCANCEL\|MB_DEFBUTTON2 "\$BirdMessage" \/SD IDCANCEL IDRETRY \$\{RETRY\}/);
  assert.match(hooks, /MessageBox MB_ICONQUESTION\|MB_YESNOCANCEL\|MB_DEFBUTTON2 "\$\(birdInstallConsent\)" \/SD IDCANCEL/);
  assert.match(hooks, /MessageBox MB_ICONQUESTION\|MB_YESNO\|MB_DEFBUTTON2 "\$\(birdUninstallConsent\)" \/SD IDNO/);
  assert.match(nsi, /\$\{IfNot\} \$\{Silent\}\n\s+\$\{AndIf\} \$PassiveMode != 1\n\s+MessageBox MB_ICONEXCLAMATION "\$\(unableToUninstall\)" \/SD IDOK/);

  // Worst-case assembled BirdMessage stays comfortably below NSIS_MAX_STRLEN (1024) in both languages.
  for (const [label, map] of [['EN', enMap], ['ZH', zhMap]]) {
    const maxLen = keys => Math.max(...keys.map(k => map.get(k).length));
    const dialogKeys = [...map.keys()].filter(k => k.startsWith('bird') && !k.endsWith('Consent'));
    const worst = maxLen(['birdInstall', 'birdUninstall']) + 3
      + maxLen(['birdHostStage', 'birdAppStage', 'birdInstallBackup', 'birdUninstallBackup', 'birdNoticeStage', 'birdNoticeRegStage']) + 2
      + maxLen(dialogKeys) * 3 + 12 + 'open-super-agent 99.99.99 · TB-HOST-UNCONFIRMED · '.length + map.get('birdCopy').length;
    assert.ok(worst < 900, `${label} worst-case BirdMessage length (${worst}) must stay below NSIS_MAX_STRLEN (1024)`);
  }
});
