#!/usr/bin/env node
// Offline advisor cache baseline over pi session logs.
// Usage: node advisor-usage-baseline.mjs [focusModel] [--since=YYYY-MM-DD] [--sessions=DIR]
// Older details.usage only contains the final retry; new records aggregate all attempts.
// Costs use reported usage and exclude any unreported upstream charges.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const focus = args.find((a) => !a.startsWith("--")) ?? "cpa-openai-responses:gpt-6-astra";
const since = flag("since") ? Date.parse(flag("since")) : 0;
if (!Number.isFinite(since)) throw new Error("Invalid --since date");
const root = flag("sessions") ?? path.join(process.env.HOME, ".pi/agent/sessions");

const files = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (p.endsWith(".jsonl")) files.push(p);
	}
})(root);

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const quant = (xs, q) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor(q * (s.length - 1))] : NaN;
};

const modelId = (key) => key?.slice(key.indexOf(":") + 1);
const sameAdvisorModel = (call) => typeof call.model === "string" && modelId(call.execModel) === modelId(call.model);
const calls = [];
const warming = [];
const skipped = [];
const exec = {};
let sessionCount = 0;
for (const file of files) {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	if (!lines.some((l) => l.includes('"advisorModel"') || l.includes('"advisor-cache-warming"'))) continue;
	sessionCount++;
	const entries = [];
	const byId = new Map();
	for (const l of lines) {
		if (!l) continue;
		try {
			const e = JSON.parse(l);
			entries.push(e);
			if (e.id) byId.set(e.id, e);
		} catch {}
	}
	let prev;
	let compactions = 0;
	let execTurns = 0;
	let lastExec;
	let lastExecT;
	for (const e of entries) {
		const t = Date.parse(e.timestamp);
		if (e.type === "compaction") compactions++;
		if (t >= since && e.type === "usage" && e.kind === "advisor-cache-warming") {
			warming.push({ model: `${e.provider}:${e.model}`, usage: e.usage });
		}
		const m = e.message;
		if (e.type !== "message" || !m) continue;
		if (m.role === "assistant" && m.usage) {
			execTurns++;
			lastExec = { key: `${m.provider}:${m.model}`, prompt: m.usage.input + m.usage.cacheRead };
			if (t >= since) {
				exec[lastExec.key] ??= { n: 0, input: 0, cacheRead: 0, gaps: {} };
				const a = exec[lastExec.key];
				a.n++;
				a.input += m.usage.input;
				a.cacheRead += m.usage.cacheRead;
				if (lastExecT !== undefined) {
					const g = (t - lastExecT) / 1000;
					const b = g < 300 ? "<5m" : g < 3600 ? "5m-1h" : ">1h";
					a.gaps[b] ??= { n: 0, hit: 0 };
					const x = a.gaps[b];
					x.n++;
					if (m.usage.cacheRead > 0) x.hit++;
				}
			}
			lastExecT = t;
		}
		if (m.role !== "toolResult" || m.toolName !== "advisor") continue;
		if (t >= since && m.details?.skipped) skipped.push(m.details.errorMessage ?? "unspecified");
		const u = m.usage ?? m.details?.usage;
		if (!u) continue;
		const lastUsage = m.details?.attempts?.at(-1)?.usage ?? u;
		// parentId points at a sibling toolResult when tools ran in parallel, so walk up
		// to the assistant message that actually issued this advisor() call.
		let caller;
		for (let id = e.parentId, hops = 0; id && hops < 64; hops++) {
			const pe = byId.get(id);
			const pm = pe?.message;
			if (pm?.role === "assistant") {
				if (pm.content.some((c) => c.type === "toolCall" && c.id === m.toolCallId)) caller = pm;
				break;
			}
			id = pe?.parentId;
		}
		const rest = caller ? caller.content.filter((c) => !(c.type === "toolCall" && c.name === "advisor")) : undefined;
		const tail =
			rest === undefined ? "(unknown)" : [...new Set(rest.map((c) => c.type))].sort().join("+") || "(none)";
		const call = {
			file,
			t,
			model: m.details.advisorModel,
			execModel: lastExec?.key,
			execPrompt: lastExec?.prompt ?? 0,
			input: u.input,
			cacheRead: u.cacheRead,
			cacheWrite: u.cacheWrite ?? 0,
			cost: u.cost?.total ?? 0,
			prompt: lastUsage.input + lastUsage.cacheRead + (lastUsage.cacheWrite ?? 0),
			estimate: m.details?.estimate,
			trimmed: m.details?.context?.trimmed,
			ledgerVersion: m.details?.request?.ledgerVersion,
			rounds: m.details?.rounds?.length ?? 0,
			toolsUsed: (m.details?.rounds ?? []).map((r) => r.tool),
			budgetExhausted: !!m.details?.budgetExhausted,
			attempts: m.details?.attempts?.length ?? 1,
			nth: prev ? prev.nth + 1 : 1,
			gapSec: prev ? (t - prev.t) / 1000 : undefined,
			turnsBetween: prev ? execTurns - prev.execTurns : undefined,
			compactionsBetween: prev ? compactions : undefined,
			prevNudge: prev?.nudge,
			prevPrompt: prev?.prompt,
			nudge: rest === undefined ? undefined : rest.length > 0,
			tail,
			texts: (rest ?? []).filter((c) => c.type === "text" && c.text.trim()).map((c) => c.text.trim().length),
		};
		prev = { t, nth: call.nth, execTurns, nudge: call.nudge, prompt: call.prompt };
		compactions = 0;
		if (t >= since) calls.push(call);
	}
}

