import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { configPath, loadJsonConfigWithLegacyFallback, parseModelKey, validateGuidanceFields } from "./settings.js";

it("retains XDG resolution and old config fallback without reading the real home directory", () => {
	const legacy = join(homedir(), ".config/rpiv-advisor/advisor.json");
	mkdirSync(dirname(legacy), { recursive: true });
	writeFileSync(legacy, '{"modelKey":"p/m"}');
	vi.stubEnv("XDG_CONFIG_HOME", "relative");
	expect(configPath("rpiv-advisor", "advisor.json")).toBe(legacy);
	vi.stubEnv("XDG_CONFIG_HOME", "~/xdg");
	const current = join(homedir(), "xdg/rpiv-advisor/advisor.json");
	expect(configPath("rpiv-advisor", "advisor.json")).toBe(current);
	expect(loadJsonConfigWithLegacyFallback("rpiv-advisor", "advisor.json")).toEqual({ modelKey: "p/m" });
	mkdirSync(dirname(current), { recursive: true });
	writeFileSync(current, '{"modelKey":"new/m"}');
	expect(loadJsonConfigWithLegacyFallback("rpiv-advisor", "advisor.json")).toEqual({ modelKey: "new/m" });
	writeFileSync(current, 'null');
	expect(loadJsonConfigWithLegacyFallback("rpiv-advisor", "advisor.json")).toEqual({});
});

it("preserves the model-key and guidance formats used by existing configurations", () => {
	expect(parseModelKey("provider/model")).toEqual({ provider: "provider", modelId: "model" });
	expect(parseModelKey("provider:model")).toEqual({ provider: "provider", modelId: "model" });
	expect(parseModelKey("invalid")).toBeUndefined();
	expect(validateGuidanceFields({ promptSnippet: "", promptGuidelines: ["valid", ""], description: 1 })).toEqual({});
	expect(validateGuidanceFields({ promptSnippet: "review", promptGuidelines: ["carefully"] })).toEqual({ promptSnippet: "review", promptGuidelines: ["carefully"] });
});
