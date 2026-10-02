import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate, errorType } from "../src/aggregate.js";

const u = (n, c = 1) => ({ input: n, output: n, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n * 2, cost: { total: c } });

test("aggregates sessions, forks, transcripts, tools and warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-stats-"));
  await mkdir(join(root, "project"), { recursive: true });
  const a = { type: "message", id: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: u(10), stopReason: "stop", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] } };
  const header = JSON.stringify({ type: "session", version: 3, id: "s" });
  await writeFile(join(root, "project", "a.jsonl"), [header, JSON.stringify({ type: "message", id: "u", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "NOOO!!! you forgot" }] } }), JSON.stringify(a), "bad json", JSON.stringify({ type: "compaction", id: "c", timestamp: new Date().toISOString(), usage: u(2) })].join("\n"));
  await writeFile(join(root, "project", "fork.jsonl"), [header, JSON.stringify(a), JSON.stringify({ type: "message", id: "e1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", model: "m", usage: u(5), stopReason: "error", errorMessage: "502: {\"error\":\"bad gateway\"}" } })].join("\n"));
  await mkdir(join(root, "project", "subagent-artifacts"));
  await writeFile(join(root, "project", "subagent-artifacts", "x_transcript.jsonl"), JSON.stringify({ recordType: "message", role: "assistant", runId: "r", timestamp: Date.now(), provider: "p", model: "m2", usage: u(3) }));
  const out = await aggregate(root);
  assert.equal(out.totals.all.requests, 4);
  assert.equal(out.totals.all.input, 20);
  assert.equal(out.diagnostics.invalidLines, 1);
  assert.equal(out.behavior.messages, 1);
  assert.ok(out.behavior.anguish > 0);
  assert.equal(out.by.tool.bash.requests, 1);
  assert.deepEqual(out.errors, [["HTTP 502", 1]]);
  assert.equal(out.totals.all.errors, 1);
});

test("errorType buckets raw provider messages", () => {
  assert.equal(errorType("Operation aborted"), "Aborted / terminated");
  assert.equal(errorType("terminated"), "Aborted / terminated");
  assert.equal(errorType("Request timed out."), "Timeout");
  assert.equal(errorType("context_too_large: input exceeds window"), "Context too large");
  assert.equal(errorType("OpenAI API error (502): {}"), "HTTP 502");
  assert.equal(errorType("Upstream stream ended before terminal event"), "Stream interrupted");
  assert.equal(errorType("Connection error."), "Connection error");
  assert.equal(errorType("Cannot read properties of undefined (reading 'x')"), "Cannot read properties of undefined (reading 'x')");
  assert.equal(errorType(""), "Unknown");
});