console.log(
	`# sessions with advisor: ${sessionCount}; advisor calls with usage: ${calls.length}${since ? ` (since ${flag("since")})` : ""}\n`,
);

console.log("## per advisor model");
console.log("model | calls | cache share | follow-ups hit | cacheWrite Σ | cost $");
const byModel = Object.groupBy(calls, (c) => c.model);
for (const [model, cs] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
	const s = cs.reduce(
		(a, c) => ({ i: a.i + c.input, cr: a.cr + c.cacheRead, cw: a.cw + c.cacheWrite, cost: a.cost + c.cost }),
		{ i: 0, cr: 0, cw: 0, cost: 0 },
	);
	const f = cs.filter((c) => c.nth > 1);
	console.log(
		`${model} | ${cs.length} | ${pct(s.cr, s.i + s.cr + s.cw)} | ${f.filter((c) => c.cacheRead > 0).length}/${f.length} | ${s.cw} | ${s.cost.toFixed(2)}`,
	);
}
const consultationCost = calls.reduce((a, c) => a + c.cost, 0);
const warmingCost = warming.reduce((a, c) => a + c.usage.cost.total, 0);
console.log(
	`consultation cost $${consultationCost.toFixed(2)}; warming cost $${warmingCost.toFixed(2)} (${warming.length} refreshes)`,
);
console.log(`total advisor cost $${(consultationCost + warmingCost).toFixed(2)}\n`);
console.log(
	"skipped consultations:",
	Object.fromEntries(
		Object.entries(Object.groupBy(skipped, (reason) => reason)).map(([reason, rows]) => [reason, rows.length]),
	),
);
const measured = calls.filter((c) => c.estimate?.costUsd > 0);
console.log(
	`trimmed consultations: ${calls.filter((c) => c.trimmed).length}; retries: ${calls.filter((c) => c.attempts > 1).length}`,
);
console.log(
	`actual/estimated call cost p50/p90: ${quant(
		measured.map((c) => c.cost / (c.estimate.costUsd * c.attempts)),
		0.5,
	)} / ${quant(
		measured.map((c) => c.cost / (c.estimate.costUsd * c.attempts)),
		0.9,
	)}`,
);

