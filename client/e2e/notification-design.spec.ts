import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { openQuietHours } from "./fixtures/settings.js";
import type { ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ resolve: { alias: [
    { find: /^@capacitor\/core$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-core.ts", import.meta.url)) },
    { find: /^@capacitor\/push-notifications$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-push.ts", import.meta.url)) },
    { find: /^@capacitor\/app$/, replacement: fileURLToPath(new URL("./fixtures/notification-readiness-app.ts", import.meta.url)) },
  ] }, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
});
test.afterAll(async () => { await server?.close(); });
const open = async (page: any, query = "") => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/notification-readiness.html?permission=granted&" + query);
  await page.waitForFunction(() => !!window.readinessFixture);
};
const toggle = (page: any, name: string) => page.getByRole("switch", { name, exact: true });

for (const [platform, width, theme] of [["android", 390, "light"], ["ios", 390, "light"], ["macos", 1200, "light"], ["windows", 1000, "dark"], ["ios", 320, "dark"]] as const) {
  test(`notification settings are readable and operable on ${platform} ${width} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 }); await open(page, `platform=${platform}&theme=${theme}`);
    await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "true");
    for (const label of ["回复完成", "收到文件", "需要处理", "显示消息详情"]) {
      await expect(toggle(page, label)).toBeVisible();
      const box = await toggle(page, label).boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator("details.notification-quiet")).not.toHaveAttribute("open");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await toggle(page, "显示消息详情").press("Space");
    await expect(toggle(page, "显示消息详情")).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => page.evaluate(() => window.readinessFixture.connection.state.notifications.preferences.showPreview)).toBe(false);
    const desktop = ["macos", "windows"].includes(platform);
    await expect(page.getByText(desktop ? "使用其他应用时接收系统通知；点按通知回到对应对话。完全退出 open-super-agent 后不再提醒。" : "离开 open-super-agent 或锁屏后接收系统通知；点按通知回到对应对话。", { exact: true })).toBeVisible();
    await page.locator(".settings-group-heading").first().click();
    await page.screenshot({ path: info.outputPath(`${platform}-${width}-${theme}.png`), fullPage: true });
  });
}

test("a failed category write keeps the accepted switch and a later success preserves quiet-hour drafts", async ({ page }) => {
  await open(page, "platform=android");
  await openQuietHours(page);
  await page.getByLabel("勿扰开始", { exact: true }).fill("22:00");
  await page.getByLabel("勿扰结束", { exact: true }).fill("07:00");
  await page.evaluate(() => { window.readinessFixture.fixture.holdPreferences = true; window.readinessFixture.fixture.rejectPreferences = true; });
  await toggle(page, "回复完成").click();
  await expect(toggle(page, "回复完成")).toBeDisabled();
  await expect(page.locator("#notification-master-detail")).toHaveText("已开启");
  await expect(toggle(page, "回复完成")).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => { const f = window.readinessFixture.fixture; f.holdPreferences = false; f.preferenceReleases.splice(0).forEach((r: () => void) => r()); });
  await expect(page.getByRole("alert")).toHaveText("preferences_write_failed");
  await expect(toggle(page, "回复完成")).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => { window.readinessFixture.fixture.rejectPreferences = false; });
  await toggle(page, "回复完成").click();
  await expect(toggle(page, "回复完成")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
  await expect(page.getByLabel("勿扰结束", { exact: true })).toHaveValue("07:00");
  await expect(toggle(page, "收到文件")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => window.readinessFixture.connection.state.notifications.preferences.enabled)).toBe(true);
});

test("an older host exposes no unsupported category or preview controls", async ({ page }) => {
  await open(page, "platform=android&customization=false");
  await expect(toggle(page, "回复完成")).toHaveCount(0);
  await expect(toggle(page, "显示消息详情")).toHaveCount(0);
  await expect(page.getByText("更新主机后，可分别选择提醒内容和隐藏消息详情。", { exact: true })).toBeVisible();
  await toggle(page, "消息提醒").click();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  const writes = await page.evaluate(() => window.readinessFixture.fixture.writes);
  expect(writes).toHaveLength(1);
  expect(Object.keys(writes[0].body).sort()).toEqual(["enabled", "quietEnd", "quietStart", "timeZone"]);
});

for (const platform of ["android", "ios", "macos", "windows"]) test(`system settings stays accessible with reminders off and never changes consent on ${platform}`, async ({ page }) => {
  await open(page, `platform=${platform}&enabled=false`);
  const link = page.getByRole("button", { name: platform === "android" ? "声音与振动设置" : platform === "ios" ? "声音与锁屏设置" : "声音与横幅设置", exact: true });
  await expect(link).toBeEnabled();
  await link.click();
  await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.calls.some((x: string) => x === "settings" || x.includes("settings")))).toBe(true);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => { window.readinessFixture.nativeState.settingsFail = true; });
  await link.click();
  await expect(page.getByRole("alert")).toContainText(platform === "android" ? "无法打开系统设置" : "设置");
});

test("preparing event choices while reminders are off does not register push or turn them on", async ({ page }) => {
  await open(page, "platform=android&enabled=false");
  await toggle(page, "需要处理").click();
  await expect(toggle(page, "需要处理")).toHaveAttribute("aria-checked", "false");
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes.map((w: any) => w.route))).toEqual(["/api/notifications"]);
  expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("TOKEN");
});

for (const platform of ["macos", "windows"]) test(`blocked desktop permission gives a recovery action without re-requesting on ${platform}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, `platform=${platform}&enabled=false`);
  await page.evaluate(() => { window.readinessFixture.nativeState.permission = "denied"; });
  await openQuietHours(page);
  await page.getByLabel("勿扰开始", { exact: true }).fill("22:00");
  await toggle(page, "消息提醒").click();
  expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("permission-request");
  await expect(page.getByRole("alert")).toContainText("系统通知已关闭");
  const recovery = page.locator(".notification-permission-help");
  await expect(recovery).toContainText(platform === "macos" ? "系统设置 → 通知 → open-super-agent" : "Windows 设置 → 系统 → 通知（Windows 10 为「通知和操作」），在列表中找到 open-super-agent");
  await expect(recovery).toContainText("返回此页重新开启消息提醒");
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: info.outputPath(`${platform}-permission-recovery.png`), fullPage: true });
  await recovery.getByRole("button", { name: "前往系统设置", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.readinessFixture.nativeState.calls.includes("settings"))).toBe(true);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
  await page.evaluate(() => { window.readinessFixture.nativeState.settingsFail = true; });
  await recovery.getByRole("button", { name: "前往系统设置", exact: true }).click();
  await expect(recovery.getByRole("alert")).toContainText("设置");
  await page.evaluate(() => { window.readinessFixture.nativeState.permission = "granted"; });
  await toggle(page, "消息提醒").click();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "true");
  await expect(recovery).toHaveCount(0);
  await expect(page.getByLabel("勿扰开始", { exact: true })).toHaveValue("22:00");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toHaveLength(1);
});

