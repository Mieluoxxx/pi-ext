import { describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { createFauxCore, normalizeContext } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import { explicitResponsesStrictness, parseToolRequest } from "../tool-contract.ts";
import { TOOL_DESCRIPTION, TOOL_NAME, toolParameters } from "../tool-schema.ts";

const tool = { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: toolParameters, constrainedSampling: { type: "json_schema", strict: "prefer" } as const };

describe("provider contract", () => {
	it("round-trips strict required/nullable fields through the real Pi validator", () => {
		const [wire] = convertResponsesTools([tool], { supportsStrictMode: true }) as any[];
		expect(wire.strict).toBe(true);
		const request = { ...Object.fromEntries(Object.keys(toolParameters.properties).map(key => [key, null])), action: "query", sessionId: "shell-1", outputOffset: 0 };
		expect(Check(wire.parameters, request)).toBe(true);
		expect(parseToolRequest(request)).toEqual({ action: "query", sessionId: "shell-1", outputOffset: 0 });
		const trigger = wire.parameters.properties.monitor.anyOf[0].properties.triggers.items;
		expect(Check(trigger, { id: "ready", kind: "literal", pattern: "READY", cooldownMs: null, threshold: null })).toBe(true);
		expect(Check(trigger, { id: "ready", literal: "READY", regex: "" })).toBe(false);
	});

	it("captures the real gateway request builder with explicit strict=false without network access", async () => {
		const model = { ...createFauxCore({}).getModel(), api: "openai-responses" as const, provider: "fixture-gateway", baseUrl: "http://127.0.0.1:1/v1", compat: {} };
		const fetch = vi.fn(async () => { throw new Error("Network forbidden"); });
		let captured: any;
		await stream(model, normalizeContext({ messages: [
			{ role: "system", content: "fixture", toolsAdded: [tool], timestamp: 0 },
			{ role: "user", content: "fixture", timestamp: 0 },
		] }), { apiKey: "fixture", fetch, onPayload(payload) {
			captured = explicitResponsesStrictness(payload, model.api);
			throw new Error("Captured before network");
		} }).result();
		expect(captured.tools[0].strict).toBe(false);
		expect(captured.tools[0].parameters.required).toEqual(["action"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("handles namespace/search declarations without rewriting other tools, user data, or explicit capabilities", () => {
		const own = { type: "function", name: TOOL_NAME, parameters: {}, strict: null };
		const other = { ...own, name: "other" };
		const user = { role: "user", content: [{ tools: [own] }] };
		const payload = { tools: [{ type: "namespace", name: "functions", tools: [own, other] }], input: [user, { type: "tool_search_output", tools: [own] }] };
		const result = explicitResponsesStrictness(payload, "openai-codex-responses") as any;
		expect(result.tools[0].tools[0].strict).toBe(false);
		expect(result.tools[0].tools[1]).toBe(other);
		expect(result.input[0]).toBe(user);
		expect(result.input[1].tools[0].strict).toBe(false);
		expect(explicitResponsesStrictness(payload, "openai-responses", false)).toBe(payload);
		expect(explicitResponsesStrictness(payload, "google-generative-ai")).toBe(payload);
	});
});
