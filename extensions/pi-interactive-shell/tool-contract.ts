import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { isEmptySpawnPlaceholder } from "./spawn.ts";
import { TOOL_NAME, toolParameters, type ToolParams } from "./tool-schema.ts";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): never {
	throw new Error(`[INVALID_ARGUMENTS] ${message} No operation was performed.`);
}

/** Migrate only unambiguous pre-action calls; never guess away meaningful values. */
export function prepareToolArguments(raw: unknown): unknown {
	if (!record(raw)) return raw;
	const args = structuredClone(raw);
	if (args.monitorFilter !== undefined) invalid("monitorFilter was removed; use a structured monitor.");
	// Reject dangerous coercions before Pi's schema validator can convert strings to booleans.
	for (const key of ["all", "kill", "background", "listBackground", "monitorStatus", "monitorEvents", "submit"]) {
		if (args[key] != null && typeof args[key] !== "boolean") invalid(`${key} must be boolean.`);
	}
	for (const key of ["command", "sessionId", "attach", "monitorSessionId"]) {
		if (args[key] != null && typeof args[key] !== "string") invalid(`${key} must be a string.`);
	}
	if (args.dismissBackground != null && !["boolean", "string"].includes(typeof args.dismissBackground)) invalid("dismissBackground must be boolean or a session id string.");
	if (record(args.spawn)) {
		for (const key of ["agent", "prompt", "mode"]) {
			if (args.spawn[key] != null && typeof args.spawn[key] !== "string") invalid(`spawn.${key} must be a string.`);
		}
		if (args.spawn.worktree != null && typeof args.spawn.worktree !== "boolean") invalid("spawn.worktree must be boolean.");
	}
	if (args.action !== undefined) return args;
	for (const key of ["command", "sessionId", "attach", "monitorSessionId"]) {
		if (args[key] === "" || args[key] === null) delete args[key];
	}
	if (record(args.spawn)) {
		// Older spawn calls used blank agent/prompt strings for their defaults.
		for (const key of ["agent", "prompt"]) {
			if (typeof args.spawn[key] === "string" && !args.spawn[key].trim()) delete args.spawn[key];
		}
	}
	const hasFileWatch = args.mode === "monitor" && record(args.monitor) && args.monitor.strategy === "file-watch";
	const hasTarget = args.sessionId || args.attach || args.monitorSessionId || args.listBackground || args.dismissBackground || args.monitorStatus || args.monitorEvents;
	if ((args.command || hasTarget || hasFileWatch) && record(args.spawn) && isEmptySpawnPlaceholder(args.spawn)) delete args.spawn;
	if (args.monitorSessionId) {
		if (args.sessionId && args.sessionId !== args.monitorSessionId) invalid("Conflicting sessionId and monitorSessionId.");
		args.sessionId = args.monitorSessionId;
	}
	const actions: ToolParams["action"][] = [];
	if (args.command || args.spawn || hasFileWatch) actions.push("start");
	if (args.attach) {
		if (args.sessionId) invalid("Cannot combine attach and sessionId.");
		args.sessionId = args.attach;
		actions.push("attach");
	}
	if (args.listBackground) actions.push("list");
	if (args.dismissBackground) {
		if (args.sessionId) invalid("Cannot combine dismissBackground and sessionId.");
		if (typeof args.dismissBackground === "string") args.sessionId = args.dismissBackground;
		else if (args.dismissBackground === true) args.all = true;
		else invalid("Invalid dismissBackground selector.");
		actions.push("dismiss");
	}
	if (args.monitorStatus) actions.push("monitor_status");
	if (args.monitorEvents) actions.push("monitor_events");
	if (args.kill) actions.push("kill");
	if (args.background && args.sessionId && !args.attach) {
		actions.push("background");
		delete args.background;
	}
	const hasInput = ["input", "inputKeys", "inputHex", "inputPaste"].some(key => args[key] !== undefined && args[key] !== null) || args.submit === true;
	if (hasInput) actions.push("send");
	if (args.settings !== undefined && args.settings !== null) actions.push("configure");
	if (!actions.length && args.sessionId) actions.push("query");
	if (actions.length !== 1) invalid("Legacy call does not select exactly one action; use an explicit action and only its parameters.");
	args.action = actions[0];
	for (const key of ["kill", "attach", "listBackground", "dismissBackground", "monitorStatus", "monitorEvents", "monitorSessionId"]) delete args[key];
	if (record(args.monitor) && Array.isArray(args.monitor.triggers)) {
		args.monitor.triggers = args.monitor.triggers.map((trigger, index) => {
			if (!record(trigger) || trigger.kind !== undefined || trigger.pattern !== undefined) return trigger;
			const literal = typeof trigger.literal === "string" && trigger.literal.length > 0;
			const regex = typeof trigger.regex === "string" && trigger.regex.length > 0;
			if (literal === regex || [trigger.literal, trigger.regex].some(value => value != null && typeof value !== "string")) {
				invalid(`monitor.triggers[${index}] needs one unambiguous matcher. Use {id:"ready",kind:"literal",pattern:"READY"}.`);
			}
			if (literal && trigger.threshold != null) invalid(`monitor.triggers[${index}].threshold is only allowed for kind=numeric.`);
			const { literal: oldLiteral, regex: oldRegex, ...rest } = trigger;
			return { ...rest, kind: literal ? "literal" : trigger.threshold != null ? "numeric" : "regex", pattern: literal ? oldLiteral : oldRegex };
		});
	}
	return args;
}

