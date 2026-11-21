import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("selection clipboard fallback ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("ClipboardItem", class { constructor(readonly data: unknown) {} });
    vi.stubGlobal("document", new EventTarget());
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["App", "copy", "cut"])("does not overwrite a newer %s copy when an earlier rich write rejects", async next => {
    let reject!: (error: Error) => void;
    const write = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    const { writeMessageSelection } = await import("../client/src/message-selection-clipboard.js");
    const { writeClipboardText } = await import("../client/src/clipboard-write.js");
    const earlier = writeMessageSelection("Older selection", "<p>Older selection</p>").catch(error => error);
    expect(write).toHaveBeenCalledTimes(1);
    if (next === "App") await writeClipboardText("Latest copy");
    else document.dispatchEvent(new Event(next));
    reject(new Error("rich clipboard rejected"));
    await earlier;
    expect(writeText.mock.calls).toEqual(next === "App" ? [["Latest copy"]] : []);
  });

  it("retains the plain-text fallback when the same copy still owns the clipboard", async () => {
    const write = vi.fn(async () => { throw new Error("HTML unsupported"); });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    const { writeMessageSelection } = await import("../client/src/message-selection-clipboard.js");
    await writeMessageSelection("Selected text", "<p>Selected text</p>");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Selected text");
  });
});