const fc = calls.filter((c) => c.model === focus);
console.log(`## focus: ${focus} (${fc.length} calls)`);
const first = fc.filter((c) => c.nth === 1);
console.log(
	`first-in-session: ${first.length}, hit ${first.filter((c) => c.cacheRead > 0).length}, median prompt ${quant(
		first.map((c) => c.prompt),
		0.5,
	)}`,
);
console.log(
	`prompt tokens p50/p90/max: ${quant(
		fc.map((c) => c.prompt),
		0.5,
	)} / ${quant(
		fc.map((c) => c.prompt),
		0.9,
	)} / ${quant(
		fc.map((c) => c.prompt),
		1,
	)}`,
);
const big = fc.filter((c) => c.prompt > 300_000);
const fcCost = fc.reduce((a, c) => a + c.cost, 0);
console.log(
	`calls >300k: ${big.length}/${fc.length}, cost share ${pct(
		big.reduce((a, c) => a + c.cost, 0),
		fcCost,
	)}`,
);
console.log(`calls per session chain: ${(fc.length / Math.max(first.length, 1)).toFixed(1)}`);

console.log("\ngap bucket | n | hit | cache share");
const follow = fc.filter((c) => c.nth > 1);
for (const [lo, hi, label] of [
	[0, 60, "<1m"],
	[60, 300, "1-5m"],
	[300, 600, "5-10m"],
	[600, 1800, "10-30m"],
	[1800, 3600, "30-60m"],
	[3600, Infinity, ">1h"],
]) {
	const g = follow.filter((c) => c.gapSec >= lo && c.gapSec < hi);
	const s = g.reduce((a, c) => ({ i: a.i + c.input, cr: a.cr + c.cacheRead }), { i: 0, cr: 0 });
	console.log(
		`${label} | ${g.length} | ${pct(g.filter((c) => c.cacheRead > 0).length, g.length)} | ${pct(s.cr, s.i + s.cr)}`,
	);
}

const short = follow.filter((c) => c.gapSec < 600 && c.compactionsBetween === 0);
const dist = { zero: 0, small: 0, partial: 0, big: 0 };
for (const c of short) {
	if (c.cacheRead === 0) dist.zero++;
	else if (c.cacheRead < 8000) dist.small++;
	else if (c.cacheRead / c.prompt < 0.7) dist.partial++;
	else dist.big++;
}
console.log(
	`\n<10m, no compaction (n=${short.length}) cacheRead: zero ${dist.zero}, <8k ${dist.small}, partial ${dist.partial}, >=70% ${dist.big}`,
);

const afterNudge = short.filter((c) => c.prevNudge === true);
const afterStable = short.filter((c) => c.prevNudge === false);
console.log(
	`next-call hit (<10m): prev nudge-tail ${afterNudge.filter((c) => c.cacheRead > 0).length}/${afterNudge.length}, prev stable-tail ${afterStable.filter((c) => c.cacheRead > 0).length}/${afterStable.length}`,
);
// Restrict to sessions containing both tail shapes so per-session routing/config cannot explain the gap.
const mixed = Object.values(Object.groupBy(short, (c) => c.file)).filter(
	(cs) => cs.some((c) => c.prevNudge === true) && cs.some((c) => c.prevNudge === false),
);
const mixedHit = (want) => {
	const xs = mixed.flat().filter((c) => c.prevNudge === want);
	return `${xs.filter((c) => c.cacheRead > 0).length}/${xs.length}`;
};
console.log(
	`  within sessions having both (${mixed.length}): prev nudge-tail ${mixedHit(true)}, prev stable-tail ${mixedHit(false)}`,
);
const known = fc.filter((c) => c.nudge !== undefined);
console.log(
	`nudge-tail share: ${known.filter((c) => c.nudge).length}/${known.length} (caller not found: ${fc.length - known.length})`,
);

// Upstream lookup walks back only ~20 eligible message endings, so hits should fall off
// once the executor runs many turns between consultations even with a stable tail.
console.log("executor turns between (<30m, no compaction) | prev nudge-tail hit | prev stable-tail hit");
const mid = follow.filter((c) => c.gapSec < 1800 && c.compactionsBetween === 0);
for (const [lo, hi, label] of [
	[0, 6, "1-5"],
	[6, 11, "6-10"],
	[11, 21, "11-20"],
	[21, 41, "21-40"],
	[41, Infinity, ">40"],
]) {
	const g = mid.filter((c) => c.turnsBetween >= lo && c.turnsBetween < hi);
	const hit = (xs) => `${xs.filter((c) => c.cacheRead > 0).length}/${xs.length}`;
	console.log(
		`${label} | ${hit(g.filter((c) => c.prevNudge === true))} | ${hit(g.filter((c) => c.prevNudge === false))}`,
	);
}

