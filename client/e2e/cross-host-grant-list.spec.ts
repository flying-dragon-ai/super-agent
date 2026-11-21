import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// The Cross-host scope as the Local page's checkbox list, against a
// controllable receiving-Host double (synthetic names only). The real signed
// write, Host policy and readback stay covered by bot-message-grants.spec.ts.
test.use({ serviceWorkers: "block" });
let server: Awaited<ReturnType<typeof createServer>>, base = "";
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  base = `${server.resolvedUrls!.local[0]}e2e/fixtures/cross-host-grants.html`;
});
test.afterAll(async () => { await server.close(); });

type Fixture = {
  server: { revision: number; hosts: { id: string; name: string; available: boolean }[]; bots: { id: string; name: string; online: boolean; deleted?: true }[]; grants: { sourceHost: string; sourceBot: string; targetBot: string }[] };
  commands: { operation: string; sourceHost: string; sourceBot: string; revision: string; changes: { targetBot: string; allowed: boolean }[] }[];
  control: { failGet: number; holdPost: boolean; release: () => void; gets: number; receipt: "ok" | "lose" | "partial" };
  sources: Record<string, { status: string; bots: { id: string; name: string; role?: string; deletedAt?: number }[] }>;
  hostId: (seed: string) => string; render: () => void; setOnline: (value: boolean) => void; setActive: (value: boolean) => void;
  remount: () => void; touch: () => void; poll: () => void;
};
declare global { interface Window { grantFixture: Fixture } }

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const longSource = "负责跨地区项目资料整理与每周进展汇总的长名称来源助手";
async function openCross(page: Page, query = "") {
  await page.goto(`${base}?${query}`);
  const english = query.includes("lang=en");
  if (!query.includes("mount=section")) {
    await page.getByRole("button", { name: english ? "Bot message permissions" : "Bot 消息授权", exact: true }).click();
    await page.getByRole("button", { name: english ? "Cross-host" : "跨主机", exact: true }).click();
  }
  const panel = page.locator(".cross-host-message-grants");
  await expect(panel.locator(".message-grants-target").first()).toBeVisible();
  return panel;
}
const commands = (page: Page) => page.evaluate(() => window.grantFixture.commands);
const hostId = (page: Page, seed: string) => page.evaluate(value => window.grantFixture.hostId(value), seed);
const revision = (value: number) => value.toString(16).padStart(64, "0");
const pageState = async (page: Page) => JSON.parse(await page.getByTestId("page-state").textContent() ?? "{}") as { dirty: boolean; busy: boolean };
const box = (p: Locator, id: string) => p.locator(`.message-grants-target[data-bot-id="${id}"] input[type="checkbox"]`);
const options = (select: Locator) => select.locator("option").allTextContents();
const controls = (p: Locator) => ({
  host: p.getByLabel("发送方电脑", { exact: true }), source: p.getByLabel("发送方 Bot", { exact: true }),
  save: p.getByRole("button", { name: "保存授权", exact: true }), discard: p.getByRole("button", { name: "放弃修改", exact: true }),
});

