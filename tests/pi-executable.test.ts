import { beforeEach, describe, expect, it, vi } from "vitest";
const available = new Set<string>();
vi.mock("../src/runtime/engine-process.js", () => ({ resolveEngineExecutable: vi.fn((command: string) => available.has(command) ? command : undefined) }));
import { resolvePiExecutable } from "../src/runtime/pi-executable.js";

describe("shared Pi executable discovery", () => {
  beforeEach(() => available.clear());
  it("keeps explicit paths fail closed and ahead of installed alternatives", () => {
    available.add("pi");
    expect(resolvePiExecutable({ PI_EXECUTABLE: '"C:\\missing folder\\pi.cmd"' }, "win32")).toBe("C:\\missing folder\\pi.cmd");
  });
  it("preserves the existing PATH selection", () => {
    available.add("pi"); available.add("C:\\Users\\Example\\.pi\\agent\\bin\\pi.cmd");
    expect(resolvePiExecutable({ USERPROFILE: "C:\\Users\\Example" }, "win32")).toBe("pi");
  });
  it("discovers the official managed Windows installer and keeps npm precedence", () => {
    const env = { USERPROFILE: "C:\\Users\\Example", APPDATA: "C:\\Users\\Example\\AppData\\Roaming" };
    const managed = "C:\\Users\\Example\\.pi\\agent\\bin\\pi.cmd", npm = "C:\\Users\\Example\\AppData\\Roaming\\npm\\pi.cmd";
    available.add(managed); expect(resolvePiExecutable(env, "win32")).toBe(managed);
    available.add(npm); expect(resolvePiExecutable(env, "win32")).toBe(npm);
  });
  it("uses native agent-directory override without scanning unrelated folders", () => {
    available.add("/opt/pi-state/bin/pi");
    expect(resolvePiExecutable({ HOME: "/home/example", PI_CODING_AGENT_DIR: "/opt/pi-state" }, "linux")).toBe("/opt/pi-state/bin/pi");
    expect(resolvePiExecutable({ HOME: "/home/example", PI_CODING_AGENT_DIR: "relative" }, "darwin")).toBe("pi");
  });
  it("ignores missing files and invalid Windows roots", () => {
    expect(resolvePiExecutable({ USERPROFILE: "\\relative", APPDATA: "bad\npath" }, "win32")).toBe("pi");
    expect(resolvePiExecutable({}, "darwin")).toBe("pi");
  });
});
