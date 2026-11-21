import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// Actual renderer with a Capacitor bridge double. Native URI grants and the
// Android installer are checked separately by instrumentation.
test.use({ viewport: { width: 390, height: 844 } });
for (const name of ["update.apk", "notes.txt"]) test(`Android saved ${name} opens the existing copy without downloading again`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?name=" + name);
    const save = page.getByRole("button", { name: `保存到手机 ${name}`, exact: true });
    const open = page.getByRole("button", { name: name.endsWith(".apk") ? "安装 APK" : "打开文件", exact: true });
    await expect(open).toHaveCount(0);
    await save.click(); await expect(open).toBeVisible();
    if (name.endsWith(".apk")) await page.screenshot({ path: test.info().outputPath("apk-saved.png") });
    await expect(page.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).savedFixture.fail = "attachment_install_permission_required"; });
    await open.click(); await expect(page.getByRole("alert")).toContainText("允许 open-super-agent 安装未知应用");
    await expect(page.getByRole("status")).toHaveText("已保存到手机");
    await page.evaluate(() => { (window as any).savedFixture.fail = ""; });
    await open.click(); await expect(page.getByRole("button", { name: "正在打开…", exact: true })).toBeDisabled();
    await expect(save).toBeDisabled(); await save.dispatchEvent("click"); // Serialized with the open operation.
    await page.evaluate(() => (window as any).savedFixture.release());
    await expect(open).toBeEnabled();
    expect(await page.evaluate(() => { const s = (window as any).savedFixture; return { downloads: s.downloads, saves: s.saves, opened: s.opened }; })).toEqual({ downloads: 1, saves: 1, opened: ["content://media/external/downloads/123", "content://media/external/downloads/123"] });
    await page.evaluate(() => { (window as any).savedFixture.cancel = true; });
    await save.click(); await expect(page.getByRole("status")).toHaveText("已取消保存"); await expect(open).toBeVisible();
    await page.evaluate(() => { const s = (window as any).savedFixture; s.cancel = false; s.legacy = true; });
    await save.click(); await expect(page.getByRole("status")).toContainText("已保存到手机"); await expect(open).toBeVisible();
  } finally { await page.close(); await server.close(); }
});

