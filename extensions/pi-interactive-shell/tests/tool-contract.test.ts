import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { toolParameters } from "../tool-schema.ts";
import { parseToolRequest, prepareToolArguments } from "../tool-contract.ts";

describe("interactive_shell public contract", () => {
	it("requires an explicit action and does not advertise legacy selectors", () => {
		expect(Check(toolParameters, { sessionId: "shell-1" })).toBe(false);
		expect(Check(toolParameters, { action: "query", sessionId: "shell-1" })).toBe(true);
		expect(Check(toolParameters, { action: "kill", sessionId: "shell-1", kill: true })).toBe(false);
	});

	it("normalizes strict nulls without erasing zero, false, or empty input", () => {
		const args = Object.fromEntries(Object.keys(toolParameters.properties).map(key => [key, null]));
		expect(parseToolRequest({ ...args, action: "query", sessionId: "shell-1", outputOffset: 0 })).toEqual({ action: "query", sessionId: "shell-1", outputOffset: 0 });
		expect(parseToolRequest({ action: "send", sessionId: "shell-1", input: "", submit: false })).toEqual({ action: "send", sessionId: "shell-1", input: "", submit: false });
	});

	it("migrates unambiguous legacy selectors and matchers without mutating history", () => {
		const legacy = { command: "echo READY", mode: "monitor", monitor: { triggers: [{ id: "ready", literal: "READY", regex: "" }] } };
		expect(prepareToolArguments(legacy)).toEqual({ action: "start", command: "echo READY", mode: "monitor", monitor: { triggers: [{ id: "ready", kind: "literal", pattern: "READY" }] } });
		expect(legacy.monitor.triggers[0]).toEqual({ id: "ready", literal: "READY", regex: "" });
		expect(parseToolRequest({ attach: "shell-1" })).toEqual({ action: "attach", sessionId: "shell-1" });
		expect(parseToolRequest({ monitorEvents: true, monitorSessionId: "shell-1" })).toEqual({ action: "monitor_events", sessionId: "shell-1" });
	});

	it.each([
		{ command: "echo READY", sessionId: "shell-1" },
		{ sessionId: "shell-1", kill: true, background: true },
		{ sessionId: "shell-1", settings: { updateInterval: 5000 }, input: "run" },
		{ action: "query", sessionId: "shell-1", settings: { updateInterval: 5000 } },
		{ action: "dismiss", all: true, sessionId: "shell-1" },
		{ action: "start", command: "echo READY", spawn: {} },
		{ action: "dismiss", all: "true" },
		{ action: "start", spawn: { worktree: "true" } },
	])("rejects ambiguous or cross-action arguments: %j", (args) => {
		expect(() => parseToolRequest(args)).toThrow();
	});
});
