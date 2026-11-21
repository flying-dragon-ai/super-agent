// Key mapping and shortcuts take the controlled (target) platform (#48/#49 P1).
// macOS, the default and the only target today, must map exactly as before.
import { expect, it } from "vitest";
import { screenDesktopSchema } from "../src/client-protocol/remote-screen.js";
import { SCREEN_MAC_KEYCODES, SCREEN_SHORTCUTS, SCREEN_TARGET_PLATFORMS, screenControllerCode, screenShortcuts, type ScreenTargetPlatform } from "../src/client-protocol/screen-keys.js";

// The controller mapping before the target seam, kept here as the oracle.
const SWAP: Record<string, string> = { ControlLeft: "MetaLeft", ControlRight: "MetaRight", MetaLeft: "ControlLeft", MetaRight: "ControlRight" };
const before = (code: string, controller: "mac" | "windows", mode: "command" | "physical" = "command") => controller === "windows" && mode === "command" ? SWAP[code] ?? code : code;

it("a macOS target, explicit or by default, maps every controller key exactly as before", () => {
  for (const code of [...Object.keys(SCREEN_MAC_KEYCODES), "Unidentified"]) for (const controller of ["mac", "windows"] as const) {
    expect(screenControllerCode(code, controller)).toBe(before(code, controller));
    for (const mode of ["command", "physical"] as const) {
      expect(screenControllerCode(code, controller, mode)).toBe(before(code, controller, mode));
      expect(screenControllerCode(code, controller, mode, "macos")).toBe(before(code, controller, mode));
    }
  }
});

it("the shortcut list for a macOS target is the existing Mac list", () => {
  expect(screenShortcuts()).toBe(SCREEN_SHORTCUTS);
  expect(screenShortcuts("macos")).toBe(SCREEN_SHORTCUTS);
  expect(SCREEN_SHORTCUTS.map(shortcut => [shortcut.id, shortcut.codes.join("+")])).toEqual([
    ["escape", "Escape"], ["app-switcher", "MetaLeft+Tab"], ["spotlight", "MetaLeft+Space"], ["input-source", "ControlLeft+Space"],
    ["force-quit", "MetaLeft+AltLeft+Escape"], ["quit-app", "MetaLeft+KeyQ"], ["close-window", "MetaLeft+KeyW"], ["hide-app", "MetaLeft+KeyH"],
    ["mission-control", "ControlLeft+ArrowUp"], ["show-desktop", "MetaLeft+F3"],
  ]);
});

it("exactly the target platforms the protocol accepts have a key mapping and shortcuts", () => {
  for (const platform of ["macos", "windows", "linux"]) {
    const accepted = screenDesktopSchema.shape.platform.safeParse(platform).success;
    expect(accepted).toBe((SCREEN_TARGET_PLATFORMS as readonly string[]).includes(platform));
    const target = platform as ScreenTargetPlatform;
    if (accepted) {
      expect(screenShortcuts(target).length).toBeGreaterThan(0);
      expect(screenControllerCode("KeyA", "mac", "command", target)).toBe("KeyA");
    } else {
      // Never fall back to another platform's keys or shortcuts.
      expect(() => screenShortcuts(target)).toThrow("screen_target_platform_unknown");
      expect(() => screenControllerCode("KeyA", "mac", "command", target)).toThrow("screen_target_platform_unknown");
    }
  }
});
