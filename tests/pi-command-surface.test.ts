import { describe, expect, it } from "vitest";
import { gatewayCommands, renderGatewayHelp } from "../src/gateway/commands.js";
import { isPiLiveCommand, isPiSessionCommand, piSessionCommands } from "../src/client-protocol/pi-commands.js";

// Pi 1.5.2's public completion list (core/slash-commands.ts). Hidden debug and
// novelty commands are deliberately not promoted into the ordinary picker.
const nativeCommands = ["settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit"];

describe("Pi commands exposed in the App", () => {
  it("respects the actual App parser's aliases, casing and recipient suffix", () => {
    const names = ["HELP", "help@fixture", "APPROVAL", "approval", "queue@fixture", "review/nested", "review\\nested"];
    const commands = piSessionCommands(names.map(name => ({ name, source: "extension" })));
    for (const name of names) {
      expect(isPiSessionCommand(name), name).toBe(false);
      expect(isPiLiveCommand(`/${name} check`, commands), name).toBe(false);
    }
    expect(commands.map(command => command.name)).not.toContain("review/nested");
    expect(commands.map(command => command.name)).not.toContain("review\\nested");
    expect(isPiSessionCommand("review:2")).toBe(true);
  });
  it("offers only current session commands and never shadows App or terminal controls", () => {
    const commands = piSessionCommands([
      { name: "review:2", source: "extension", description: "Review\nnow", filePath: "PRIVATE_SOURCE" },
      { name: "skill:lab", source: "skill" }, { name: "template", source: "prompt" },
      ...["stop", "q", "new", "help", "queue", "tasks", "side", "reset"].map(name => ({ name, source: "extension" })),
      { name: "bad name", source: "extension" }, { name: "/bad", source: "extension" }, { name: "bad\0name", source: "extension" },
      { name: "review:2", source: "skill", description: "duplicate" },
    ]);
    expect(commands[0]).toEqual({ name: "review:2", source: "extension", description: "Review now" });
    expect(JSON.stringify(commands)).not.toContain("PRIVATE_SOURCE");
    expect(commands.filter(command => command.name === "review:2")).toHaveLength(1);
    expect(isPiLiveCommand("/review:2 arguments", commands)).toBe(false);
    for (const name of ["skill:lab", "template"]) expect(isPiLiveCommand(`/${name} arguments`, commands)).toBe(true);
    for (const name of ["missing", "stop", "q", "new", "help", "queue", "tasks", "side", "reset", "bad name", "bad"]) expect(isPiLiveCommand(`/${name} arguments`, commands)).toBe(false);
  });
  it("routes only known live native commands, preserving Pi's literal-space parsing", () => {
    for (const text of ["/model", " /model provider/model ", "/thinking high", "/name Review", "/session", "/copy", "/settings"]) expect(isPiLiveCommand(text)).toBe(true);
    for (const text of ["/help", "/stop", "/reset", "/new", "/resume", "/model\nprovider/model", "/model\tprovider/model", "/MODEL provider/model", "/model-extra", "//model", "ordinary text"]) expect(isPiLiveCommand(text)).toBe(false);
  });
  it("lists all public native commands once, including the ones absent from the shared registry", () => {
    const commands = gatewayCommands("pi").map(item => item.command);
    expect(commands).toEqual(expect.arrayContaining(nativeCommands));
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).not.toContain("debug");
    expect(commands).not.toContain("arminsayshi");
    expect(gatewayCommands("pi", "/THINK").map(item => item.command)).toEqual(["thinking"]);
  });

  it("explains the Pi conversation scope and terminal-only authentication in both languages", () => {
    const definitions = new Map(gatewayCommands("pi").map(item => [item.command, item.description]));
    expect(definitions.get("model")?.defaultValue).toContain("conversation");
    expect(definitions.get("model")?.i18n.zh_cn).toContain("当前对话");
    expect(definitions.get("login")?.defaultValue).toContain("terminal");
    expect(definitions.get("login")?.i18n.zh_cn).toContain("终端");
    for (const locale of ["en", "zh"] as const) {
      const help = renderGatewayHelp("pi", locale);
      expect(help).toContain("`/thinking`");
      expect(help).toContain("`/tree`");
      expect(help).toContain("`/session`");
    }
  });

  it.each(["codex", "claude", "antigravity", "kimi", "deepseek"])("does not add Pi-only commands to %s", engine => {
    const commands = gatewayCommands(engine).map(item => item.command);
    for (const command of ["thinking", "scoped-models", "clone", "trust", "login", "logout", "new", "quit"]) expect(commands).not.toContain(command);
  });
});