for (const phase of ["read", "request"]) test(`desktop permission ${phase} errors retain an actionable path without claiming enabled`, async ({ page }) => {
  await open(page, `platform=macos&enabled=false&${phase === "read" ? "permissionError" : "requestError"}=native_notification_permission_failed`);
  await page.evaluate(() => { window.readinessFixture.nativeState.permission = "prompt"; });
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toContainText("系统通知");
  await expect(page.locator(".notification-permission-help").getByRole("button", { name: "前往系统设置", exact: true })).toBeVisible();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});

test("a desktop Host save failure does not misdirect granted permission to OS recovery", async ({ page }) => {
  await open(page, "platform=macos&enabled=false");
  await page.evaluate(() => { window.readinessFixture.fixture.rejectPreferences = true; });
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toHaveText("preferences_write_failed");
  await expect(page.locator(".notification-permission-help")).toHaveCount(0);
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.nativeState.calls)).not.toContain("permission-request");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toHaveLength(1);
});

test("a delayed system-settings receipt does not become a false failure and late success clears the fallback", async ({ page }) => {
  await page.clock.install(); await open(page, "platform=ios&enabled=false");
  await page.evaluate(() => { window.readinessFixture.fixture.holdSystem = true; });
  await page.getByRole("button", { name: "声音与锁屏设置", exact: true }).click();
  await page.clock.runFor(10_001);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("也可手动打开系统设置，选择「通知 → open-super-agent」。", { exact: true })).toBeVisible();
  await page.evaluate(() => window.readinessFixture.fixture.systemReleases.splice(0).forEach((release: () => void) => release()));
  await expect(page.getByText("也可手动打开系统设置，选择「通知 → open-super-agent」。", { exact: true })).toHaveCount(0);
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
});

