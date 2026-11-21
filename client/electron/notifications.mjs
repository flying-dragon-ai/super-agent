import { existsSync } from 'node:fs';
import os from 'node:os';
import { z } from 'zod';
const empty = z.object({}).strict(), id = z.string().max(128), host = z.string().regex(/^hub_[0-9a-f]{64}$/);
// Same identity the installer stamps (windows_identity.rs STUB_CLSID, windows_payload.rs APP_ID).
export const WINDOWS_APP_ID = 'com.opensuperagent.client';
export const WINDOWS_TOAST_ACTIVATOR = '{5E8C5C51-D485-4C46-B76A-02547BCD6776}';
const schemas = {
  desktop_notifications_supported: empty, desktop_notification_context: empty, desktop_notification_peek: empty,
  // `confirmation`: localized body of the one Windows registration toast. Only
  // an explicit request may carry it; a read never shows or writes anything.
  desktop_notification_permission: z.object({ request: z.boolean(), confirmation: z.object({ body: z.string().min(1).max(200) }).strict().optional() }).strict()
    .refine(args => args.request || !args.confirmation),
  desktop_notification_ack: z.object({ id }).strict(),
  desktop_notification_clear: z.object({ documentId: id, hostId: host.optional() }).strict(),
  desktop_notification_show: z.object({ documentId: id, notice: z.object({
    id, hostId: host, conversationId: id, messageId: id, title: z.literal('Open Super Agent'), body: z.string().max(200),
    kind: z.enum(['answer', 'action', 'error']), at: z.number().int().nonnegative(),
  }).strict() }).strict(),
  // Windows only. Path-free native status for support; adds the OS version only.
  desktop_notification_diagnostics: empty,
  // Windows only, after the user clicked "Create shortcut and turn on" (e.g. a
  // `/NS` install). Never called at startup or from a read.
  desktop_notification_shortcut: empty,
};
export const NOTIFICATION_COMMANDS = Object.freeze(Object.keys(schemas));
export class DesktopNotifications {
  constructor(window, addon, emit, { platform = process.platform, shell, execPath = process.execPath, release = os.release, exists = existsSync } = {}) {
    this.window = window; this.addon = addon;
    this.platform = platform; this.shell = shell; this.execPath = execPath; this.release = release; this.exists = exists;
    if (!addon) return;
    addon.initializeNotifications();
    this.timer = setInterval(() => {
      if (window.isDestroyed() || !addon.notificationActivity()) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      emit('open-super-agent-notification-action', null);
    }, 250);
    this.timer.unref();
  }
  async request(command, input) {
    const parsed = schemas[command]?.safeParse(input);
    if (!parsed?.success) throw new Error('invalid_notification');
    const args = parsed.data, addon = this.addon;
    if (!addon) throw new Error('native_notification_unavailable');
    switch (command) {
      case 'desktop_notifications_supported': return true;
      case 'desktop_notification_context': return addon.notificationContext();
      case 'desktop_notification_permission': return args.confirmation ? addon.notificationPermission(args.request, args.confirmation.body) : addon.notificationPermission(args.request);
      case 'desktop_notification_peek': return JSON.parse(addon.notificationPeek());
      case 'desktop_notification_ack': addon.notificationAck(args.id); return null;
      case 'desktop_notification_clear': return addon.notificationClear(args.hostId ?? null, args.documentId);
      case 'desktop_notification_show': return addon.notificationShow(JSON.stringify(args.notice), args.documentId);
      case 'desktop_notification_diagnostics': {
        if (this.platform !== 'win32') throw new Error('native_notification_unavailable');
        const value = JSON.parse(addon.notificationDiagnostics());
        return { ...value, os: String(this.release()).slice(0, 32) };
      }
      case 'desktop_notification_shortcut': {
        if (this.platform !== 'win32' || !this.shell?.writeShortcutLink) throw new Error('native_notification_unavailable');
        // Native chooses the location (Programs\open-super-agent.lnk). An existing file
        // is never overwritten: native adoption verifies it targets this App.
        const link = addon.notificationShortcutPath();
        if (!this.exists(link) && !this.shell.writeShortcutLink(link, 'create', { target: this.execPath, appUserModelId: WINDOWS_APP_ID, toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR })) {
          throw new Error('native_notification_registration_failed');
        }
        await addon.notificationAdoptShortcut();
        return null;
      }
      default: throw new Error('unknown_notification_command');
    }
  }
  retire() { this.addon?.retireNotifications(); }
  dispose() { clearInterval(this.timer); this.retire(); }
}
