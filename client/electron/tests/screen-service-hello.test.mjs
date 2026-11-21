import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScreenService } from '../screen-service.mjs';

/** A macOS target's registration text is a wire contract with every Hub
 * version: other target platforms must join without changing a byte of it
 * (#48/#49 design S9). This socket keeps the exact text the service sends;
 * every input is synthetic and fixed. */
async function registration(t, capabilities) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'screen-hello-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await writeFile(path.join(stateDir, 'screen-desktop.json'), JSON.stringify({ format: 1, desktopId: 'desktop-fixture' }));
  const sockets = [];
  class RawSocket extends EventEmitter {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data, options, callback) { this.sent.push(data); (typeof options === 'function' ? options : callback)?.(); }
    open() { this.readyState = 1; this.emit('open'); }
    close(code = 1005, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
    terminate() { this.close(1006); }
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2, rotation: 0, label: 'Display fixture' };
  const service = new ScreenService({ platform: 'darwin', stateDir, WebSocketClass: RawSocket,
    electron: { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display] }), powerMonitor: new EventEmitter(), shell: {},
      systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true } },
    addon: { screenMouse() {}, screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001' }),
      screenDisplayUuid: () => 'display-fixture', screenReleaseAll: () => 0, screenMonitorStop() {} },
    hostControl: { ticket: async () => ({ ticket: 'T'.repeat(43), instancePort: 1, ...(capabilities ? { capabilities } : {}) }) },
    captureHost: () => ({ close() {} }) });
  t.after(() => service.dispose());
  service.instanceId = 'screen-fixture';
  await service.start();
  for (let i = 0; i < 200 && !sockets.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:1/screen/v1/target');
  sockets[0].open();
  return sockets[0].sent;
}
const desktop = '{"desktopId":"desktop-fixture","instanceId":"screen-fixture","loginSession":"cgs-00000000-0000-0000-0000-000000000001","platform":"macos","capture":"granted","accessibility":true,"locked":false,'
  + '"displays":[{"id":"display-fixture","nativeId":"1","name":"Display fixture","revision":1,"x":0,"y":0,"width":1440,"height":900,"scale":2,"rotation":0}]}';

test('a macOS target registers with byte-identical hello text for an older Hub', async t => {
  const sent = await registration(t);
  assert.deepEqual(sent, [`{"type":"hello","ticket":"${'T'.repeat(43)}","desktop":${desktop}}`]);
});

test('a macOS target registers with byte-identical hello text for a Hub that negotiates quality', async t => {
  const sent = await registration(t, ['screen-quality-v1']);
  assert.deepEqual(sent, [`{"type":"hello","ticket":"${'T'.repeat(43)}","desktop":${desktop},"features":["screen.quality.v1"]}`]);
});
