import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blocksText, type Block } from "../src/client-protocol/index.js";
import { markdownPlainText as plain } from "../client/src/markdown-plain-text.js";

describe("readable copy of Markdown keeps every literal character", () => {
  it("drops heading, emphasis and strike delimiters in Chinese and English prose", () => {
    expect(plain("# 中文与 English\n\n**重点**与 *emphasis* ~~旧~~ __粗__ _斜_")).toBe("中文与 English\n\n重点与 emphasis 旧 粗 斜");
    expect(plain("**结论：**Open Super Agent 很好。前文**“重点”**后文")).toBe("结论：Open Super Agent 很好。前文“重点”后文");
    expect(plain("标题一\n===\n正文\n\n### 小节 ###\n文字")).toBe("标题一\n正文\n\n小节\n文字");
  });
  it("leaves characters the message shows literally", () => {
    for (const text of [
      "2 * 3 * 4 = 24，a_b_c 与 snake_case_name",
      "C# 和 #1，--flag，-5 度，3 - 2 = 1",
      "价格 $10 到 $20",
      "*未闭合 与 **也未闭合",
      "[不是链接] 与 (括号) 与 ![不是图片]",
      "| 不是表格 | 只有一行 |",
      "1.5 倍、v1.5.1 与 2026-11-20",
      "行内 ~~~ 与 ``` 不是围栏",
      "行尾反斜杠 \\ 与 路径 C:\\tools\\name",
    ]) expect(plain(text), text).toBe(text);
  });
  it("decodes escapes and entities exactly as displayed, without re-reading them as Markdown", () => {
    expect(plain("\\*不是强调\\*，\\# 不是标题，\\[x\\]，\\`tick\\`")).toBe("*不是强调*，# 不是标题，[x]，`tick`");
    expect(plain("&amp; &lt;tag&gt; &copy; &#35; A&B &unknown;")).toBe("& <tag> © # A&B &unknown;");
    expect(plain("\\_\\_init\\_\\_.py")).toBe("__init__.py");
  });
  it("copies code spans and blocks verbatim", () => {
    expect(plain("行内 `a*b*c` 与 ``x ` y``，路径 `/usr/lib/__init__.py`、`C:\\tools\\a_b.md`、`src/**/*.ts`"))
      .toBe("行内 a*b*c 与 x ` y，路径 /usr/lib/__init__.py、C:\\tools\\a_b.md、src/**/*.ts");
    expect(plain("```text\n# literal **stars** _underscores_\n  keep indentation\n\n\tand tabs &amp; entities\n```"))
      .toBe("# literal **stars** _underscores_\n  keep indentation\n\n\tand tabs &amp; entities");
    expect(plain("前文\n\n    indented *code*\n      deeper\n\n~~~py\nprint('**x**')\n~~~")).toBe("前文\n\nindented *code*\n  deeper\n\nprint('**x**')");
    expect(plain("```js\nconst a = `${b}`;\n```")).not.toContain("```");
  });
  it("keeps a link's label and target, and writes a bare address once", () => {
    expect(plain("[说明](https://example.com/help?q=one_two#part)")).toBe("说明 (https://example.com/help?q=one_two#part)");
    expect(plain("[**粗** 标签](https://a.example/x \"title\")")).toBe("粗 标签 (https://a.example/x)");
    expect(plain("<https://a.example/x_y> https://b.example/c*d www.c.example mail@h.example <me@i.example>"))
      .toBe("https://a.example/x_y https://b.example/c*d www.c.example mail@h.example me@i.example");
    expect(plain("[https://e.example](https://e.example) [空]() [](https://f.example) [相对](./docs/a_b.md) [锚点](#part)"))
      .toBe("https://e.example 空 https://f.example 相对 (./docs/a_b.md) 锚点 (#part)");
    expect(plain("![图](https://g.example/i.png) ![](https://g.example/j.png)")).toBe("图 (https://g.example/i.png) https://g.example/j.png");
    // The renderer splits a bare address from following Chinese prose; the text is unchanged either way.
    expect(plain("See https://example.com/a。随后看 **中文**，以及 www.example.org，然后")).toBe("See https://example.com/a。随后看 中文，以及 www.example.org，然后");
  });
  it("resolves reference links and keeps a definition nothing else carries", () => {
    expect(plain("[文档][doc] 与 [doc] 与 ![图][pic]\n\n[doc]: https://example.com/a_b#part\n[pic]: https://example.com/p.png \"T\"\n[unused]: https://example.com/unused"))
      .toBe("文档 (https://example.com/a_b#part) 与 doc (https://example.com/a_b#part) 与 图 (https://example.com/p.png)\n\n[unused]: https://example.com/unused");
    expect(plain("[未定义][nope] 保持原样")).toBe("[未定义][nope] 保持原样");
  });
  it("numbers lists as rendered, with nesting, task state and the author's spacing", () => {
    expect(plain("3. 第三\n4. 第四\n   - 子项 **甲**\n   - 子项乙\n     1. 深层\n5. 第五")).toBe("3. 第三\n4. 第四\n   • 子项 甲\n   • 子项乙\n     1. 深层\n5. 第五");
    expect(plain("1. 一\n1. 二\n1. 三")).toBe("1. 一\n2. 二\n3. 三");
    expect(plain("9. 九\n10. 十\n    续行段落")).toBe("9. 九\n10. 十\n    续行段落");
    expect(plain("- [x] 完成\n- [ ] 未完成\n* 另一个列表")).toBe("• [x] 完成\n• [ ] 未完成\n• 另一个列表");
    expect(plain("* 松散一\n\n* 松散二\n\n  第二段\n\n      code in item")).toBe("• 松散一\n\n• 松散二\n\n  第二段\n\n  code in item");
    expect(plain("-\n- 空项之后")).toBe("•\n• 空项之后");
  });
  it("keeps table rows and columns without the delimiter row", () => {
    expect(plain("| 名称 | Value |\n| --- | --- |\n| 苹果 | 42 |")).toBe("名称\tValue\n苹果\t42");
    expect(plain("| a | b | c |\n|:--|:-:|--:|\n| `x_*#` | **粗** [l](https://t.example) | |\n| 1 \\| 2 | | 末 |")).toBe("a\tb\tc\nx_*#\t粗 l (https://t.example)\t\n1 | 2\t\t末");
  });
  it("keeps quotes, rule-separated sections, breaks and soft line breaks readable", () => {
    expect(plain("> 引用 **一**\n> 第二行\n>\n> - 列表\n\n---\n\n正文\n***\n结尾")).toBe("引用 一\n第二行\n\n• 列表\n\n正文\n\n结尾");
    expect(plain("第一行  \n第二行\\\n第三行\n软换行")).toBe("第一行\n第二行\n第三行\n软换行");
    expect(plain("\n\n  段落一\n\n\n\n段落二\n\n")).toBe("段落一\n\n段落二");
  });
  it("copies formula notation once and leaves currency alone", () => {
    expect(plain("行内 $x^2 + y_1$ 与块：\n\n$$\n\\frac{a}{b}\n$$\n\n```math\nE=mc^2\n```")).toBe("行内 x^2 + y_1 与块：\n\n\\frac{a}{b}\n\nE=mc^2");
    expect(plain("$10 ... $20 and $x+1$")).toBe("$10 ... $20 and x+1");
  });
  it("never drops raw HTML the renderer hides, nor footnotes", () => {
    expect(plain("用 <your-key> 替换，换行<br>后文 <!-- 注 -->")).toBe("用 <your-key> 替换，换行<br>后文 <!-- 注 -->");
    expect(plain("<details><summary>标题</summary>\n\n内容 **粗**\n\n</details>")).toBe("<details><summary>标题</summary>\n\n内容 粗\n\n</details>");
    expect(plain("正文[^1]。\n\n[^1]: 脚注 **内容**\n    第二行")).toBe("正文[1]。\n\n[1] 脚注 内容\n    第二行");
  });
  it("reads incomplete streaming Markdown without inventing or losing text", () => {
    expect(plain("## 标题\n\n**未完成的粗体\n\n```js\nconst a = 1;\n")).toBe("标题\n\n**未完成的粗体\n\nconst a = 1;");
    expect(plain("| a | b |\n| --- |")).toBe("| a | b |\n| --- |");
    expect(plain("见 [文档](https://exam")).toBe("见 [文档](https://exam");
    expect(plain("1. 第一\n2. ")).toBe("1. 第一\n2.");
    expect(plain("行内 `未闭合 code 与 $未闭合")).toBe("行内 `未闭合 code 与 $未闭合");
    expect(plain("")).toBe(""); expect(plain("   \n\n")).toBe("");
  });
  it("ignores a byte-order mark and keeps reference offsets aligned", () => {
    expect(plain("\ufeff# 标题\n\n[unused]: https://example.com/u")).toBe("标题\n\n[unused]: https://example.com/u");
  });
  it("converts a long document completely and refuses one beyond the renderer's limit", () => {
    const section = "## 第 N 节\n\n**要点** 与 `code_*` 和 [链](https://l.example/a_b)\n\n- 项 *一*\n- 项二\n\n";
    const text = plain(section.repeat(2000));
    expect(text.split("要点 与 code_* 和 链 (https://l.example/a_b)").length - 1).toBe(2000);
    expect(text.split("• 项 一\n• 项二").length - 1).toBe(2000);
    expect(text).not.toMatch(/\*\*|##|`/);
    expect(() => plain("a".repeat(1024 * 1024 + 1))).toThrow("markdown_too_large");
  });
});

const fixture: Block[] = [
  { type: "text", text: "# 标题\n\n**正文** `code_*`" },
  { type: "steering", botId: "bot", targetId: "target", outcome: "accepted" },
  { type: "image", attachmentId: "image1", title: "**图**_标题_.png" },
  { type: "image", attachmentId: "image2" },
  { type: "file", attachmentId: "file1", name: "**a**_b_.md", size: 3, mime: "text/markdown" },
  { type: "audio", attachmentId: "audio1", name: "*语音*.m4a" },
  { type: "card", title: "**卡片** #标题", summary: "*摘要*", elements: [
    { type: "markdown", text: "- 项 **一**\n- 项二" },
    { type: "collapsible", text: "**详情** `x`", children: [{ type: "markdown", text: "> 引用 *内*" }, { type: "button", text: "**内层按钮**" }] },
    { type: "collapsible", children: [{ type: "markdown", text: "无标题折叠 ~~内~~" }] },
    { type: "button", text: "**按钮** _原样_", actionId: "go" },
    { type: "buttonGroup", children: [{ type: "button", text: "# 一" }, { type: "button", text: "- 二" }] },
    { type: "input", text: "输入 *标签*", name: "note" },
    { type: "select", text: "选择 **项**", name: "choice", options: [{ label: "**甲**", value: "a" }, { label: "_乙_", value: "b" }] },
    { type: "form", children: [{ type: "markdown", text: "表单 **说明**" }, { type: "input", text: "`字段`" }] },
    { type: "columns", children: [{ type: "column", children: [{ type: "markdown", text: "列 *一*" }] }, { type: "column", text: "列 **字面**" }] },
    { type: "divider" }, { type: "icon", text: "*loading*" }, { type: "image", attachmentId: "image3", text: "**卡片图**" },
    { type: "markdown", text: "   " }, { type: "markdown" },
  ] },
  { type: "card", extra: { promptQueue: { state: "queued" } }, elements: [{ type: "markdown", text: "**排队提示**" }] },
  { type: "run", phase: "**阶段**", elapsedMs: 1, tools: [], todos: [] },
  { type: "usage", model: "**model**" },
  { type: "text", text: "" },
];
const readable = [
  "标题\n\n正文 code_*", "**图**_标题_.png", "[image]", "**a**_b_.md", "",
  ["**卡片** #标题", "• 项 一\n• 项二", "详情 x\n引用 内\n**内层按钮**", "无标题折叠 内", "**按钮** _原样_", "# 一\n- 二", "输入 *标签*",
    "选择 **项**\n1. **甲**\n2. _乙_", "表单 说明\n`字段`", "列 一\n列 **字面**", "*loading*", "**卡片图**", "   "].join("\n"),
  "", "", "",
].join("\n");

type Reply = { id: number; plain: string[] } | { id: number; error: true };
/** A Worker double running the real conversion, with controllable delivery. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static construct: () => void = () => undefined;
  static respond: (worker: FakeWorker, request: { id: number; plain: string[] }) => void = (worker, request) => worker.reply({ id: request.id, plain: request.plain.map(plain) });
  onmessage: ((event: { data: Reply }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: { id: number; plain: string[] }[] = []; terminated = false;
  constructor() { FakeWorker.construct(); FakeWorker.instances.push(this); }
  postMessage(request: { id: number; plain: string[] }) { this.requests.push(request); queueMicrotask(() => FakeWorker.respond(this, request)); }
  reply(data: Reply) { if (!this.terminated) this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}
async function load() { vi.resetModules(); return import("../client/src/message-plain-text.js"); }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("readable copy of a whole message", () => {
  let writeText = vi.fn(async (_text: string): Promise<void> => undefined), write = vi.fn(async (_items: unknown[]): Promise<void> => undefined);
  beforeEach(() => {
    FakeWorker.instances = []; FakeWorker.construct = () => undefined;
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain.map(plain) });
    writeText = vi.fn(async (_text: string): Promise<void> => undefined); write = vi.fn(async (_items: unknown[]): Promise<void> => undefined);
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("converts only the fields the renderer shows as Markdown and keeps blocksText's structure", async () => {
    const { prepareMessagePlainText, messagePlainTextNow } = await load();
    expect(messagePlainTextNow(fixture)).toBeUndefined();
    expect(await prepareMessagePlainText(fixture).text).toBe(readable);
    expect(messagePlainTextNow(fixture)).toBe(readable);
    // One request carrying each distinct Markdown field once, in message order.
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.requests.map(request => request.plain)).toEqual([[
      "# 标题\n\n**正文** `code_*`", "- 项 **一**\n- 项二", "**详情** `x`", "> 引用 *内*", "无标题折叠 ~~内~~", "表单 **说明**", "列 *一*", "**排队提示**",
    ]]);
    // The stored blocks are never modified.
    expect(fixture[0]).toEqual({ type: "text", text: "# 标题\n\n**正文** `code_*`" });
  });
  it("is exactly blocksText when conversion changes nothing", async () => {
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain });
    const { prepareMessagePlainText } = await load();
    expect(await prepareMessagePlainText(fixture).text).toBe(blocksText(fixture));
    const attachments: Block[] = [{ type: "file", attachmentId: "f", name: "# **报告**_v1_.md", size: 1, mime: "text/markdown" }, { type: "image", attachmentId: "i", title: "- [x] 图.png" }];
    // Nothing to convert: no Worker is started and names stay literal.
    const { messagePlainTextNow } = await load();
    expect(messagePlainTextNow(attachments)).toBe("# **报告**_v1_.md\n- [x] 图.png");
    expect(FakeWorker.instances).toHaveLength(1);
  });
  it("writes prepared text synchronously inside the tap", async () => {
    const { prepareMessagePlainText, copyMessagePlainText } = await load();
    await prepareMessagePlainText(fixture).text;
    const copied = copyMessagePlainText(fixture);
    expect(writeText).toHaveBeenCalledTimes(1); expect(writeText).toHaveBeenCalledWith(readable);
    expect(await copied).toBe(true);
    expect(FakeWorker.instances[0]!.requests).toHaveLength(1);
  });
  it("starts a promised clipboard item inside the tap when the text is not ready", async () => {
    class Item { constructor(readonly data: Record<string, Promise<Blob>>) {} }
    vi.stubGlobal("ClipboardItem", Item); vi.stubGlobal("navigator", { clipboard: { writeText, write } });
    const { copyMessagePlainText } = await load();
    const copied = copyMessagePlainText(fixture);
    expect(write).toHaveBeenCalledTimes(1); expect(writeText).not.toHaveBeenCalled();
    const item = write.mock.calls[0]![0][0] as Item, blob = await item.data["text/plain"]!;
    expect(blob.type).toBe("text/plain"); expect(await blob.text()).toBe(readable);
    expect(await copied).toBe(true);
  });
  it("falls back to a later text write without promised items, and reports a refusal", async () => {
    const { copyMessagePlainText } = await load();
    const copied = copyMessagePlainText(fixture);
    expect(writeText).not.toHaveBeenCalled();
    expect(await copied).toBe(true); expect(writeText).toHaveBeenCalledWith(readable);

    class Unsupported { constructor() { throw new TypeError("promise data"); } }
    vi.stubGlobal("ClipboardItem", Unsupported); vi.stubGlobal("navigator", { clipboard: { writeText, write } });
    const second = await load(); writeText.mockClear();
    expect(await second.copyMessagePlainText(fixture)).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(writeText).toHaveBeenCalledWith(readable);

    class Item { constructor(readonly data: unknown) {} }
    vi.stubGlobal("ClipboardItem", Item);
    write.mockRejectedValue(new Error("unsupported")); writeText.mockClear();
    const third = await load();
    await expect(third.copyMessagePlainText(fixture)).rejects.toThrow("unsupported");
    await settle(); expect(writeText).not.toHaveBeenCalled();
    vi.stubGlobal("ClipboardItem", undefined);
    writeText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const fourth = await load();
    await expect(fourth.copyMessagePlainText(fixture)).rejects.toThrow("denied");
    // The prepared path reports the same refusal; a missing clipboard rejects instead of throwing.
    await expect(fourth.copyMessagePlainText(fixture)).rejects.toThrow("denied");
    vi.stubGlobal("navigator", {});
    await expect(fourth.copyMessagePlainText(fixture)).rejects.toBeInstanceOf(TypeError);
  });
  it.each([false, true])("does not deliver a superseded conversion (promised item: %s)", async promised => {
    class Item { constructor(readonly data: Record<string, Promise<Blob>>) {} }
    if (promised) {
      vi.stubGlobal("ClipboardItem", Item);
      write.mockImplementation(async items => { await (items[0] as Item).data["text/plain"]; });
      vi.stubGlobal("navigator", { clipboard: { writeText, write } });
    }
    const { prepareMessagePlainText, copyMessagePlainText } = await load();
    const newer: Block[] = [{ type: "text", text: "**Newer**" }];
    await prepareMessagePlainText(newer).text;
    let release!: () => void;
    FakeWorker.respond = (worker, request) => { release = () => worker.reply({ id: request.id, plain: request.plain.map(plain) }); };
    const oldCopy = copyMessagePlainText(fixture);
    const refused = expect(oldCopy).rejects.toMatchObject({ name: "MessageCopySuperseded" });
    await settle();
    expect(await copyMessagePlainText(newer)).toBe(true);
    release(); await refused;
    expect(writeText.mock.calls).toEqual([["Newer"]]);
  });
  it.each(["text", "items", "copy", "cut"])("a newer %s copy cancels pending message conversion without changing that copy", async kind => {
    const events = new EventTarget();
    vi.stubGlobal("document", events);
    const remove = vi.spyOn(events, "removeEventListener");
    vi.stubGlobal("navigator", { clipboard: { writeText, write } });
    const { copyMessagePlainText } = await load();
    const { writeClipboard, writeClipboardText } = await import("../client/src/clipboard-write.js");
    let release!: () => void;
    FakeWorker.respond = (worker, request) => { release = () => worker.reply({ id: request.id, plain: request.plain.map(plain) }); };
    const copied = copyMessagePlainText(fixture);
    const refused = expect(copied).rejects.toMatchObject({ name: "MessageCopySuperseded" });
    await settle();
    if (kind === "text") await writeClipboardText("Code **literal**");
    else if (kind === "items") {
      const items = [{} as ClipboardItem]; await writeClipboard(items);
      expect(write).toHaveBeenCalledWith(items);
    } else {
      const event = new Event(kind, { cancelable: true }); events.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    release(); await refused;
    expect(writeText.mock.calls).toEqual(kind === "text" ? [["Code **literal**"]] : []);
    expect(remove).toHaveBeenCalledWith("copy", expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith("cut", expect.any(Function), true);
  });
  it("copies the complete original text and says so when conversion is unavailable, then retries", async () => {
    FakeWorker.construct = () => { throw new Error("blocked"); };
    const { copyMessagePlainText, prepareMessagePlainText, messagePlainTextNow } = await load();
    expect(await copyMessagePlainText(fixture)).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1); expect(writeText).toHaveBeenCalledWith(blocksText(fixture));
    expect(messagePlainTextNow(fixture)).toBeUndefined();
    // A rejected document leaves the Worker running; a crash replaces it.
    FakeWorker.construct = () => undefined;
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, error: true });
    expect(await prepareMessagePlainText(fixture).text).toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(1); expect(FakeWorker.instances[0]!.terminated).toBe(false);
    FakeWorker.respond = worker => worker.onerror?.({ preventDefault: () => undefined });
    expect(await prepareMessagePlainText(fixture).text).toBeUndefined();
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain.slice(1) });
    expect(await prepareMessagePlainText(fixture).text).toBeUndefined();
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain.map(plain) });
    expect(await prepareMessagePlainText(fixture).text).toBe(readable);
    expect(FakeWorker.instances).toHaveLength(2);
  });
  it("keeps one very long message ready for the synchronous tap within a bounded cache", async () => {
    // The cache is sized in characters, so an echoing Worker exercises it without a long parse.
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain.map(text => text.toUpperCase()) });
    const { prepareMessagePlainText, messagePlainTextNow, copyMessagePlainText } = await load();
    const long: Block[] = [{ type: "text", text: "long message ".repeat(30_000) }];
    const text = await prepareMessagePlainText(long).text;
    expect(text).toBe("LONG MESSAGE ".repeat(30_000));
    expect(messagePlainTextNow(long)).toBe(text);
    const copied = copyMessagePlainText(long);
    expect(writeText).toHaveBeenCalledWith(text); expect(await copied).toBe(true);
    // Newer messages displace it; it is converted again on demand, never served stale.
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain.map(plain) });
    expect(await prepareMessagePlainText(fixture).text).toBe(readable);
    expect(messagePlainTextNow(fixture)).toBe(readable); expect(messagePlainTextNow(long)).toBeUndefined();
  });
  it("bounds a stalled conversion and releases an idle Worker", async () => {
    vi.useFakeTimers();
    FakeWorker.respond = () => undefined;
    const { copyMessagePlainText, prepareMessagePlainText } = await load();
    const copied = copyMessagePlainText(fixture);
    await vi.advanceTimersByTimeAsync(9_999); expect(writeText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await copied).toBe(false); expect(writeText).toHaveBeenCalledWith(blocksText(fixture));
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    FakeWorker.respond = (worker, request) => worker.reply({ id: request.id, plain: request.plain.map(plain) });
    expect(await prepareMessagePlainText(fixture).text).toBe(readable);
    expect(FakeWorker.instances[1]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWorker.instances[1]!.terminated).toBe(true);
  });
  it("runs one conversion at a time, answers a repeat from the first and withdraws a cancelled one", async () => {
    const held: (() => void)[] = [];
    FakeWorker.respond = (worker, request) => { held.push(() => worker.reply({ id: request.id, plain: request.plain.map(plain) })); };
    const { prepareMessagePlainText, copyMessagePlainText } = await load();
    const earlier: Block[] = [{ type: "text", text: "**流式** 第一版" }], latest: Block[] = [{ type: "text", text: "**流式** 第一版，第二版" }];
    const sheet = prepareMessagePlainText(fixture), superseded = prepareMessagePlainText(earlier);
    const tap = copyMessagePlainText(fixture), current = prepareMessagePlainText(latest);
    await settle();
    expect(FakeWorker.instances[0]!.requests).toHaveLength(1);
    superseded.cancel();
    expect(await superseded.text).toBeUndefined();
    held.shift()!();
    expect(await sheet.text).toBe(readable); expect(await tap).toBe(true); expect(writeText).toHaveBeenCalledWith(readable);
    await settle();
    // The tap reused the sheet's result; the cancelled revision never reached the Worker.
    expect(FakeWorker.instances[0]!.requests.map(request => request.plain)).toEqual([expect.any(Array), ["**流式** 第一版，第二版"]]);
    held.shift()!();
    expect(await current.text).toBe("流式 第一版，第二版");
    // A reply for a conversion that is no longer current is ignored.
    FakeWorker.instances[0]!.reply({ id: 1, plain: ["stale"] });
    expect(await prepareMessagePlainText(latest).text).toBe("流式 第一版，第二版");
  });
});