const output = ["outputLines", "outputMaxChars", "outputOffset", "drain", "incremental"];
const display = ["mode", "cwd", "reason", "handsFree", "handoffPreview", "handoffSnapshot", "timeout"];
const allowed: Record<ToolParams["action"], readonly string[]> = {
	start: ["command", "spawn", "name", "background", "monitor", ...display],
	query: ["sessionId", ...output],
	send: ["sessionId", "input", "inputKeys", "inputHex", "inputPaste", "submit"],
	configure: ["sessionId", "settings"],
	kill: ["sessionId", ...output],
	background: ["sessionId"],
	attach: ["sessionId", ...display],
	list: [],
	dismiss: ["sessionId", "all"],
	monitor_status: ["sessionId"],
	monitor_events: ["sessionId", "monitorEventLimit", "monitorEventOffset", "monitorSinceEventId", "monitorTriggerId"],
};

/** Single trust boundary: host null normalization, schema checks, then action semantics. */
export function parseToolRequest(raw: unknown): ToolParams {
	const prepared = prepareToolArguments(raw);
	if (!record(prepared)) invalid("Expected an object.");
	const params: ToolParams = validateToolArguments({ name: TOOL_NAME, description: "", parameters: toolParameters }, {
		type: "toolCall", id: "validation", name: TOOL_NAME, arguments: prepared as JsonObject,
	});
	const { action, all, ...runtime } = params;
	for (const key of Object.keys(params)) {
		if (key !== "action" && !allowed[action].includes(key)) invalid(`${key} is not allowed for action=${action}.`);
	}
	if (!["start", "list", "dismiss"].includes(action) && !runtime.sessionId?.trim()) invalid(`action=${action} requires sessionId.`);
	if (action === "start") {
		const fileWatch = runtime.mode === "monitor" && runtime.monitor?.strategy === "file-watch";
		if (fileWatch ? runtime.command !== undefined || runtime.spawn !== undefined : Number(runtime.command !== undefined) + Number(runtime.spawn !== undefined) !== 1) {
			invalid(fileWatch ? "file-watch does not accept command or spawn." : "start requires exactly one of command or spawn.");
		}
		if (runtime.command !== undefined && !runtime.command.trim()) invalid("command cannot be blank.");
		if (runtime.mode === "monitor" && !runtime.monitor) invalid("mode='monitor' requires monitor configuration.");
		if (runtime.mode !== "monitor" && runtime.monitor) invalid("monitor is only allowed in mode=monitor.");
		if (runtime.background && runtime.mode !== "dispatch" && runtime.mode !== "monitor") invalid("background=true requires mode=dispatch or mode=monitor.");
	}
	if (action === "attach" && runtime.mode === "monitor") invalid("Cannot attach in mode=monitor.");
	if (runtime.handsFree && !["hands-free", "dispatch", "monitor"].includes(runtime.mode ?? "interactive")) invalid("handsFree requires a supervised mode.");
	if (action === "send" && ![runtime.input, runtime.inputPaste, runtime.inputKeys, runtime.inputHex].some(value => value !== undefined) && runtime.submit !== true) invalid("send requires input or submit=true.");
	if (action === "configure" && (!runtime.settings || !Object.keys(runtime.settings).length)) invalid("configure requires non-empty settings.");
	if (runtime.drain && (runtime.incremental || runtime.outputOffset !== undefined)) invalid("drain cannot be combined with incremental or outputOffset.");
	if (action === "dismiss") {
		if (Number(runtime.sessionId !== undefined) + Number(all === true) !== 1 || (runtime.sessionId !== undefined && !runtime.sessionId.trim())) invalid("dismiss requires sessionId OR all=true.");
	}
	return params;
}

/** Responses may normalize omitted strictness. Scope the fallback to this tool only. */
export function explicitResponsesStrictness(payload: unknown, api?: string, supportsStrictMode?: boolean): unknown {
	if (supportsStrictMode === false || !["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api ?? "") || !record(payload)) return payload;
	const patchTools = (tools: unknown[]): unknown[] => {
		const patched = tools.map(tool => {
			if (!record(tool)) return tool;
			if (tool.type === "function" && tool.name === TOOL_NAME && tool.strict == null) return { ...tool, strict: false };
			if (tool.type === "namespace" && Array.isArray(tool.tools)) {
				const nested = patchTools(tool.tools);
				if (nested !== tool.tools) return { ...tool, tools: nested };
			}
			return tool;
		});
		return patched.some((tool, index) => tool !== tools[index]) ? patched : tools;
	};
	const tools = Array.isArray(payload.tools) ? patchTools(payload.tools) : payload.tools;
	const input = Array.isArray(payload.input) ? payload.input.map(item => {
		if (!record(item) || !["additional_tools", "tool_search_output"].includes(String(item.type)) || !Array.isArray(item.tools)) return item;
		const nested = patchTools(item.tools);
		return nested === item.tools ? item : { ...item, tools: nested };
	}) : payload.input;
	const inputChanged = Array.isArray(input) && Array.isArray(payload.input) && input.some((item, index) => item !== (payload.input as unknown[])[index]);
	if (tools === payload.tools && !inputChanged) return payload;
	return { ...payload, ...(tools !== payload.tools ? { tools } : {}), ...(inputChanged ? { input } : {}) };
}
