import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HOST_CLI_HELP, runHostCli } from "../src/host-cli/cli.js";
import { HostManagement } from "../src/host-cli/management.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { PiSessionSnapshot } from "../src/client-protocol/pi-session.js";
import * as admission from "../src/host-cli/windows-state-admission.js";

let root: string, stateDir: string, conversation: string, hub: HubServer;
let gateway: Awaited<ReturnType<typeof attachGateway>>, closeControl: () => Promise<void>, local: LocalHostClient;
let log: ReturnType<typeof vi.spyOn>, snapshot: PiSessionSnapshot;
const bridge = {
  handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
  getPiSession: vi.fn(async () => snapshot),
  changePiSession: vi.fn(async (_input: { action: string; value: string | null }) => ({ outcome: "unknown" as const, reason: "uncertain" as const })),
};
/**
 * Windows directory admission asks the packaged native helper (bin/open-super-agent-host-launcher.exe), which a source
 * checkout does not have, so every test here failed with host_directory_probe_failed before any assertion.
 * Only those two probe-backed calls are replaced, only on Windows, and only with the directory this fixture
 * created; their own behaviour is tested in windows-state-probe.test.ts and windows-host-directory.test.ts.
 * Directory and identity pipe leases, state integrity, enrollment, ownership and membership checks stay real.
 */
let admissionStubs: Array<{ mockRestore(): void }> = [];
const isolateWindowsDirectoryProbe = () => {
  if (process.platform !== "win32") return;
  admissionStubs = [
    vi.spyOn(admission, "guardHostDirectory").mockResolvedValue(undefined),
    vi.spyOn(admission, "admitWindowsDirectory").mockImplementation(async directory => {
      if (!directory) throw new Error("this fixture always names its host directory");
      return path.resolve(directory);
    }),
  ];
};
beforeEach(async () => {
  vi.clearAllMocks(); snapshot = { supported: true };
  isolateWindowsDirectoryProbe();
  root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-cli-pi-session-"));
  await initializeHost(root, "Pi session fixture");
  hub = await HubServer.start({ stateDir: root }); stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", model: "fixture/default", effort: "high" }));
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Pi',?,'pi')", [hashSecret(secret)]);
  conversation = (await hub.store.createConversation("owner", ["bot"], "Fixture", "create")).id;
  gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "pi", runtime: createCoreServiceRuntime(), bridge });
  closeControl = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  local = await LocalHostClient.connect(root, { enroll: true });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => { log?.mockRestore(); for (const stub of admissionStubs.splice(0)) stub.mockRestore(); local?.close(); await gateway?.disconnect(); await closeControl?.(); await hub?.close(); await rm(root, { recursive: true, force: true }); });
const cli = (args: string[] = [], id = conversation) => runHostCli(["conversations", "pi-session", ...(id ? [id] : []), ...args, "--state-dir", root, "--json"]);
const result = () => JSON.parse(log.mock.calls.at(-1)![0] as string);

it("reads the authenticated current snapshot without creating a turn or changing Bot defaults", async () => {
  expect(HOST_CLI_HELP).toContain("conversations pi-session CONVERSATION --bot BOT");
  expect(HOST_CLI_HELP).toContain("--session TOKEN --request-id ID");
  const config = await readFile(path.join(stateDir, "config.json"), "utf8");
  await cli(["--bot", "bot"]);
  expect(result()).toEqual({ supported: true });
  expect(bridge.getPiSession).toHaveBeenCalledTimes(1);
  expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  expect(bridge.changePiSession).not.toHaveBeenCalled();
  expect(await readFile(path.join(stateDir, "config.json"), "utf8")).toBe(config);
});

it.each(["off", "minimal"])("preserves the native Pi thinking level %s", async thinking => {
  await cli(["--bot", "bot", "--thinking", thinking, "--session", "opaque", "--request-id", "thinking_change"]);
  expect(result()).toEqual({ outcome: "unknown", reason: "uncertain" });
  expect(bridge.changePiSession.mock.calls[0]?.[0]).toMatchObject({ action: "thinking", value: thinking });
  expect(bridge.changePiSession).toHaveBeenCalledTimes(1);
});

it("rejects malformed API responses rather than claiming a successful session change", async () => {
  const request = vi.fn(async () => ({ ok: true }));
  const management = new HostManagement({ request } as unknown as LocalHostClient);
  await expect(management.piSession("chat", "bot")).rejects.toThrow();
  await expect(management.piSession("chat", "bot", { requestId: "change", expectedSession: "opaque", action: "model", value: "fixture/model" })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["model", "thinking"] as const)("sends %s default as null and reads an unknown receipt without replay", async action => {
  const flags = ["--bot", "bot", `--${action}`, "default", "--session", "opaque", "--request-id", "same_operation"];
  await cli(flags); expect(result()).toEqual({ outcome: "unknown", reason: "uncertain" });
  expect(bridge.changePiSession.mock.calls[0]?.[0]).toMatchObject({ action, value: null });
  await cli(["--bot", "bot"]); expect(result()).toEqual({ supported: true });
  await cli(flags); expect(result()).toEqual({ outcome: "unknown", reason: "uncertain" });
  expect(bridge.changePiSession).toHaveBeenCalledTimes(1);
  // Same request ID cannot be repurposed with a different value.
  await cli(["--bot", "bot", `--${action}`, action === "model" ? "fixture/other" : "off", "--session", "opaque", "--request-id", "same_operation"]);
  expect(result()).toEqual({ outcome: "rejected", reason: "stale" });
  expect(bridge.changePiSession).toHaveBeenCalledTimes(1);
});

it("requires IDs, exclusive changes and explicit receipt identity before any session call", async () => {
  await expect(cli(["--bot", "bot"], "")).rejects.toThrow("CONVERSATION");
  await expect(cli()).rejects.toThrow("--bot");
  await expect(cli(["--bot", "bot", "--model", "default", "--thinking", "low"])).rejects.toThrow("--model");
  await expect(cli(["--bot", "bot", "--model", "default"])).rejects.toThrow("--session");
  await expect(cli(["--bot", "bot", "--thinking", "minimal", "--session", "opaque"])).rejects.toThrow("--request-id");
  await expect(cli(["--bot", "bot", "--session", "opaque", "--request-id", "unused"])).rejects.toThrow("只读");
  await expect(cli(["--bot", "bot", "--thinking", "ultra", "--session", "opaque", "--request-id", "invalid"])).rejects.toThrow();
  await expect(cli(["--bot", "bot", "--host", "another"])).rejects.toThrow();
  await expect(runHostCli(["conversations", "local", "--model", "default", "--state-dir", root])).rejects.toThrow();
  expect(bridge.getPiSession).not.toHaveBeenCalled();
  expect(bridge.changePiSession).not.toHaveBeenCalled();
});

it("preserves the existing owner and conversation membership checks", async () => {
  expect((await fetch(`${hub.url}/api/conversations/${conversation}/pi-session?botId=bot`)).status).toBe(401);
  await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
  await expect(cli(["--bot", "bot"])).rejects.toThrow("owner_required");
  await hub.store.db.run("UPDATE users SET role='owner' WHERE id='owner'");
  await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id='owner'", [conversation]);
  await expect(cli(["--bot", "bot", "--model", "fixture/other", "--session", "opaque", "--request-id", "forbidden"])).rejects.toThrow();
  expect(bridge.changePiSession).not.toHaveBeenCalled();
  expect(bridge.getPiSession).not.toHaveBeenCalled();
});
