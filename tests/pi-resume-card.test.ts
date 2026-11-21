import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleCoreCardAction } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { SessionStore } from "../src/state/session-store.js";

describe("Pi resume cards", () => {
  it.each(["zh", "en"] as const)("binds a validated Pi history and workspace in %s", async locale => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-resume-card-"));
    const conversationKey = "lark:gw_pi_fixture";
    const sessionId = "pi-session-fixture";
    const channel = {
      profile: "gateway" as const,
      send: vi.fn(async () => ({ messageId: "msg_result" })),
      stream: vi.fn(async () => ({ messageId: "msg_stream" })),
      downloadResource: vi.fn(async () => Buffer.alloc(0)),
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => ({ sessionId, cwd: stateDir, title: "Pi native history" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "Must not invoke a model" })),
    };
    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale }));
      const handled = await withChannelProfile("gateway", () => handleCoreCardAction({
        stateDir, channel, bridge, runtime: createCoreServiceRuntime(),
        event: {
          chatId: "gw_pi_fixture", messageId: "msg_resume", operator: { openId: "user_fixture" },
          action: { value: { cctb_lark: "resume", engine: "pi", conversationKey,
            bridgeChatType: "private", sessionId, workspacePath: "/workspace/forged-path" } },
        },
      }));
      expect(handled).toBe(true);
      expect(bridge.validateCodexThread).toHaveBeenCalledWith(sessionId);
      const record = await new SessionStore(path.join(stateDir, "session.json")).findByConversationKey(conversationKey);
      expect(record?.codexSessionId).toBe(sessionId);
      expect(record?.resume).toEqual({ sessionId, dirName: sessionId, workspacePath: await realpath(stateDir) });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      const messages = JSON.stringify(channel.send.mock.calls);
      expect(messages).toContain("Pi");
      expect(messages).not.toContain("Kimi");
      expect(messages).not.toContain("/workspace/forged-path");
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