test("reception diagnostics respect manual collapse on both a warning and a ready state", async ({ page }) => {
  await open(page, "platform=android&configured=false");
  const details = page.locator("details.notification-readiness");
  await expect(page.getByText("主机推送尚未配置", { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute("open");
  await details.locator("summary").click();
  await expect(details).not.toHaveAttribute("open");
  await page.evaluate(() => window.readinessFixture.publish());
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open");
  await open(page, "platform=android");
  await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click();
  await page.getByRole("button", { name: "检查接收状态", exact: true }).click();
  await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute("open");
});

// Windows: an unpackaged App has no notification profile until its first toast.
const permissionCalls = (page: any) => page.evaluate(() => window.readinessFixture.nativeState.desktopCalls.filter((c: any) => c.command === "desktop_notification_permission").map((c: any) => c.args));
const desktopCommands = (page: any) => page.evaluate(() => window.readinessFixture.nativeState.desktopCalls.map((c: any) => c.command));
const recheck = async (page: any, name = "检查接收状态") => {
  const details = page.locator("details.notification-readiness");
  await expect(details.locator("summary strong")).not.toHaveText(/正在检查|Checking/);
  if (!await details.evaluate((e: HTMLDetailsElement) => e.open)) await details.locator("summary").click();
  await page.getByRole("button", { name, exact: true }).click();
};
const diagnostics = (extra: Record<string, unknown>) => ({ schema: 1, appId: "com.opensuperagent.client", identity: "verified", receipt: "valid", shortcut: "programs", steps: {}, os: "10.0.22631", ...extra });

for (const locale of ["zh", "en"] as const) test(`Windows registers an unregistered App with one localized confirmation toast (${locale})`, async ({ page }) => {
  const zh = locale === "zh";
  await open(page, `platform=windows&enabled=false&lang=${locale}`);
  await page.evaluate(() => { const n = window.readinessFixture.nativeState; n.permission = "prompt"; n.afterRequest = "granted"; });
  await toggle(page, zh ? "消息提醒" : "Message alerts").click();
  await expect(toggle(page, zh ? "消息提醒" : "Message alerts")).toHaveAttribute("aria-checked", "true");
  expect(await permissionCalls(page)).toEqual([{ request: false }, { request: true, confirmation: { body: zh ? "这是一条 open-super-agent 测试通知，用于检查通知显示。" : "This is a open-super-agent test notification to check notification display." } }, { request: false }]);
  expect((await page.evaluate(() => window.readinessFixture.fixture.writes)).map((w: any) => w.body.enabled)).toEqual([true]);
  await expect(page.getByText(zh ? "接收条件已就绪" : "Receiving requirements are ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText(zh ? "打开 Windows 通知设置后，在列表中选择 open-super-agent。open-super-agent 发出第一条通知后才会出现在该列表中。" : "Open Windows notification settings, then select open-super-agent in the list. open-super-agent appears there only after its first notification.", { exact: true })).toBeVisible();
});

test("macOS permission requests are unchanged: no confirmation text and no Windows diagnostics", async ({ page }) => {
  await open(page, "platform=macos&enabled=false");
  await page.evaluate(() => { const n = window.readinessFixture.nativeState; n.permission = "prompt"; n.afterRequest = "granted"; });
  await toggle(page, "消息提醒").click();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "true");
  expect((await permissionCalls(page)).slice(0, 2)).toEqual([{ request: false }, { request: true }]);
  await open(page, "platform=macos&enabled=false&permissionError=native_notification_permission_failed");
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toHaveText("无法读取系统通知权限，请检查系统设置后重试。");
  expect(await desktopCommands(page)).not.toContain("desktop_notification_diagnostics");
  await expect(page.getByRole("button", { name: "复制诊断信息", exact: true })).toHaveCount(0);
});

for (const locale of ["zh", "en"] as const) test(`Windows unverified registration preserves consent without claiming readiness (${locale})`, async ({ page }) => {
  const zh = locale === "zh";
  await open(page, `platform=windows&enabled=false&lang=${locale}`);
  await page.evaluate(value => {
    const n = window.readinessFixture.nativeState;
    n.permission = "prompt"; n.afterRequest = "granted"; n.diagnostics = value;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedDiagnostics = text; } } });
  }, diagnostics({ setting: "unregistered", registration: "unverified", steps: { setting: "0x80070490", confirm: "0x00000000" } }));
  await toggle(page, zh ? "消息提醒" : "Message alerts").click();
  await expect(toggle(page, zh ? "消息提醒" : "Message alerts")).toHaveAttribute("aria-checked", "true");
  const readiness = page.locator(".notification-readiness");
  await expect(readiness).toHaveAttribute("data-state", "windows-unverified");
  await expect(readiness).toContainText(zh ? "Windows 通知状态尚未确认" : "Windows notification status is unverified");
  await expect(page.getByText(zh ? "接收条件已就绪" : "Receiving requirements are ready", { exact: true })).toHaveCount(0);
  await expect(readiness).not.toContainText(zh ? "权限与接收设置检查通过" : "Permissions and receiving settings passed");
  await readiness.getByRole("button", { name: zh ? "复制诊断信息" : "Copy diagnostics", exact: true }).click();
  expect(JSON.parse(await page.evaluate(() => (window as any).copiedDiagnostics))).toMatchObject({ setting: "unregistered", registration: "unverified" });
  await page.getByRole("button", { name: zh ? "声音与横幅设置" : "Sounds and banners", exact: true }).click();
  await recheck(page, zh ? "检查接收状态" : "Check receiving status");
  await expect(readiness).toHaveAttribute("data-state", "windows-unverified");
  expect((await permissionCalls(page)).filter((args: any) => args.request)).toHaveLength(1);
  expect((await page.evaluate(() => window.readinessFixture.fixture.writes)).map((w: any) => w.body.enabled)).toEqual([true]);

  // A newly readable Enabled setting wins over the previous registration result.
  await page.evaluate(() => { window.readinessFixture.nativeState.diagnostics.setting = "enabled"; });
  await recheck(page, zh ? "检查接收状态" : "Check receiving status");
  await expect(readiness).toHaveAttribute("data-state", "ready");
  await expect(page.getByText(zh ? "接收条件已就绪" : "Receiving requirements are ready", { exact: true })).toBeVisible();
});

