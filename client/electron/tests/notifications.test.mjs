import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_COMMANDS } from '../contract.mjs';
import { DesktopNotifications, NOTIFICATION_COMMANDS, WINDOWS_APP_ID, WINDOWS_TOAST_ACTIVATOR } from '../notifications.mjs';
import { validProductionLaunch } from '../startup-arguments.mjs';

const window = { isDestroyed: () => false, isMinimized: () => false, restore() {}, show() {}, focus() {} };
function addon(overrides = {}) {
  const calls = [];
  const value = {
    calls, initializeNotifications() {}, notificationActivity: () => false, retireNotifications() {},
    notificationPermission: async (...args) => { calls.push(['permission', ...args]); return 'granted'; },
    notificationDiagnostics: () => { calls.push(['diagnostics']); return JSON.stringify({ schema: 1, appId: WINDOWS_APP_ID, setting: 'unregistered', steps: { setting: '0x80070490' } }); },
    notificationShortcutPath: () => { calls.push(['path']); return 'C:\\Users\\lab\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\open-super-agent.lnk'; },
    notificationAdoptShortcut: async () => { calls.push(['adopt']); },
    ...overrides,
  };
  return value;
}
const service = (native, options) => new DesktopNotifications(window, native, () => {}, options);

test('every notification command is reachable through the desktop bridge allowlist', () => {
  for (const command of NOTIFICATION_COMMANDS) assert.ok(DESKTOP_COMMANDS.includes(command), command);
  assert.ok(NOTIFICATION_COMMANDS.includes('desktop_notification_diagnostics') && NOTIFICATION_COMMANDS.includes('desktop_notification_shortcut'));
});

test('a permission read never carries a confirmation; a request forwards only a bounded body', async () => {
  const native = addon(), notifications = service(native, { platform: 'win32' });
  try {
    assert.equal(await notifications.request('desktop_notification_permission', { request: false }), 'granted');
    await assert.rejects(notifications.request('desktop_notification_permission', { request: false, confirmation: { body: 'x' } }), /invalid_notification/);
    assert.equal(await notifications.request('desktop_notification_permission', { request: true, confirmation: { body: '通知已开启。' } }), 'granted');
    assert.equal(await notifications.request('desktop_notification_permission', { request: true }), 'granted');
    for (const confirmation of [{ body: '' }, { body: 'a'.repeat(201) }, { body: 'x', title: 'y' }, 'x']) {
      await assert.rejects(notifications.request('desktop_notification_permission', { request: true, confirmation }), /invalid_notification/, JSON.stringify(confirmation));
    }
    // The read and the body-less request keep the exact single-argument native call (macOS shape).
    assert.deepEqual(native.calls, [['permission', false], ['permission', true, '通知已开启。'], ['permission', true]]);
  } finally { notifications.dispose(); }
});

test('diagnostics are Windows-only, path-free JSON plus a bounded OS version', async () => {
  const native = addon();
  const windows = service(native, { platform: 'win32', release: () => '10.0.22631' });
  const mac = service(addon(), { platform: 'darwin' });
  try {
    assert.deepEqual(await windows.request('desktop_notification_diagnostics', {}), { schema: 1, appId: WINDOWS_APP_ID, setting: 'unregistered', steps: { setting: '0x80070490' }, os: '10.0.22631' });
    await assert.rejects(windows.request('desktop_notification_diagnostics', { extra: true }), /invalid_notification/);
    await assert.rejects(mac.request('desktop_notification_diagnostics', {}), /native_notification_unavailable/);
    const long = service(addon(), { platform: 'win32', release: () => '9'.repeat(100) });
    assert.equal((await long.request('desktop_notification_diagnostics', {})).os.length, 32);
    long.dispose();
  } finally { windows.dispose(); mac.dispose(); }
});

test('creating the shortcut writes our identity only where none exists, then lets native verify it', async () => {
  const writes = [];
  const shell = { writeShortcutLink: (...args) => { writes.push(args); return true; } };
  const native = addon();
  const created = service(native, { platform: 'win32', shell, execPath: 'C:\\open-super-agent\\open-super-agent-client.exe', exists: () => false });
  try {
    assert.equal(await created.request('desktop_notification_shortcut', {}), null);
    assert.deepEqual(writes, [[native.notificationShortcutPath(), 'create', { target: 'C:\\open-super-agent\\open-super-agent-client.exe', appUserModelId: 'com.opensuperagent.client', toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR }]]);
    assert.deepEqual(native.calls.filter(call => call[0] !== 'path'), [['adopt']]);
  } finally { created.dispose(); }

  // An existing file is never overwritten; native adoption decides whether it is ours.
  writes.length = 0;
  const foreign = addon({ notificationAdoptShortcut: async () => { throw new Error('native_notification_install_required'); } });
  const existing = service(foreign, { platform: 'win32', shell, exists: () => true });
  try {
    await assert.rejects(existing.request('desktop_notification_shortcut', {}), /native_notification_install_required/);
    assert.deepEqual(writes, []);
  } finally { existing.dispose(); }

  const refused = addon();
  const failing = service(refused, { platform: 'win32', shell: { writeShortcutLink: () => false }, exists: () => false });
  try {
    await assert.rejects(failing.request('desktop_notification_shortcut', {}), /native_notification_registration_failed/);
    assert.ok(!refused.calls.some(call => call[0] === 'adopt'));
  } finally { failing.dispose(); }

  const macNative = addon();
  const mac = service(macNative, { platform: 'darwin', shell });
  try {
    await assert.rejects(mac.request('desktop_notification_shortcut', {}), /native_notification_unavailable/);
    assert.deepEqual(macNative.calls, []);
  } finally { mac.dispose(); }
});

test('the registration confirmation activation is an accepted Windows launch argument', () => {
  assert.equal(validProductionLaunch(['C:\\open-super-agent\\open-super-agent-client.exe', 'opensuperagent://notification/ready'], true, 'win32'), true);
});
