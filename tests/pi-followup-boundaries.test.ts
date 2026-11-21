import { describe, expect, it } from "vitest";
import { HOST_CLI_HELP } from "../src/host-cli/cli.js";
import { dispatcherInstructions } from "../src/gateway/agent-instructions.js";
import { classifyFailure, extractModelEffortMismatch, getBusErrorSemantics, renderEngineSettingsError } from "../src/runtime/error-classification.js";
import { unsupportedEngineEffortError } from "../src/state/instance-config.js";
import { PiRpcClosedError, PiRpcCommandError, PiRpcTimeoutError, PiStartupError } from "../src/codex/pi-rpc-client.js";
import { PiNativeRejectedError } from "../src/codex/pi-native-types.js";

it("does not advertise Pi as a dispatcher target while keeping ordinary Pi Bots available", () => {
  const dispatchHelp = HOST_CLI_HELP.split("\n").find(line => line.includes("tickets dispatch TICKET"));
  expect(dispatchHelp).toContain("codex|claude|kimi|deepseek|antigravity");
  expect(dispatchHelp).not.toMatch(/\bpi\b/);
  expect(dispatcherInstructions()).not.toMatch(/\bpi\b/);
  expect(HOST_CLI_HELP).toContain("引擎：codex、claude、antigravity、kimi、deepseek、pi");
});

describe("Pi error boundaries", () => {
  it.each([
    "Tool failed: could not compute pi to 100 digits",
    "upload to raspberry pi failed with status 429",
    "raspberry pi payment required 402",
    "raspberry pi content_filter failed",
    "cannot read /tmp/pi/output.txt",
  ])("does not treat unrelated pi text as an engine signal: %s", error => {
    expect(classifyFailure(error)).toBe("unknown");
  });

  it.each([
    new PiStartupError("Executable missing", "spawn"),
    new PiRpcClosedError("get_state"),
    new PiRpcTimeoutError("get_state", 10),
    "Pi CLI startup failed",
    "Pi RPC transport failed",
    "Pi adapter session disconnected",
  ])("recognizes explicit Pi runtime errors: %s", error => {
    expect(classifyFailure(error)).toBe("engine-cli");
  });

  it("uses the typed Pi RPC marker for a provider status without matching a bare pi word", () => {
    expect(classifyFailure(new PiRpcCommandError("prompt", "HTTP status 429", "other"))).toBe("engine-rate-limit");
  });

  it.each(["off", "minimal"])("classifies the shared Pi %s rejection as settings, without replay", effort => {
    const error = unsupportedEngineEffortError("pi", effort, "fixture/model");
    expect(classifyFailure(error)).toBe("engine-settings");
    expect(getBusErrorSemantics(classifyFailure(error)).retryable).toBe(false);
    expect(extractModelEffortMismatch(error)?.effort).toBe(effort);
  });

  it("preserves Pi provider/model identity and off/minimal choices without exposing diagnostic tails", () => {
    const model = "fixture%2Fprovider/org/model:latest[1m]";
    const error = new PiNativeRejectedError(`Invalid model selection: ${model} has no "high" effort (available: off, minimal)\n/private/secret=do-not-render`, "thinking-unsupported", ["off", "minimal"]);
    expect(classifyFailure(error)).toBe("engine-settings");
    expect(extractModelEffortMismatch(error)).toEqual({ model, effort: "high", available: ["off", "minimal"] });
    for (const locale of ["zh", "en"] as const) {
      const message = renderEngineSettingsError(error, locale);
      expect(message).toContain(model);
      expect(message).not.toMatch(/private|secret|do-not-render/);
    }
  });

  it("classifies an unavailable native Pi model as settings and explains model availability", () => {
    const error = new PiNativeRejectedError("Invalid model selection: fixture/org/model:latest is not available in Pi. Either the model does not exist or its provider is not signed in.", "model-unavailable");
    expect(classifyFailure(error)).toBe("engine-settings");
    expect(getBusErrorSemantics(classifyFailure(error)).retryable).toBe(false);
    expect(renderEngineSettingsError(error, "en")).toContain("available in Pi");
    expect(renderEngineSettingsError(error, "zh")).toContain("Pi");
  });

  it.each(["fixture/中文 模型", "fixture/My Model", "the current model"])("recognizes a Pi setting failure with %s and keeps diagnostics private", model => {
    const error = new PiNativeRejectedError(`Invalid model selection: ${model} has no "high" effort (available: off)\nprivate-diagnostic`, "thinking-unsupported", ["off"]);
    expect(classifyFailure(error)).toBe("engine-settings");
    expect(renderEngineSettingsError(error, "en")).not.toContain("private-diagnostic");
    if (model.includes("/")) expect(extractModelEffortMismatch(error)).toBeUndefined();
  });

  it.each(["/private/model", "x".repeat(513), "fixture/<script>"])("does not expose invalid or oversized model identifiers: %s", model => {
    expect(extractModelEffortMismatch(`Invalid model selection: ${model} has no "high" effort (available: off)`)).toBeUndefined();
  });
});
