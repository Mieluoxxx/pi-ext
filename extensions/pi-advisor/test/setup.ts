import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeEach, vi } from "vitest";

const testHome = vi.hoisted(() => `${process.env.TMPDIR || process.env.TEMP || "/tmp"}/pi-advisor-${process.pid}-${Math.random().toString(36).slice(2)}`);
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => testHome }));
vi.mock("@earendil-works/pi-ai", async (original) => ({
	...await original<typeof import("@earendil-works/pi-ai")>(),
	getSupportedThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"]),
}));
vi.mock("@earendil-works/pi-ai/compat", async (original) => ({
	...await original<typeof import("@earendil-works/pi-ai/compat")>(), completeSimple: vi.fn(),
}));

beforeEach(async () => {
	vi.stubEnv("XDG_CONFIG_HOME", "");
	vi.stubEnv("PI_CACHE_RETENTION", "short");
	rmSync(testHome, { recursive: true, force: true });
	mkdirSync(testHome, { recursive: true });
	const advisor = await import("../advisor/index.js");
	advisor.setAdvisorModel(undefined);
	advisor.setAdvisorEffort(undefined);
	advisor.setDisabledForModels([]);
	advisor.__resetAdvisorAnnounced();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("rpiv-advisor")];
});
afterAll(() => { rmSync(testHome, { recursive: true, force: true }); vi.unstubAllEnvs(); });
