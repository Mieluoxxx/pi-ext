/**
 * Offline ledger replay — compare old and new advisor payload sizes over real
 * pi session logs. Makes NO model requests and writes nothing.
 *
 * At every point in history where an advisor() call actually happened, this
 * re-renders that same branch through the current ledger and reports the size
 * against what the session recorded as actually billed.
 *
 * Usage:
 *   npx tsx scripts/advisor-ledger-replay.ts [--sessions=DIR] [--limit=N] [--json]
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { validateAdvisorLedger } from "../advisor/config.js";
import { renderLedger } from "../advisor/ledger.js";
import { ADVISOR_SYSTEM_PROMPT } from "../advisor/prompt.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = flag("sessions") ?? join(homedir(), ".pi/agent/sessions");
const limit = Number(flag("limit") ?? 200);
const asJson = args.includes("--json");

const files: string[] = [];
(function walk(dir: string) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (p.endsWith(".jsonl")) files.push(p);
	}
})(root);

const limits = validateAdvisorLedger(undefined);
const systemTokens = Math.ceil(ADVISOR_SYSTEM_PROMPT.length / 4);

interface Row {
	file: string;
	/** Prompt tokens the provider actually billed for the old payload. */
	actual: number;
	/** Estimated prompt tokens the ledger would send instead. */
	ledger: number;
	userChars: number;
	userKept: number;
	cards: number;
	trimmed: boolean;
	entries: number;
}

const rows: Row[] = [];

for (const file of files) {
	const lines = readFileSync(file, "utf8").split("\n");
	if (!lines.some((l) => l.includes('"toolName":"advisor"'))) continue;
	const entries: SessionEntry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed.type) entries.push(parsed);
		} catch {
			/* skip malformed */
		}
	}

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: Record<string, unknown> };
		if (message.role !== "toolResult" || message.toolName !== "advisor") continue;
		const usage = (message.details?.usage ?? (entry as { message: { usage?: unknown } }).message.usage) as
			| { input: number; cacheRead: number; cacheWrite?: number }
			| undefined;
		if (!usage) continue;

		// The branch as it stood when this consultation was dispatched: everything
		// up to (not including) its result.
		const branch = entries.slice(0, i);
		const leafId = branch.at(-1)?.id ?? null;
		const view = renderLedger(branch, leafId, { limits, tailToolCalls: limits.tailToolCalls });
		const rendered = JSON.stringify(view.messages);

		// Only entries on the LEAF PATH are part of this consultation: a /tree
		// navigation or fork leaves abandoned entries in the file that the renderer
		// correctly never sees.
		const byId = new Map(branch.map((e) => [e.id, e]));
		const path: SessionEntry[] = [];
		for (let cursor = branch.at(-1); cursor; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) {
			path.push(cursor);
		}
		path.reverse();

		// Every user message on the path must survive into the render.
		let userChars = 0;
		let userKept = 0;
		for (const e of path) {
			if (e.type !== "message" || (e.message as { role?: string }).role !== "user") continue;
			const content = (e.message as { content?: unknown }).content;
			const text = typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((c) => (c as { type?: string }).type === "text")
							.map((c) => (c as { text: string }).text)
							.join("\n")
					: "";
			if (!text.trim()) continue;
			userChars++;
			// Long messages are kept head+tail, so probe a short leading slice.
			if (rendered.includes(JSON.stringify(text.slice(0, 60)).slice(1, -1))) userKept++;
		}

		rows.push({
			file,
			entries: path.length,
			actual: usage.input + usage.cacheRead + (usage.cacheWrite ?? 0),
			ledger: Math.ceil(rendered.length / 4) + systemTokens,
			userChars,
			userKept,
			cards: view.blockIds.length,
			trimmed: view.trimmed,
		});
		if (rows.length >= limit) break;
	}
	if (rows.length >= limit) break;
}

const quant = (xs: number[], q: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(q * (s.length - 1))] : Number.NaN;
};

const actual = rows.map((r) => r.actual);
const ledger = rows.map((r) => r.ledger);
const ratios = rows.filter((r) => r.actual > 0).map((r) => r.ledger / r.actual);
const lostUser = rows.filter((r) => r.userKept < r.userChars);

if (asJson) {
	console.log(JSON.stringify({ rows: rows.length, actual, ledger, lostUser: lostUser.length }, null, 2));
} else {
	console.log(`replayed consultations: ${rows.length} (from ${files.length} session files)`);
	console.log(
		`actual prompt tokens  p50/p90/max: ${quant(actual, 0.5)} / ${quant(actual, 0.9)} / ${quant(actual, 1)}`,
	);
	console.log(
		`ledger prompt tokens  p50/p90/max: ${quant(ledger, 0.5)} / ${quant(ledger, 0.9)} / ${quant(ledger, 1)}`,
	);
	console.log(`ledger/actual ratio   p50/p90: ${quant(ratios, 0.5).toFixed(3)} / ${quant(ratios, 0.9).toFixed(3)}`);
	const totalActual = actual.reduce((a, b) => a + b, 0);
	const totalLedger = ledger.reduce((a, b) => a + b, 0);
	console.log(
		`total prompt tokens: ${(totalActual / 1e6).toFixed(1)}M → ${(totalLedger / 1e6).toFixed(1)}M (${(
			100 * (1 - totalLedger / totalActual)
		).toFixed(1)}% less)`,
	);
	console.log(`trimmed renders: ${rows.filter((r) => r.trimmed).length}`);
	// The load-bearing invariant: the user's words are never dropped.
	console.log(`consultations losing a user message: ${lostUser.length}`);
	for (const row of lostUser.slice(0, 5)) console.log(`  ${row.file}: kept ${row.userKept}/${row.userChars}`);
	const bigger = rows.filter((r) => r.actual > 0 && r.ledger > r.actual).sort((a, b) => b.ledger / b.actual - a.ledger / a.actual);
	console.log(`\nledger LARGER than actual: ${bigger.length}/${rows.length}`);
	for (const row of bigger.slice(0, 6))
		console.log(
			`  ratio ${(row.ledger / row.actual).toFixed(2)}  actual ${row.actual}  ledger ${row.ledger}  pathEntries ${row.entries}  userMsgs ${row.userChars}`,
		);
}