test("Windows unknown or missing setting stays unverified while older shells without diagnostics remain compatible", async ({ page }) => {
  await open(page, "platform=windows");
  for (const setting of ["unknown", "unreadable", undefined]) {
    await page.evaluate(value => { window.readinessFixture.nativeState.diagnostics = value; }, diagnostics({ setting }));
    await recheck(page);
    await expect(page.locator(".notification-readiness")).toHaveAttribute("data-state", "windows-unverified");
  }
  await page.evaluate(() => { window.readinessFixture.nativeState.diagnostics = undefined; });
  await recheck(page);
  await expect(page.locator(".notification-readiness")).toHaveAttribute("data-state", "ready");
  expect((await permissionCalls(page)).filter((args: any) => args.request)).toEqual([]);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});

for (const platform of ["macos", "ios", "android"]) test(`${platform} readiness never reads Windows diagnostics`, async ({ page }) => {
  await open(page, `platform=${platform}`);
  await expect(page.locator(".notification-readiness")).toHaveAttribute("data-state", "ready");
  await recheck(page);
  await expect(page.locator(".notification-readiness")).toHaveAttribute("data-state", "ready");
  expect(await desktopCommands(page)).not.toContain("desktop_notification_diagnostics");
});

for (const [setting, text, settings] of [
  ["disabled_for_application", "Windows 已关闭 open-super-agent 的通知。请在「设置 → 系统 → 通知」的列表中打开 open-super-agent。", true],
  ["disabled_for_user", "Windows 的通知总开关已关闭。请先在「设置 → 系统 → 通知」中打开。", true],
  ["disabled_by_group_policy", "此电脑的管理策略禁用了通知，无法开启。", false],
] as const) test(`Windows ${setting} is explained without a second request or a confirmation toast`, async ({ page }) => {
  await open(page, "platform=windows&enabled=false");
  await page.evaluate(setting => { const n = window.readinessFixture.nativeState; n.permission = "denied"; n.diagnostics = { schema: 1, appId: "com.opensuperagent.client", setting, steps: { setting: "0x00000000" } }; }, setting);
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toHaveText(text);
  expect(await permissionCalls(page)).toEqual([{ request: false }]);
  await expect(page.locator(".notification-permission-help")).toHaveCount(settings ? 1 : 0);
  await expect(page.getByRole("button", { name: "复制诊断信息", exact: true })).toBeVisible();
  await expect(toggle(page, "消息提醒")).toHaveAttribute("aria-checked", "false");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});

