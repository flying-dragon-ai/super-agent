import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { createDeepSeekOfficeFontPatch, deepSeekOfficeToolTimeout } from "../src/codex/deepseek-office-fonts.js";

const roots = ["/System/Library/Fonts", "/Library/Fonts", "/Users/example/Library/Fonts"];
const row = (config: string) => `- id: office-kit\n  name: '@deepseek-ai/dsh-office-kit'\n${config}`;

describe("private DeepSeek Office font defaults", () => {
  it("keeps composed profile settings and loader expressions without executing them", () => {
    const dump = row('  config:\n    timeoutMs: 17000\n    maxReaders: 7\n    outputDirectory: !!js dshHomePath("office-kit", "custom")\n');
    const patch = createDeepSeekOfficeFontPatch(dump, roots);
    expect(patch).toContain("timeoutMs: 17000");
    expect(patch).toContain("maxReaders: 7");
    expect(patch).toContain("!!js");
    expect(patch).toContain('dshHomePath("office-kit", "custom")');
    expect(patch).toContain("fontDirectories:");
    expect(patch).not.toMatch(/Group Containers|FontCache/);
    expect(patch).not.toMatch(/disabled:|inject:/);
  });

  it.each(['["/fonts/custom"]', '[]', `!!js '["/fonts/runtime"]'`, 'null'])("preserves explicit fontDirectories: %s", value => {
    expect(createDeepSeekOfficeFontPatch(row(`  config:\n    fontDirectories: ${value}\n    timeoutMs: 10000\n`), roots)).toBe("");
  });

  it("adds defaults to a config-less provider without changing its identity", () => {
    const patch = createDeepSeekOfficeFontPatch(row(""), roots);
    expect(parseDocument(patch).toJS()).toEqual([{ id: "office-kit", name: "@deepseek-ai/dsh-office-kit", config: { fontDirectories: roots } }]);
  });

  it("leaves disabled, replaced and absent providers unchanged", () => {
    expect(createDeepSeekOfficeFontPatch(row("  disabled: true\n"), roots)).toBe("");
    expect(createDeepSeekOfficeFontPatch(row("  disabled: !!js true\n"), roots)).toBe("");
    expect(createDeepSeekOfficeFontPatch(row("").replace("@deepseek-ai/dsh-office-kit", "custom-office"), roots)).toBe("");
    expect(createDeepSeekOfficeFontPatch("- id: other\n  name: other\n", roots)).toBe("");
  });

  it("refuses ambiguous provider ids and malformed YAML", () => {
    expect(() => createDeepSeekOfficeFontPatch(row("") + row(""), roots)).toThrow();
    expect(() => createDeepSeekOfficeFontPatch("[broken", roots)).toThrow();
    expect(() => createDeepSeekOfficeFontPatch(row("  config:\n    timeoutMs: !custom 90000\n"), roots)).toThrow();
  });

  it("does not replace runtime-computed config or alias graphs", () => {
    // Do not evaluate user code in the Host or change its loader scope.
    expect(createDeepSeekOfficeFontPatch(row("  config: !!js makeOfficeConfig()\n"), roots)).toBe("");
    expect(createDeepSeekOfficeFontPatch(row("  config: &config\n    timeoutMs: 20000\n"), roots)).toBe("");
    expect(createDeepSeekOfficeFontPatch('- id: seed\n  config: &office\n    timeoutMs: 10000\n' + row('  config: *office\n'), roots)).toBe("");
  });
});

describe("DeepSeek Office watchdog budget", () => {
  it("includes queue time and retains larger custom conversion budgets", () => {
    expect(deepSeekOfficeToolTimeout(row(""))).toBe(10 * 60_000);
    expect(deepSeekOfficeToolTimeout(row("  config:\n    timeoutMs: 1800000\n    maxQueuedJobs: 4\n    maxConcurrentConversions: 1\n"))).toBe(18_000_000);
  });
  it.each(['!!js computeTimeout()', '2147483647', '0', '-1', 'null'])("does not guess or overflow a custom timeout: %s", value => {
    expect(deepSeekOfficeToolTimeout(row(`  config:\n    timeoutMs: ${value}\n`))).toBeNull();
  });
  it("leaves opaque or substituted Office providers with their existing budget", () => {
    expect(deepSeekOfficeToolTimeout(row("  config: !!js customConfig()\n"))).toBeNull();
    expect(deepSeekOfficeToolTimeout(row("  config:\n    <<: { timeoutMs: 20000 }\n"))).toBeNull();
    expect(deepSeekOfficeToolTimeout(row("  disabled: true\n"))).toBeNull();
    expect(deepSeekOfficeToolTimeout("[]")).toBeNull();
  });
  it("patches a real dump shape and remains idempotent with quoted or block loader expressions", () => {
    const source = `- id: unrelated
  name: example-provider
  config:
    request: true
- name: '@deepseek-ai/dsh-office-kit'
  id: office-kit
  config:
    outputDirectory: !!js >-
      dshHomePath('office-kit', 'outputs')
    maxReaders: 32
    fontFallbacks: !!js '["sans", "serif"]'
  inject:
    fs: {}
    $libreoffice-kit: {}
`;
    const patch = createDeepSeekOfficeFontPatch(source, roots);
    expect(patch).toContain("fontDirectories:");
    expect(patch).toContain("dshHomePath('office-kit', 'outputs')");
    expect(patch).toContain('!!js');
    expect(createDeepSeekOfficeFontPatch(patch, roots)).toBe("");
    expect(deepSeekOfficeToolTimeout(patch)).toBe(600_000);
  });
});