const comp = follow.filter((c) => c.compactionsBetween > 0);
console.log(
	`after compaction: ${comp.length}, hit ${comp.filter((c) => c.cacheRead > 0).length}, median gap ${Math.round(
		quant(
			comp.map((c) => c.gapSec),
			0.5,
		) ?? 0,
	)}s`,
);

let recoverable = 0;
let recoverableN = 0;
for (const c of follow) {
	if (c.prevNudge !== true || c.compactionsBetween !== 0 || c.gapSec >= 1800) continue;
	const reusable = Math.min(c.prevPrompt, c.prompt);
	if (c.cacheRead >= 0.5 * reusable) continue;
	recoverableN++;
	recoverable += ((reusable - c.cacheRead) * 9) / 1e6;
}
console.log(
	`nudge-tail misses (<30m, no compaction, <50% reuse): ${recoverableN}, ≈$${recoverable.toFixed(0)} at input 10 / cacheRead 1 per M`,
);

const same = fc.filter(sameAdvisorModel);
console.log(
	`historical same-model calls: ${same.length}; avoidable reported cost $${same.reduce((sum, c) => sum + c.cost, 0).toFixed(2)}`,
);

// Ledger rollout: pre-ledger records carry no request.ledgerVersion, so the two
// formats can be compared directly in one report.
const byLedger = Object.groupBy(calls, (c) => (c.ledgerVersion === undefined ? "pre-ledger" : `ledger v${c.ledgerVersion}`));
console.log("\n## by payload format");
console.log("format | calls | prompt p50 | prompt p90 | cache share | cost $");
for (const [format, cs] of Object.entries(byLedger)) {
	const s = cs.reduce((a, c) => ({ i: a.i + c.input, cr: a.cr + c.cacheRead, cost: a.cost + c.cost }), { i: 0, cr: 0, cost: 0 });
	console.log(
		`${format} | ${cs.length} | ${quant(cs.map((c) => c.prompt), 0.5)} | ${quant(cs.map((c) => c.prompt), 0.9)} | ${pct(s.cr, s.i + s.cr)} | ${s.cost.toFixed(2)}`,
	);
}

const withTools = calls.filter((c) => c.rounds > 0);
if (withTools.length) {
	const toolCounts = {};
	for (const c of calls) for (const t of c.toolsUsed) toolCounts[t] = (toolCounts[t] ?? 0) + 1;
	console.log(
		`\nconsultations using tools: ${withTools.length}/${calls.length}; rounds p50/p90 ${quant(withTools.map((c) => c.rounds), 0.5)}/${quant(withTools.map((c) => c.rounds), 0.9)}; hit round budget: ${calls.filter((c) => c.budgetExhausted).length}`,
	);
	console.log("tool use:", toolCounts);
}

console.log("\n## trailing executor content before advisor() (all models)");
const tails = Object.groupBy(calls, (c) => c.tail);
console.log(Object.fromEntries(Object.entries(tails).map(([k, v]) => [k, v.length])));
const textLens = calls.flatMap((c) => c.texts);
console.log(`trailing text chars p50/p90: ${quant(textLens, 0.5)} / ${quant(textLens, 0.9)}`);
const pairs = Object.groupBy(calls, (c) => (sameAdvisorModel(c) ? "same" : "different"));
console.log(`advisor model == executor model: ${pairs.same?.length ?? 0}, different: ${pairs.different?.length ?? 0}`);

console.log("\n## executor in the same sessions");
for (const [k, a] of Object.entries(exec)
	.sort((x, y) => y[1].n - x[1].n)
	.slice(0, 6)) {
	const gaps = Object.entries(a.gaps)
		.map(([b, x]) => `${b} ${pct(x.hit, x.n)}`)
		.join(", ");
	console.log(`${k} | ${a.n} | cache share ${pct(a.cacheRead, a.input + a.cacheRead)} | ${gaps}`);
}