for (const locale of ["zh", "en"] as const) test(`a missing Windows shortcut is created only after the user asks, then registered (${locale})`, async ({ page }, info) => {
  const zh = locale === "zh";
  await page.setViewportSize({ width: 1000, height: 900 });
  await open(page, `platform=windows&enabled=false&lang=${locale}`);
  await page.evaluate(() => { const n = window.readinessFixture.nativeState; n.permission = "prompt"; n.afterRequest = "granted"; n.readError = "native_notification_install_required"; n.diagnostics = { schema: 1, appId: "com.opensuperagent.client", identity: "missing", receipt: "missing", steps: {} }; });
  await toggle(page, zh ? "消息提醒" : "Message alerts").click();
  await expect(page.getByRole("alert")).toHaveText(zh ? "未找到 open-super-agent 的开始菜单快捷方式，Windows 需要它来显示通知。" : "open-super-agent's Start Menu shortcut is missing. Windows needs it to show notifications.");
  expect(await desktopCommands(page)).not.toContain("desktop_notification_shortcut");
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`windows-shortcut-${locale}.png`), fullPage: true });
  await page.getByRole("button", { name: zh ? "创建快捷方式并开启" : "Create shortcut and turn on", exact: true }).click();
  await expect(toggle(page, zh ? "消息提醒" : "Message alerts")).toHaveAttribute("aria-checked", "true");
  const commands = await desktopCommands(page);
  expect(commands.indexOf("desktop_notification_shortcut")).toBeGreaterThan(-1);
  expect(commands.indexOf("desktop_notification_shortcut")).toBeLessThan(commands.lastIndexOf("desktop_notification_permission"));
  expect((await permissionCalls(page)).filter((args: any) => args.request)).toHaveLength(1);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toHaveLength(1);
});

