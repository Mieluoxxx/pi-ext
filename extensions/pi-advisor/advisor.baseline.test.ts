import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("reports consultation, retry and warming usage once with the same since filter", () => {
	const dir = mkdtempSync(join(tmpdir(), "advisor-baseline-"));
	const script = fileURLToPath(new URL("./scripts/advisor-usage-baseline.mjs", import.meta.url));
	const usage = (total: number) => ({ input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total } });
	const result = (timestamp: string) => ({
		type: "message",
		timestamp,
		message: {
			role: "toolResult",
			toolName: "advisor",
			usage: usage(2),
			details: {
				advisorModel: "p:m",
				usage: usage(2),
				attempts: [{ usage: usage(1) }, { usage: usage(1) }],
				estimate: { costUsd: 1 },
				context: { trimmed: true },
			},
		},
	});
	try {
		writeFileSync(
			join(dir, "session.jsonl"),
			[
				result("2026-09-01T00:00:00Z"),
				result("2026-09-28T00:00:00Z"),
				{
					type: "usage",
					kind: "advisor-cache-warming",
					provider: "p",
					model: "m",
					usage: usage(0.25),
					timestamp: "2026-09-28T00:01:00Z",
				},
				{
					type: "message",
					timestamp: "2026-09-28T00:02:00Z",
					message: {
						role: "toolResult",
						toolName: "advisor",
						details: { skipped: true, errorMessage: "same model as executor" },
					},
				},
			]
				.map((e) => JSON.stringify(e))
				.join("\n"),
		);
		const output = execFileSync(process.execPath, [script, "p:m", `--sessions=${dir}`, "--since=2026-09-28"], {
			encoding: "utf8",
		});
		expect(output).toContain("advisor calls with usage: 1");
		expect(output).toContain("consultation cost $2.00; warming cost $0.25 (1 refreshes)");
		expect(output).toContain("total advisor cost $2.25");
		expect(output).toContain("trimmed consultations: 1; retries: 1");
		expect(output).toContain("'same model as executor': 1");
		expect(output).toContain("actual/estimated call cost p50/p90: 1 / 1");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
