import { expect, it } from "vitest";
import { desktopReplyWidth, isReplyWide, replyWidthKey, setReplyWide } from "../client/src/reply-width.js";

const desktop = { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15", platform: "MacIntel", maxTouchPoints: 0 };

it("keeps equal message IDs isolated by host, paired device and conversation", () => {
  const first = replyWidthKey("host-a", "device-a", "chat-a", "reply");
  const others = [
    replyWidthKey("host-b", "device-a", "chat-a", "reply"),
    replyWidthKey("host-a", "device-b", "chat-a", "reply"),
    replyWidthKey("host-a", "device-a", "chat-b", "reply"),
    replyWidthKey("host-a", "device-a", "chat-a", "next-reply"),
  ];
  try {
    setReplyWide(first, true);
    expect(isReplyWide(first)).toBe(true);
    for (const key of others) expect(isReplyWide(key)).toBe(false);
    setReplyWide(others[0]!, true);
    setReplyWide(first, false);
    expect(isReplyWide(first)).toBe(false);
    expect(isReplyWide(others[0]!)).toBe(true);
  } finally {
    for (const key of [first, ...others]) setReplyWide(key, false);
  }
});

it.each(["ios", "android"])("does not offer desktop width controls in a %s shell with a desktop user agent", platform => {
  expect(desktopReplyWidth(platform, desktop)).toBe(false);
});

it.each(["iPhone", "iPad", "iPod", "Android"])("does not offer desktop width controls to a %s web client", userAgent => {
  expect(desktopReplyWidth("web", { ...desktop, userAgent })).toBe(false);
});

it("recognizes a touch iPad using desktop Safari identification", () => {
  expect(desktopReplyWidth("web", { ...desktop, maxTouchPoints: 5 })).toBe(false);
});

it.each(["macos", "windows", "web"])("keeps the %s desktop entry available", platform => {
  expect(desktopReplyWidth(platform, desktop)).toBe(true);
});
