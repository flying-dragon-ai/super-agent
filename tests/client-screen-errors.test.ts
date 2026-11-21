// The shared remote screen reason table (#48/#49 P1). `check-translations`
// only sees literal t("…") calls, so this keeps every table entry translated.
import { afterEach, expect, it, vi } from "vitest";
import english from "../client/src/locales/en.json" with { type: "json" };
import { setLocale } from "../client/src/i18n.js";
import { SCREEN_ERROR_MESSAGES, screenError } from "../client/src/screen-errors.js";

afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });
const placeholders = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort().join();

it("every reason message has an English translation with the same placeholders", () => {
  const dictionary = english as Record<string, string>;
  expect(Object.keys(SCREEN_ERROR_MESSAGES).length).toBeGreaterThan(0);
  for (const [reason, message] of Object.entries(SCREEN_ERROR_MESSAGES)) {
    expect(dictionary[message]?.trim(), reason).toBeTruthy();
    expect(placeholders(dictionary[message]!), reason).toBe(placeholders(message));
  }
  expect(dictionary["屏幕连接已结束，请检查主机状态后重试。"]?.trim()).toBeTruthy();
});

it("known reasons show their sentence in the UI locale; unknown ones keep the generic sentence and a bounded code", () => {
  expect(screenError("screen_locked")).toBe("目标 Mac 已锁定，请在本机解锁后重新连接。");
  expect(screenError("x".repeat(200))).toBe(`屏幕连接已结束，请检查主机状态后重试。 (${"x".repeat(120)})`);
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  expect(screenError("screen_locked")).toBe((english as Record<string, string>)["目标 Mac 已锁定，请在本机解锁后重新连接。"]);
  expect(screenError("screen_new_reason")).toBe(`${(english as Record<string, string>)["屏幕连接已结束，请检查主机状态后重试。"]} (screen_new_reason)`);
});