test.describe("phone", () => {
  test.use(phone);

  test("native host and Bot selects sit above this host's checkbox list; existing grants start checked and nothing is a draft", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    const { host, source, save, discard } = controls(p);
    // The product chooser and its dialog are gone: one layer, as on the Local page.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await host.evaluate(node => node.tagName)).toBe("SELECT");
    expect(await source.evaluate(node => node.tagName)).toBe("SELECT");
    const [twinA, twinB] = [await hostId(page, "twin_a"), await hostId(page, "twin_b")];
    // Departed hosts can't receive new grants and are not offered.
    expect(await options(host)).toEqual(["演示来源主机", "实验室主机", `同名主机 · …${twinA.slice(-6)}`, `同名主机 · …${twinB.slice(-6)}`]);
    // Names come from the authenticated source directory; workers and deleted Bots stay out.
    expect(await options(source)).toEqual(["来源研究员", "资料助手 · …1f2e93", "资料助手 · …7a4b20", `${longSource} · 已授权 1 个`, "演示助手 001", "演示助手 002", "演示助手 003", "演示助手 004"]);
    await expect(source).toHaveValue("alpha");
    // Only this host's live Bots are listed, with its avatars and presence.
    await expect(p.locator(".message-grants-target strong")).toHaveText(["研究助手", "复核助手", "负责合同条款逐项核对与风险提示的长名称接收助手"]);
    await expect(p.locator(".message-grants-target .profile-avatar")).toHaveCount(3);
    await expect(p.locator(".message-grants-source .profile-avatar")).toHaveCount(0);
    await expect(p.locator('.message-grants-target[data-bot-id="alpha"]')).toContainText("当前在线");
    await expect(p.locator('.message-grants-target[data-bot-id="beta"]')).toContainText("当前离线");
    await expect(p.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await source.selectOption("long_name_bot");
    await expect(box(p, "beta")).toBeChecked();
    await expect(box(p, "alpha")).not.toBeChecked();
    await expect(p.getByText("已选择 1 个", { exact: true })).toBeVisible();
    // Choosing a source is navigation, not an edit.
    expect((await pageState(page)).dirty).toBe(false);
    await expect(p.getByText("有未保存的修改", { exact: true })).toHaveCount(0);
    await expect(save).toBeDisabled(); await expect(discard).toBeDisabled();
    const more = p.locator(".cross-grants-more > summary");
    for (const control of [host, source, more, ...await p.locator(".message-grants-target").all(), save, discard]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.height, await control.evaluate(node => node.outerHTML.slice(0, 60))).toBeGreaterThanOrEqual(44);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(await commands(page)).toEqual([]);
  });

  test("Bot settings never preselects or saves its Bot; it is only listed first", async ({ page }) => {
    const p = await openCross(page, "bot=gamma_long");
    await expect(p.locator(".message-grants-target").first()).toHaveAttribute("data-bot-id", "gamma_long");
    await expect(p.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(controls(p).save).toBeDisabled();
    await expect(page.getByRole("button", { name: "本机", exact: true })).toBeEnabled();
    expect(await commands(page)).toEqual([]);
  });
});

test("one save sends only the changed targets as one atomic batch and verifies every item", async ({ page }) => {
  const p = await openCross(page, "mount=section");
  const { host, source, save } = controls(p), studio = await hostId(page, "studio");
  await source.selectOption("long_name_bot");
  await box(p, "alpha").check(); await box(p, "gamma_long").check(); await box(p, "beta").uncheck();
  // Returning a box to the Host's value removes it from the change.
  await box(p, "gamma_long").uncheck();
  await box(p, "gamma_long").focus(); await page.keyboard.press("Space"); await page.keyboard.press("Space");
  await expect(box(p, "gamma_long")).not.toBeChecked();
  await expect(p.getByText("已选择 1 个", { exact: true })).toBeVisible();
  expect((await pageState(page)).dirty).toBe(true);
  await expect(p.getByText("有未保存的修改", { exact: true })).toBeVisible();
  await expect(p.locator(".message-grants-caution")).toBeVisible();
  // A draft is pinned to its source tuple.
  await expect(host).toBeDisabled(); await expect(source).toBeDisabled();
  await save.focus(); await page.keyboard.press("Enter");
  await expect(p.getByRole("status")).toHaveText("已保存授权，并从接收主机核对生效。");
  expect(await commands(page)).toEqual([{ operation: "cross-host-message-grants", sourceHost: studio, sourceBot: "long_name_bot", revision: revision(1),
    changes: [{ targetBot: "alpha", allowed: true }, { targetBot: "beta", allowed: false }] }]);
  await expect(p.getByRole("checkbox", { name: `允许 演示来源主机 · ${longSource} → 研究助手`, exact: true })).toBeChecked();
  await expect(box(p, "beta")).not.toBeChecked();
  expect((await pageState(page)).dirty).toBe(false);
  await expect(host).toBeEnabled(); await expect(source).toBeEnabled();
});

test("switching sources, searching and discarding never write; a draft locks every source control", async ({ page }) => {
  const p = await openCross(page, "mount=section&targets=6");
  const { host, source, discard } = controls(p);
  await host.selectOption({ label: "实验室主机" });
  // No connected directory and no records: an exact ID is the only way to name a source.
  await expect(source).toHaveCount(0);
  const exact = p.getByLabel("发送方 Bot ID", { exact: true });
  await expect(p.getByText("此设备尚未连接发送方电脑，或发送方电脑暂时离线。连接后可按名称选择；也可填写准确的 Bot ID。", { exact: true })).toBeVisible();
  await expect(box(p, "alpha")).toBeDisabled();
  await exact.fill("lab_bot");
  await expect(box(p, "alpha")).toBeEnabled();
  await expect(p.getByText("请核对发送方 Bot ID；这里不会自动验证它的名称或创建新 Bot。", { exact: true })).toBeVisible();
  expect((await pageState(page)).dirty).toBe(false);
  await host.selectOption({ label: "演示来源主机" });
  await expect(source).toHaveValue("alpha");
  const search = p.getByLabel("查找接收方 Bot", { exact: true });
  await search.fill("复核");
  await expect(p.locator(".message-grants-target")).toHaveCount(1);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(p.locator(".message-grants-target")).toHaveCount(9);
  await box(p, "alpha").check();
  expect((await pageState(page)).dirty).toBe(true);
  await expect(host).toBeDisabled(); await expect(source).toBeDisabled();
  await p.locator(".cross-grants-more > summary").click();
  await expect(p.getByRole("button", { name: "使用 Bot ID", exact: true })).toBeDisabled();
  await search.fill("研究");
  await expect(box(p, "alpha")).toBeChecked();
  await search.fill("");
  await discard.click();
  await expect(p.getByRole("status")).toHaveText("已重新载入主机当前权限。");
  await expect(box(p, "alpha")).not.toBeChecked();
  expect((await pageState(page)).dirty).toBe(false);
  await expect(host).toBeEnabled();
  // The secondary entry switches to an exact ID without creating a draft.
  await p.getByRole("button", { name: "使用 Bot ID", exact: true }).click();
  await expect(p.getByLabel("发送方 Bot ID", { exact: true })).toBeFocused();
  await p.getByRole("button", { name: "从列表选择 Bot", exact: true }).click();
  await expect(source).toHaveValue("alpha");
  expect((await pageState(page)).dirty).toBe(false);
  expect(await commands(page)).toEqual([]);
});

test("a lost receipt stays unconfirmed and a partial readback is never reported as saved; nothing is resent", async ({ page }) => {
  const p = await openCross(page, "mount=section");
  const { source, save } = controls(p);
  await source.selectOption("long_name_bot");
  await page.evaluate(() => { window.grantFixture.control.receipt = "lose"; });
  await box(p, "alpha").check(); await box(p, "beta").uncheck();
  await save.click();
  await expect(p.getByRole("alert")).toContainText("尚未确认保存结果");
  await expect(p.getByRole("status")).toHaveCount(0);
  expect((await pageState(page)).dirty).toBe(true);
  await expect(save).toBeDisabled(); await expect(box(p, "gamma_long")).toBeDisabled();
  // Neither a background read nor an explicit refresh is a write receipt.
  await page.evaluate(() => window.grantFixture.poll());
  await p.getByRole("button", { name: "刷新跨主机授权", exact: true }).click();
  await expect(p.getByRole("alert")).toContainText("尚未确认保存结果");
  expect(await commands(page)).toHaveLength(1);
  await page.evaluate(() => { window.grantFixture.control.receipt = "partial"; });
  await p.getByRole("button", { name: "重新载入并核对", exact: true }).click();
  await expect(p.getByRole("alert")).toHaveCount(0);
  await expect(box(p, "alpha")).toBeChecked(); await expect(box(p, "beta")).not.toBeChecked();
  expect((await pageState(page)).dirty).toBe(false);
  // Another writer reverts the batch's first change: the last one alone reads back.
  await box(p, "gamma_long").check(); await box(p, "alpha").uncheck();
  await save.click();
  await expect(p.getByRole("alert")).toHaveText("授权又发生了变化，请重新载入后核对。");
  await expect(p.getByRole("status")).toHaveCount(0);
  await expect(save).toBeDisabled();
  const sent = await commands(page);
  expect(sent).toHaveLength(2);
  expect(sent[1]!.changes).toEqual([{ targetBot: "gamma_long", allowed: true }, { targetBot: "alpha", allowed: false }]);
  await p.getByRole("button", { name: "重新载入并核对", exact: true }).click();
  await expect(p.getByRole("alert")).toHaveCount(0);
  await expect(box(p, "gamma_long")).not.toBeChecked(); await expect(box(p, "alpha")).not.toBeChecked();
  expect(await commands(page)).toHaveLength(2);
});

test("departed sources, deleted recipients and internal sources are revoke-only records outside the list", async ({ page }) => {
  const p = await openCross(page, "mount=section");
  const { host, source, discard } = controls(p), departed = await hostId(page, "departed");
  await page.evaluate(() => { const f = window.grantFixture; f.server.grants.push({ sourceHost: f.hostId("studio"), sourceBot: "worker_internal", targetBot: "alpha" }); f.touch(); f.poll(); });
  const section = p.locator(".cross-grants-unavailable");
  await expect(section.getByRole("heading", { name: "仅可撤销的授权", exact: true })).toBeVisible();
  await expect(section.locator(".cross-grants-edge")).toHaveCount(2);
  const worker = section.locator(".cross-grants-edge").filter({ hasText: "worker_internal" });
  await expect(worker).toContainText("来源为内部执行者，仅可撤销");
  expect((await options(source)).join()).not.toMatch(/worker_internal|内部执行者/);
  expect(await options(host)).not.toContain("已离网主机");
  await expect(p.locator('.message-grants-target[data-bot-id="retired"]')).toHaveCount(0);
  const edge = section.locator(".cross-grants-edge").filter({ hasText: "已离网主机" });
  await expect(edge).toContainText("发送方电脑当前不可用，仅可撤销");
  await expect(edge).toContainText("接收 Bot 已不可用，仅可撤销");
  const revoke = edge.getByRole("button", { name: "撤销 已离网主机 · legacy_bot → 演示接收主机 · 已删除助手", exact: true });
  // One transaction at a time: a list draft must be saved or discarded first.
  await box(p, "alpha").check();
  await expect(revoke).toBeDisabled();
  await discard.click();
  await expect(revoke).toBeEnabled();
  await revoke.click();
  await expect(p.getByRole("status")).toHaveText("已撤销授权，并从接收主机核对生效。");
  expect(await commands(page)).toEqual([{ operation: "cross-host-message-grants", sourceHost: departed, sourceBot: "legacy_bot", revision: revision(2), changes: [{ targetBot: "retired", allowed: false }] }]);
  await expect(section.locator(".cross-grants-edge")).toHaveCount(1);
});

test("the same Bot ID on another host is another endpoint, and directory changes guard a draft", async ({ page }) => {
  const p = await openCross(page, "mount=section");
  const { host, source, save } = controls(p);
  const [studio, twinA, twinB] = [await hostId(page, "studio"), await hostId(page, "twin_a"), await hostId(page, "twin_b")];
  await host.selectOption(twinA);
  expect(await options(source)).toEqual(["同名主机助手"]);
  await box(p, "alpha").check(); await save.click();
  await expect(p.getByRole("status")).toHaveText("已保存授权，并从接收主机核对生效。");
  expect(await commands(page)).toEqual([expect.objectContaining({ sourceHost: twinA, sourceBot: "twin_bot", changes: [{ targetBot: "alpha", allowed: true }] })]);
  // The other same-name host has no directory here; its twin_bot borrows nothing.
  await host.selectOption(twinB);
  await p.getByLabel("发送方 Bot ID", { exact: true }).fill("twin_bot");
  await expect(box(p, "alpha")).not.toBeChecked();
  await host.selectOption(studio);
  await expect(source).toHaveValue("alpha");
  await box(p, "beta").check();
  // The source becomes an internal worker under an open draft: no new grant.
  await page.evaluate(() => { const f = window.grantFixture; f.sources.studio!.bots[0]!.role = "worker"; f.render(); });
  await expect(p.getByRole("alert")).toHaveText("内部执行者不参与手动消息授权，请选择普通 Bot。");
  await expect(save).toBeDisabled();
  // It left the live directory instead: its records could be revoked, nothing granted.
  await page.evaluate(() => { const f = window.grantFixture; delete f.sources.studio!.bots[0]!.role; f.sources.studio!.bots.splice(0, 1); f.render(); });
  await expect(p.getByText("这个 Bot 不在发送方电脑当前列表中，只能撤销已有授权。", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(box(p, "beta")).toBeEnabled();
  // The whole directory went away: the existing exact-ID path applies.
  await page.evaluate(() => { const f = window.grantFixture; f.sources.studio!.status = "offline"; f.render(); });
  await expect(p.getByText("请核对发送方 Bot ID；这里不会自动验证它的名称或创建新 Bot。", { exact: true })).toBeVisible();
  await expect(source).toHaveValue("alpha");
  await save.click();
  await expect(p.getByRole("status")).toHaveText("已保存授权，并从接收主机核对生效。");
  expect((await commands(page))[1]).toEqual(expect.objectContaining({ sourceHost: studio, sourceBot: "alpha", changes: [{ targetBot: "beta", allowed: true }] }));
});

test("one batch is limited to 256 receiving Bots", async ({ page }) => {
  const p = await openCross(page, "mount=section&targets=300");
  const { save } = controls(p), search = p.getByLabel("查找接收方 Bot", { exact: true });
  const tick = (state: ":checked" | ":not(:checked)", limit = 1000) => p.locator(`.message-grants-target input${state}`).evaluateAll((nodes, max) => nodes.slice(0, max).forEach(node => (node as HTMLInputElement).click()), limit);
  for (const prefix of ["接收助手 0", "接收助手 1", "接收助手 2"]) { await search.fill(prefix); await tick(":not(:checked)"); }
  await expect(p.getByRole("alert")).toHaveText("一次最多修改 256 个接收方，请减少本次修改后保存。");
  await expect(save).toBeDisabled();
  await tick(":checked", 43);
  await expect(p.getByRole("alert")).toHaveCount(0);
  await save.click();
  await expect(p.getByRole("status")).toHaveText("已保存授权，并从接收主机核对生效。");
  const sent = await commands(page);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.changes).toHaveLength(256);
  expect(sent[0]!.changes.every(change => change.allowed)).toBe(true);
});

// Browser geometry only: ordinary phones and the desktop, in both languages.
const layouts = [
  { name: "phone-320", width: 320, height: 640, touch: true }, { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "desktop-1360", width: 1360, height: 900, touch: false },
];
const page_text = ".message-grants-source-title,.message-grants-target strong,.message-grants-target small,.message-grants-actions>button,.message-grants-hint,.message-grants-caution,.cross-grants-receiver,.cross-grants-more>summary,.cross-grants-more .text-button,.cross-grants-edge strong,.cross-grants-edge small,.cross-grants-edge>button";
for (const layout of layouts) for (const language of ["zh", "en"] as const) test(`layout ${layout.name} ${language}: selects, list, actions and revoke-only records fit`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, isMobile: layout.touch, hasTouch: layout.touch, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const p = await openCross(page, `mount=section&lang=${language}`);
    const words = language === "zh" ? { bot: "发送方 Bot", more: "说明与手动 Bot ID", save: "保存授权", discard: "放弃修改" } : { bot: "Sending Bot", more: "Details and manual Bot ID", save: "Save permissions", discard: "Discard changes" };
    await p.getByLabel(words.bot, { exact: true }).selectOption("long_name_bot");
    await box(p, "alpha").check();
    await p.getByText(words.more, { exact: true }).click();
    const clipped = await p.evaluate((node, query) => {
      const frame = node.getBoundingClientRect(), found: string[] = [];
      for (const element of node.querySelectorAll<HTMLElement>(query)) {
        if (!element.getClientRects().length) continue;
        const r = element.getBoundingClientRect();
        if (element.scrollWidth > element.clientWidth + 1 || r.left < frame.left - 1 || r.right > frame.right + 1) found.push(`${element.className || element.tagName}: ${element.textContent?.slice(0, 40)}`);
      }
      return found;
    }, page_text);
    expect(clipped).toEqual([]);
    await expect.poll(() => p.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    if (layout.touch) for (const control of [p.locator("select"), p.locator(".cross-grants-more > summary"), p.locator(".cross-grants-more .text-button"), p.getByRole("button", { name: words.save, exact: true }), p.getByRole("button", { name: words.discard, exact: true }), p.locator(".cross-grants-edge > button")]) {
      for (const one of await control.all()) {
        const bounds = (await one.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThanOrEqual(44);
      }
    }
    await page.screenshot({ path: info.outputPath(`${layout.name}-${language}.png`), fullPage: true, animations: "disabled" });
  } finally { await context.close(); }
});
