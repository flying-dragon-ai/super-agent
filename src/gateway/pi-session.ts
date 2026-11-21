import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { PI_SESSION_CAPABILITY, piSessionChangeSchema, piSessionResultSchema, piSessionSnapshotSchema, type PiSessionResult } from "../client-protocol/pi-session.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import type { CoreBridgeLike } from "../core/types.js";
import type { GatewayChannel } from "./channel.js";
import { GatewayReceipts } from "./receipts.js";

const readSchema = z.object({ conversationId: idSchema, userId: idSchema, botId: idSchema }).strict();
const writeSchema = piSessionChangeSchema.extend({ conversationId: idSchema, userId: idSchema }).strict();
const stale: PiSessionResult = { outcome: "rejected", reason: "stale" };
const unknown: PiSessionResult = { outcome: "unknown", reason: "uncertain" };

/** Model controls do not enter the prompt queue, acquire its approvals or resume a session. */
export function gatewayPiSession(bridge: CoreBridgeLike, channel: GatewayChannel, stateDir: string, botId: string) {
  const receipts = new GatewayReceipts(stateDir);
  return async (method: string, raw: unknown) => {
    if (method !== "pi.session.get" && method !== "pi.session.set") throw new Error("unsupported_pi_session_operation");
    const p = method === "pi.session.get" ? readSchema.parse(raw) : writeSchema.parse(raw);
    if (!channel.transport.capabilities.includes(PI_SESSION_CAPABILITY)) return method === "pi.session.get" ? { supported: false } : { outcome: "rejected", reason: "unsupported" };
    const isCurrentSession = async () => {
      if (p.botId !== botId || !channel.transport.capabilities.includes(PI_SESSION_CAPABILITY)) return false;
      try {
        const permission = z.object({ allowed: z.boolean() }).strict().parse(await channel.transport.requestLive("pi.session.authorize", { conversationId: p.conversationId, userId: p.userId }));
        return permission.allowed && await channel.canSteerConversation?.(p.conversationId) === true;
      } catch { return false; }
    };
    if (!await isCurrentSession()) return method === "pi.session.get" ? { supported: true } : stale;
    const conversationKey = buildCoreConversationKey(p.conversationId);
    const scope = { chatId: stableCoreNumericId(conversationKey), conversationKey, isCurrentSession };
    if (method === "pi.session.get") {
      if (!bridge.getPiSession) return { supported: false };
      const snapshot = piSessionSnapshotSchema.parse(await bridge.getPiSession(scope));
      return await isCurrentSession() ? snapshot : { supported: true };
    }
    const command = writeSchema.parse(p);
    // Reserve the full payload before the side-effect receipt. Even an interrupted
    // mutation must not let the same requestId acquire different parameters.
    const identity = JSON.stringify([command.botId, command.userId, command.conversationId, command.expectedSession, command.action, command.value]);
    const key = `pi.session:${command.userId}:${command.requestId}`;
    const authorize = async () => { if (!await isCurrentSession()) throw new Error("pi_session_stale"); };
    let admitted = false;
    try {
      const reservation = await receipts.run(`${key}:identity`, async () => ({ identity }), 0, authorize);
      if (!reservation.ok) return unknown;
      const stored = z.object({ identity: z.string() }).strict().safeParse(reservation.result);
      if (!stored.success || stored.data.identity !== identity) return stale;
      const receipt = await receipts.run(`${key}:change`, async () => {
        admitted = true;
        if (!bridge.changePiSession) return { outcome: "rejected", reason: "unsupported" };
        try {
          return piSessionResultSchema.parse(await bridge.changePiSession({ ...scope, expectedSession: command.expectedSession, action: command.action, value: command.value }));
        } catch { return unknown; }
      }, 0, authorize);
      // The model may already have changed when access disappears; never label it a safe rejection.
      if (!await isCurrentSession()) return unknown;
      return receipt.ok ? piSessionResultSchema.parse(receipt.result) : unknown;
    } catch (error) {
      return !admitted && error instanceof Error && error.message === "pi_session_stale" ? stale : unknown;
    }
  };
}