for (const name of ["update.apk", "notes.txt"]) test(`Android saved ${name} survives remount/reload and remains isolated to its host and device`, async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?name=" + name);
    const open = page.getByRole("button", { name: name.endsWith(".apk") ? "安装 APK" : "打开文件", exact: true });
    await page.getByRole("button", { name: `保存到手机 ${name}`, exact: true }).click();
    await expect(open).toBeVisible();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.locator(".file-status").evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${width}-saved.png`) });
    }
    await page.evaluate(() => (window as any).savedFixture.hide()); await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.show()); await expect(open).toBeVisible();
    await page.reload(); await expect(open).toBeVisible();
    await open.click(); await expect(page.getByRole("button", { name: "正在打开…", exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.release()); await expect(open).toBeEnabled();
    expect(await page.evaluate(() => { const s = (window as any).savedFixture; return [s.downloads, s.saves, s.opened]; })).toEqual([1, 1, ["content://media/external/downloads/123"]]);
    await page.evaluate(() => (window as any).savedFixture.host("host-b")); await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.host("host-a")); await expect(open).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.device("device-b")); await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.device("device-a")); await expect(open).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.removeLocal()); await expect(open).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).savedFixture.downloads)).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test("a delayed old receipt check cannot clear a newly saved Android copy", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html");
    await expect(page.locator(".file-card")).toBeVisible();
    await page.evaluate(() => { const s = (window as any).savedFixture; s.delayRestore = true; s.hide(); });
    await expect(page.locator(".file-card")).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.show());
    await page.waitForFunction(() => !!(window as any).savedFixture.releaseRestore);
    await page.getByRole("button", { name: "保存到手机 update.apk", exact: true }).click();
    const open = page.getByRole("button", { name: "安装 APK", exact: true }); await expect(open).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.releaseRestore());
    await expect(open).toBeVisible(); await open.click();
    await expect.poll(() => page.evaluate(() => (window as any).savedFixture.opened)).toEqual(["content://media/external/downloads/123"]);
  } finally { await page.close(); await server.close(); }
});

for (const name of ["update.apk", "payload.bin"]) test(`Play ${name} keeps save and share without either APK open action`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/android-saved-file.html?channel=play&name=${name}&mime=application/vnd.android.package-archive`);
    await page.getByRole("button", { name: `保存到手机 ${name}`, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到手机");
    await expect(page.getByRole("button", { name: /^(安装 APK|打开文件)$/ })).toHaveCount(0);
    await page.getByRole("button", { name: `预览 ${name}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "用其他应用打开", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "分享附件", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).savedFixture.shares)).toBe(1);
    expect(await page.evaluate(() => (window as any).savedFixture.opened)).toEqual([]);
  } finally { await page.close(); await server.close(); }
});

test("Play ordinary files still have saved and external open actions", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?channel=play&name=notes.txt");
    await page.getByRole("button", { name: "保存到手机 notes.txt", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "预览 notes.txt", exact: true }).click();
    await expect(page.getByRole("button", { name: "用其他应用打开", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).savedFixture.statusCalls)).toBe(0);
  } finally { await page.close(); await server.close(); }
});

for (const channel of ["play", "github", "legacy"]) test(`APK opening waits for native distribution: ${channel}`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/android-saved-file.html?name=update.apk&channel=${channel}&delayed=1`);
    await page.getByRole("button", { name: "保存到手机 update.apk", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到手机");
    await expect(page.getByRole("button", { name: "安装 APK", exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.releaseStatus());
    if (channel === "play") await expect(page.getByRole("button", { name: "安装 APK", exact: true })).toHaveCount(0);
    else await expect(page.getByRole("button", { name: "安装 APK", exact: true })).toBeVisible();
  } finally { await page.close(); await server.close(); }
});

for (const channel of ["play", "github"]) test(`${channel} draft APK keeps save and share with channel-specific external open`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/android-saved-file.html?draft&channel=${channel}&name=payload.bin&mime=application/vnd.android.package-archive`);
    const preview = page.getByRole("dialog");
    await expect(preview).toBeVisible();
    await page.waitForFunction(() => (window as any).savedFixture.statusCalls > 0);
    if (channel === "play") await expect(preview.getByRole("button", { name: "用其他应用打开" })).toHaveCount(0);
    else await expect(preview.getByRole("button", { name: "用其他应用打开" })).toBeVisible();
    await preview.getByRole("button", { name: "保存到手机", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).savedFixture.saves)).toBe(1);
    await preview.getByRole("button", { name: "分享附件" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).savedFixture.shares)).toBe(1);
    expect(await page.evaluate(() => (window as any).savedFixture.opened)).toEqual([]);
  } finally { await page.close(); await server.close(); }
});

for (const name of ["update.apk.", "更新.APK. ", "update.APK", "apk", "a".repeat(156) + ".apk" + "x".repeat(24)]) test(`Play hides APK actions after export normalizes ${JSON.stringify(name)}`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?channel=play&name=" + encodeURIComponent(name));
    await page.getByRole("button", { name: /^保存到手机 / }).click();
    await expect(page.getByRole("status")).toHaveText("已保存到手机");
    await expect(page.getByRole("button", { name: /^(安装 APK|打开文件)$/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^预览 / }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "用其他应用打开", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "分享附件", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).savedFixture.shares)).toBe(1);
    expect(await page.evaluate(() => (window as any).savedFixture.opened)).toEqual([]);
  } finally { await page.close(); await server.close(); }
});


test("GitHub known non-APK extension keeps the file-open label even with APK MIME", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?channel=github&name=payload.bin&mime=application/vnd.android.package-archive");
    await page.getByRole("button", { name: "保存到手机 payload.bin", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开文件", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "安装 APK", exact: true })).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

for (const platform of ["ios", "web"]) test(`${platform} APK preview never requests Android channel status`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/android-saved-file.html?draft&platform=${platform}&channel=play&name=update.apk&mime=application/vnd.android.package-archive`);
    const preview = page.getByRole("dialog");
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("button", { name: "用其他应用打开", exact: true })).toHaveCount(platform === "ios" ? 1 : 0);
    // Allow mounted effects to run before observing the bridge call counter.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => (window as any).savedFixture.statusCalls)).toBe(0);
  } finally { await page.close(); await server.close(); }
});
