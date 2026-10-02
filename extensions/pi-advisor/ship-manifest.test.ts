import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("packs the standalone entry, runtime helpers, prompt and usage script without tests", () => {
	const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8",
	}));
	const pack = Array.isArray(result) ? result[0] : result["@moguw/pi-advisor"];
	const files = pack.files.map((file: { path: string }) => file.path);
	expect(files).toEqual(
		expect.arrayContaining([
			"index.ts",
			"advisor/settings.ts",
			"advisor/anchor.ts",
			"advisor/cards.ts",
			"advisor/ledger.ts",
			"advisor/loop.ts",
			"advisor/tools.ts",
			"advisor/warming.ts",
			"prompts/advisor-system.txt",
			"scripts/advisor-usage-baseline.mjs",
			"scripts/advisor-ledger-replay.ts",
			"LICENSE",
			"NOTICE",
		]),
	);
	expect(files.some((file: string) => file.endsWith(".test.ts") || file.startsWith("test/") || file.includes("node_modules"))).toBe(false);
});
