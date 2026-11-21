import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
for (const width of [390, 1360]) test(`Pi native editor preserves prefill, whitespace and an explicitly empty answer · ${width}`, async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-question-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"), decisions: unknown[] = [];
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_fixture','Pi',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_fixture", secret, engine: "pi", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => {
    decisions.push(await input.onApprovalRequest?.({ engine: "pi", toolName: "AskUserQuestion", toolInput: { questions: [
      { question: "编辑 Pi 扩展内容", header: "Pi 编辑器", options: [], allowFreeText: true, required: false, input: { kind: "multiline", placeholder: "原生扩展提示", prefill: "  原始内容\n第二行  " } },
    ] } })); return { text: "编辑已确认" };
  } } });
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    await hub.store.createConversation("owner", ["pi_fixture"], "Pi 扩展问答", "pi_questions");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await selectConversation(page, "Pi 扩展问答");
    for (const [index, value] of ["  修改\n保留缩进  ", ""].entries()) {
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(`编辑 ${index}`); await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const input = page.locator('textarea[name="q0_other"]').filter({ visible: true });
      await expect(input).toHaveValue("  原始内容\n第二行  "); await expect(input).toHaveAttribute("placeholder", "原生扩展提示");
      await input.fill(value);
      await page.getByRole("button", { name: "提交", exact: true }).filter({ visible: true }).click();
      await expect.poll(() => decisions.length).toBe(index + 1);
      expect(decisions[index]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "编辑 Pi 扩展内容": value } } });
      await expect(input).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
