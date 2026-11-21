import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// No pairing or persisted CryptoKeys: this exercises the real browser clipboard
// and copy Worker, independently of native device enrollment and its keychain.
async function openProbe(page: Page) {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } });
  await server.listen();
  const blocks = [{ type: "text", text: "# 标题\n\n**重点** and `x_*#`" }];
  await page.route("**/copy-probe.html", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
    <!doctype html><html><head><meta charset="utf-8"></head><body><button id="copy">Copy</button><textarea id="paste"></textarea>
    <script type="module">
      import { copyMessagePlainText, messagePlainTextNow } from '/src/message-plain-text.ts';
      const blocks = ${JSON.stringify(blocks)};
      window.probe = { calls: [], before: messagePlainTextNow(blocks) };
      for (const method of ['write', 'writeText']) {
        const original = navigator.clipboard[method].bind(navigator.clipboard);
        navigator.clipboard[method] = (...args) => {
          window.probe.calls.push({ method, active: navigator.userActivation.isActive });
          return original(...args);
        };
      }
      document.querySelector('#copy').onclick = () => {
        window.probe.done = false;
        copyMessagePlainText(blocks).then(readable => {
          window.probe.readable = readable; window.probe.done = true;
        }, error => { window.probe.error = String(error); window.probe.done = true; });
      };
    </script></body></html>` }));
  await page.goto(server.resolvedUrls!.local[0] + "copy-probe.html");
  await page.waitForFunction(() => !!(window as any).probe);
  return server;
}

test("cold and cached readable copies use trusted browser clipboard writes and really paste", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const server = await openProbe(page);
  try {
    expect(await page.evaluate(() => (window as any).probe.before)).toBeUndefined();
    for (const method of ["write", "writeText"]) {
      await page.locator("#copy").click();
      await expect.poll(() => page.evaluate(() => (window as any).probe.done)).toBe(true);
      const state = await page.evaluate(() => (window as any).probe);
      expect(state.error).toBeUndefined(); expect(state.readable).toBe(true);
      expect(state.calls.at(-1)).toEqual({ method, active: true });
      await page.locator("#paste").fill(""); await page.locator("#paste").click();
      await page.keyboard.press("ControlOrMeta+V");
      await expect(page.locator("#paste")).toHaveValue("标题\n\n重点 and x_*#");
    }
  } finally { await page.close(); await server.close(); }
});

test("unavailable conversion returns an explicit original-text result without losing content", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error("fixture-worker-unavailable"); } } as any; });
  const server = await openProbe(page);
  try {
    await page.locator("#copy").click();
    await expect.poll(() => page.evaluate(() => (window as any).probe.done)).toBe(true);
    const state = await page.evaluate(() => (window as any).probe);
    expect(state.error).toBeUndefined(); expect(state.readable).toBe(false);
    await page.locator("#paste").click(); await page.keyboard.press("ControlOrMeta+V");
    await expect(page.locator("#paste")).toHaveValue("# 标题\n\n**重点** and `x_*#`");
  } finally { await page.close(); await server.close(); }
});

for (const nextCopy of ["message", "App", "native"] as const) test(`a delayed first copy cannot overwrite a newer ${nextCopy} copy`, async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", event => {
          if ((window as any).holdCopy && event.data.plain) {
            event.stopImmediatePropagation();
            (window as any).heldCopy = { worker: this, data: event.data };
          }
        });
      }
    };
  });
  const server = await openProbe(page);
  try {
    await page.evaluate(async nextCopy => {
      const moduleUrl = "/src/message-plain-text.ts";
      const { prepareMessagePlainText, copyMessagePlainText } = await import(moduleUrl);
      const clipboardUrl = "/src/clipboard-write.ts";
      const { writeClipboardText } = await import(clipboardUrl);
      const latest = [{ type: "text", text: "**Latest copy**" }];
      await prepareMessagePlainText(latest).text;
      (window as any).holdCopy = true;
      for (const [id, blocks] of [["first", [{ type: "text", text: "# Slow earlier copy" }]], ["last", latest]] as const) {
        const button = document.createElement("button"); button.id = id; button.textContent = id;
        button.onclick = () => (id === "last" && nextCopy === "App" ? writeClipboardText("Latest copy") : copyMessagePlainText(blocks)).then(
          () => { (window as any)[`${id}Done`] = true; },
          () => { (window as any)[`${id}Done`] = true; },
        );
        document.body.append(button);
      }
    }, nextCopy);
    await page.locator("#first").click();
    await expect.poll(() => page.evaluate(() => !!(window as any).heldCopy)).toBe(true);
    if (nextCopy === "native") {
      await page.locator("#paste").fill("Latest copy");
      await page.locator("#paste").selectText();
      await page.keyboard.press("ControlOrMeta+C");
      await page.locator("#paste").fill("");
    } else {
      await page.locator("#last").click();
      await expect.poll(() => page.evaluate(() => (window as any).lastDone)).toBe(true);
    }
    await page.evaluate(() => {
      (window as any).holdCopy = false;
      const held = (window as any).heldCopy;
      held.worker.dispatchEvent(new MessageEvent("message", { data: held.data }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).firstDone)).toBe(true);
    await page.locator("#paste").click(); await page.keyboard.press("ControlOrMeta+V");
    await expect(page.locator("#paste")).toHaveValue("Latest copy");
  } finally { await page.close(); await server.close(); }
});

for (const nextCopy of ["App", "native"] as const) test(`a rejected rich selection cannot replace a newer ${nextCopy} clipboard value`, async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const server = await openProbe(page);
  try {
    await page.evaluate(async () => {
      const selectionUrl = "/src/message-selection-clipboard.ts";
      const { writeMessageSelection } = await import(selectionUrl);
      const clipboardUrl = "/src/clipboard-write.ts";
      const { writeClipboardText } = await import(clipboardUrl);
      // Only the earlier rich write is delayed. The newer write and the final
      // paste use the browser's actual clipboard.
      navigator.clipboard.write = () => new Promise<void>((_, reject) => { (window as any).rejectRich = reject; });
      for (const id of ["rich", "latest"]) {
        const button = document.createElement("button"); button.id = id; button.textContent = id;
        button.onclick = () => (id === "rich"
          ? writeMessageSelection("Earlier selection", "<p>Earlier selection</p>")
          : writeClipboardText("Latest copy")).then(
          () => { (window as any)[`${id}Done`] = true; },
          () => { (window as any)[`${id}Done`] = true; },
        );
        document.body.append(button);
      }
    });
    await page.locator("#rich").click();
    await expect.poll(() => page.evaluate(() => !!(window as any).rejectRich)).toBe(true);
    if (nextCopy === "App") {
      await page.locator("#latest").click();
      await expect.poll(() => page.evaluate(() => (window as any).latestDone)).toBe(true);
    } else {
      await page.locator("#paste").fill("Latest copy");
      await page.locator("#paste").selectText();
      await page.keyboard.press("ControlOrMeta+C");
      await page.locator("#paste").fill("");
    }
    await page.evaluate(() => (window as any).rejectRich(new Error("HTML clipboard unavailable")));
    await expect.poll(() => page.evaluate(() => (window as any).richDone)).toBe(true);
    await page.locator("#paste").click(); await page.keyboard.press("ControlOrMeta+V");
    await expect(page.locator("#paste")).toHaveValue("Latest copy");
  } finally { await page.close(); await server.close(); }
});
