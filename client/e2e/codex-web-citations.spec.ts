import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { cleanCardText } from "../../src/core/card-renderer.js";
import { addCodexWebSources } from "../../src/runtime/codex-web-citations.js";

for (const width of [390, 1360]) for (const locale of ["en", "zh"] as const) {
  test(`Codex search citations render safe links at ${width} in ${locale}`, async ({ page }, info) => {
    const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } });
    await server.listen();
    try {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/markdown.html");
      await page.addStyleTag({ content: "#root{padding:20px;max-width:900px}.markdown{font-size:16px;line-height:1.8}" });
      const sources = addCodexWebSources(undefined, [{ refId: "turn2search5", url: "https://example.test/source?a=1&b=2", title: "Example source" }]);
      const set = async (text: string, streaming = false) => page.evaluate(text => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), cleanCardText(text, locale, { sources, streaming }));
      await set("Evidence ci", true);
      await expect(page.locator(".markdown")).toHaveText("Evidence");
      await set("Evidence citeturn2search5", true);
      const link = page.getByRole("link", { name: "example.test" });
      await expect(link).toHaveAttribute("href", "https://example.test/source?a=1&b=2");
      await expect(page.locator(".markdown")).not.toContainText("turn2search5");
      await set("Evidence citeturn2search5\n\nUnmapped citeturn8search0\n\n```text\nciteturn2search5\n```");
      await expect(page.locator(".markdown a")).toHaveCount(1);
      await expect(page.locator(".markdown")).toContainText(locale === "en" ? "Source link unavailable" : "来源链接未提供");
      await expect(page.locator(".markdown pre code")).toContainText("citeturn2search5");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`citation-${locale}-${width}.png`) });
      const table = cleanCardText("| Evidence | Result |\n|---|---|\n| citepipe | OK |", locale, { sources: addCodexWebSources(undefined, [{ refId: "pipe", url: "https://example.test/a|b?q=1|2" }]) });
      await page.evaluate(text => (window as unknown as { setMarkdown(text: string): void }).setMarkdown(text), table);
      await expect(page.locator("tbody tr td")).toHaveCount(2);
      await expect(page.locator("tbody a")).toHaveAttribute("href", "https://example.test/a%7Cb?q=1%7C2");
    } finally { await page.close(); await server.close(); }
  });
}

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { renderCodexWebCitations } from "../../src/runtime/codex-web-citations.js";

test("App answer and process prose hide native controls while raw step copy keeps evidence", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "citation-app-"));
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  let gateway: Awaited<ReturnType<typeof attachGateway>> | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('citation-bot','Citation Bot',?,'codex')", [hashSecret(secret)]);
    await hub.store.createConversation("owner", ["citation-bot"], "引用验收", "direct");
    const raw = "Evidence citeturn2search5";
    const source = { refId: "turn2search5", url: "https://example.test/source", title: "Untrusted label" };
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "citation-bot", engine: "codex", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async input => {
        await input.onEngineEvent?.({ type: "tool_result", toolName: "WebSearch", toolUseId: "search-1", sources: [source] });
        await input.onEngineEvent?.({ type: "assistant_text", text: raw, delta: true });
        return { text: renderCodexWebCitations(raw, "zh", { sources: addCodexWebSources(undefined, [source]), preserveUnresolved: true }) };
      },
    } });
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("Verify citations");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".native-run-status")).toContainText("已完成");
    await expect(page.locator(".native-run-prose").getByRole("link", { name: "example.test" })).toHaveAttribute("href", source.url);
    await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const step = page.locator(".run-step").filter({ hasText: "Bot 说明" });
    await step.locator("summary").first().click();
    await expect(step.locator(".card-text")).toContainText("来源链接未提供");
    await expect(step.locator(".card-text")).not.toContainText("");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedStep = text; } } }));
    await step.getByRole("button", { name: "复制此步骤" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copiedStep)).toContain(raw);
  } finally { await page.close(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