for (const width of [1000, 360]) test(`a Windows notification failure shows its HRESULT and copies path-free diagnostics at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await open(page, "platform=windows&enabled=false");
  await page.evaluate(value => { const n = window.readinessFixture.nativeState; n.readError = "native_notification_platform_unavailable"; n.diagnostics = value;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedDiagnostics = text; } } }); },
    diagnostics({ setting: "platform_unavailable", error: "native_notification_platform_unavailable", failure: { stage: "setting", code: "0x803E0105" }, steps: { setting: "0x803E0105", notifier: "0x00000000" } }));
  await toggle(page, "消息提醒").click();
  await expect(page.getByRole("alert")).toHaveText("Windows 通知服务不可用（代码 0x803E0105），暂时无法发送系统通知。");
  await expect(page.getByText("代码 0x803E0105 · setting", { exact: true })).toBeVisible();
  await expect(page.locator(".notification-permission-help")).toHaveCount(0);
  await page.getByRole("button", { name: "复制诊断信息", exact: true }).click();
  await expect(page.locator(".notification-diagnostics [role=status]")).toHaveText("诊断信息已复制");
  const copied = await page.evaluate(() => (window as any).copiedDiagnostics);
  expect(JSON.parse(copied)).toMatchObject({ app: "open-super-agent", version: expect.stringMatching(/^\d+\.\d+\.\d+$/), appId: "com.opensuperagent.client", failure: { stage: "setting", code: "0x803E0105" }, os: "10.0.22631" });
  expect(copied).not.toMatch(/[A-Za-z]:\\|\/Users\/|\.lnk/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`windows-diagnostics-${width}.png`), fullPage: true });
});

test("Windows failure messages keep the HRESULT in both languages", async ({ page }) => {
  for (const [error, failure, zh, en] of [
    ["native_notification_identity_unresolved", "0x80070490", "Windows 无法把通知关联到 open-super-agent（代码 0x80070490）。请重新安装 open-super-agent，并保留开始菜单快捷方式。", "Windows couldn't link notifications to open-super-agent (code 0x80070490). Reinstall open-super-agent and keep the Start Menu shortcut."],
    ["native_notification_permission_failed", "0x80004005", "无法完成 Windows 通知登记（代码 0x80004005）。", "Couldn't register open-super-agent for Windows notifications (code 0x80004005)."],
  ] as const) for (const locale of ["zh", "en"] as const) {
    await open(page, `platform=windows&enabled=false&lang=${locale}&requestError=${error}`);
    await page.evaluate(code => { const n = window.readinessFixture.nativeState; n.permission = "prompt"; n.diagnostics = { schema: 1, appId: "com.opensuperagent.client", setting: "unregistered", registration: "failed", failure: { stage: "confirm", code }, steps: { setting: "0x80070490", confirm: code } }; }, failure);
    await toggle(page, locale === "zh" ? "消息提醒" : "Message alerts").click();
    await expect(page.getByRole("alert")).toHaveText(locale === "zh" ? zh : en);
    await expect(page.getByText(locale === "zh" ? `代码 ${failure} · confirm` : `Code ${failure} · confirm`, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
  }
});

for (const locale of ["zh", "en"] as const) test(`Windows readiness re-registers an unregistered App without changing Hub preferences (${locale})`, async ({ page }) => {
  const zh = locale === "zh";
  await open(page, `platform=windows&lang=${locale}`);
  await page.evaluate(() => { const n = window.readinessFixture.nativeState; n.permission = "prompt"; n.afterRequest = "granted"; });
  await recheck(page, zh ? "检查接收状态" : "Check receiving status");
  await expect(page.getByText(zh ? "Windows 尚未登记通知" : "Not yet registered with Windows", { exact: true })).toBeVisible();
  await expect(page.getByText(zh ? "关闭后重新开启消息提醒，即可申请通知权限。" : "Turn reminders off and on again to request notification permission.", { exact: true })).toHaveCount(0);
  expect((await permissionCalls(page)).every((args: any) => !args.request)).toBe(true);
  await page.getByRole("button", { name: zh ? "重新启用通知" : "Re-enable notifications", exact: true }).click();
  await expect(page.getByText(zh ? "接收条件已就绪" : "Receiving requirements are ready", { exact: true })).toBeVisible();
  expect((await permissionCalls(page)).filter((args: any) => args.request)).toEqual([{ request: true, confirmation: { body: zh ? "这是一条 open-super-agent 测试通知，用于检查通知显示。" : "This is a open-super-agent test notification to check notification display." } }]);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});

test("Windows readiness offers the shortcut repair and reports a refused creation", async ({ page }) => {
  await open(page, "platform=windows");
  await page.evaluate(() => { const n = window.readinessFixture.nativeState; n.permission = "prompt"; n.afterRequest = "granted"; n.readError = "native_notification_install_required"; n.shortcutFail = true; });
  await recheck(page);
  await expect(page.getByText("未找到开始菜单快捷方式", { exact: true })).toBeVisible();
  expect(await desktopCommands(page)).not.toContain("desktop_notification_shortcut");
  await page.getByRole("button", { name: "创建快捷方式并开启", exact: true }).click();
  await expect(page.locator(".notification-readiness").getByRole("alert")).toHaveText("无法创建开始菜单快捷方式。请重新安装 open-super-agent，并保留开始菜单快捷方式。");
  expect((await permissionCalls(page)).filter((args: any) => args.request)).toEqual([]);
  await page.evaluate(() => { window.readinessFixture.nativeState.shortcutFail = false; });
  await page.getByRole("button", { name: "创建快捷方式并开启", exact: true }).click();
  await expect(page.getByText("接收条件已就绪", { exact: true })).toBeVisible();
  expect((await permissionCalls(page)).filter((args: any) => args.request)).toHaveLength(1);
  expect(await page.evaluate(() => window.readinessFixture.fixture.writes)).toEqual([]);
});
