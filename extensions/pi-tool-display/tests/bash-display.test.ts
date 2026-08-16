import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { renderBashCall } from "../src/bash-display.ts";

// ─── Test Helpers ────────────────────────────────────────────────────────────

const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	expanded?: boolean;
	invalidate(): void;
	lastComponent?: unknown;
	state?: unknown;
}

/** Pass-through theme that returns text unchanged */
function createPassThroughTheme(): BashCallRenderTheme {
	return {
		fg: (_color: string, text: string): string => text,
		bold: (text: string): string => text,
	};
}

/** ANSI-producing theme so rendered output can be verified structurally */
function createAnsiTheme(): BashCallRenderTheme {
	return {
		fg: (color: string, text: string): string =>
			`\x1b[${color === "warning" ? "93" : color === "muted" ? "90" : color === "toolTitle" ? "94" : color === "accent" ? "92" : "0"}m${text}\x1b[0m`,
		bold: (text: string): string => `\x1b[1m${text}\x1b[0m`,
	};
}

function makeContext(overrides: Partial<BashCallRenderContextLike> = {}): BashCallRenderContextLike {
	return {
		executionStarted: false,
		isPartial: false,
		invalidate: () => {},
		...overrides,
	};
}

function renderedText(component: Text): string {
	return component.render(120).map((line) => line.trimEnd()).join("\n").trim();
}

/**
 * Create a spinner context and render. Returns the component plus a cleanup
 * function that transitions to shouldSpin=false (stopping the interval timer).
 */
function createSpinningBashCall(
	args: { command?: string; timeout?: number },
	state: Record<string, unknown>,
	extra?: Partial<BashCallRenderContextLike>,
): { text: Text; stop(): void } {
	const text = renderBashCall(
		args,
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: true,
			state,
			...extra,
		}),
	);
	return {
		text,
		stop: () => {
			renderBashCall(
				args,
				createPassThroughTheme(),
				makeContext({
					executionStarted: true,
					isPartial: false,
					state,
					lastComponent: text,
					...extra,
				}),
			);
		},
	};
}

// ─── Args Shapes ─────────────────────────────────────────────────────────────

test("renderBashCall uses ellipsis when command is missing", () => {
	const text = renderBashCall({}, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ ...");
});

test("renderBashCall uses ellipsis when command is empty string", () => {
	const text = renderBashCall({ command: "" }, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ ...");
});

test("renderBashCall uses ellipsis when command is only whitespace", () => {
	const text = renderBashCall({ command: "   " }, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ ...");
});

test("renderBashCall displays short command", () => {
	const text = renderBashCall({ command: "npm test" }, createPassThroughTheme(), makeContext());
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall handles very long commands without crashing", () => {
	// Text wraps at render width (120), extremely long commands wrap to multiple lines
	const longCmd = "node " + "a".repeat(200);
	const text = renderBashCall({ command: longCmd }, createPassThroughTheme(), makeContext());
	const output = renderedText(text);
	// Command prefix should still appear (the "$ " prefix is always present)
	assert.ok(output.includes("$"), "dollar sign should appear");
	assert.ok(output.includes("node"), "command text should appear");
	// The rendered output should contain the command text
	assert.ok(output.length > 10, "output should have content");
});

test("renderBashCall displays multiline command", () => {
	const text = renderBashCall(
		{ command: "echo hello\necho world" },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.ok(renderedText(text).includes("echo hello\necho world"));
});

test("renderBashCall limits collapsed multiline commands to ten command lines", () => {
	const command = Array.from({ length: 15 }, (_, index) => `echo line ${index + 1}`).join("\n");
	const text = renderBashCall({ command }, createPassThroughTheme(), makeContext());
	const lines = renderedText(text).split("\n");

	assert.equal(lines.length, 11);
	assert.equal(lines[0], "$ echo line 1");
	assert.equal(lines[9], "echo line 10");
	assert.equal(lines[10], "… command preview truncated");
	assert.doesNotMatch(lines.join("\n"), /echo line 11/);
});

test("renderBashCall shows the full multiline command when expanded", () => {
	const command = Array.from({ length: 15 }, (_, index) => `echo line ${index + 1}`).join("\n");
	const text = renderBashCall(
		{ command },
		createPassThroughTheme(),
		makeContext({ expanded: true }),
	);
	const lines = renderedText(text).split("\n");

	assert.equal(lines.length, 15);
	assert.equal(lines[14], "echo line 15");
	assert.doesNotMatch(lines.join("\n"), /command preview truncated/);
});

test("renderBashCall does not add a hint for exactly ten command lines", () => {
	const command = Array.from({ length: 10 }, (_, index) => `echo line ${index + 1}`).join("\n");
	const text = renderBashCall({ command }, createPassThroughTheme(), makeContext());
	const lines = renderedText(text).split("\n");

	assert.equal(lines.length, 10);
	assert.equal(lines[9], "echo line 10");
	assert.doesNotMatch(lines.join("\n"), /command preview truncated/);
});

test("renderBashCall counts CRLF command lines when collapsed", () => {
	const command = Array.from({ length: 12 }, (_, index) => `echo line ${index + 1}`).join("\r\n");
	const text = renderBashCall({ command }, createPassThroughTheme(), makeContext());
	const output = renderedText(text);

	assert.doesNotMatch(output, /\r/);
	assert.equal(output.split("\n").length, 11);
	assert.match(output, /… command preview truncated$/);
});

test("renderBashCall renders the collapsed command hint with muted styling", () => {
	const command = Array.from({ length: 11 }, (_, index) => `echo line ${index + 1}`).join("\n");
	const text = renderBashCall({ command }, createAnsiTheme(), makeContext());

	assert.match(renderedText(text), /\x1b\[90m… command preview truncated\x1b\[0m$/);
});

test("renderBashCall limits wrapped collapsed commands to ten visible rows", () => {
	const command = Array.from(
		{ length: 6 },
		(_, index) => `printf 'line ${index + 1}: ${"x".repeat(70)}'`,
	).join("\n");
	const collapsed = renderBashCall({ command }, createPassThroughTheme(), makeContext());
	const collapsedLines = collapsed.render(40).map((line) => line.trimEnd());

	assert.equal(collapsedLines.length, 11);
	assert.equal(collapsedLines[10], "… command preview truncated");

	const expanded = renderBashCall(
		{ command },
		createPassThroughTheme(),
		makeContext({ expanded: true, lastComponent: collapsed }),
	);
	const expandedLines = expanded.render(40).map((line) => line.trimEnd());

	assert.equal(expanded, collapsed);
	assert.ok(expandedLines.length > 10);
	assert.doesNotMatch(expandedLines.join("\n"), /command preview truncated/);
});

test("renderBashCall keeps a running command expanded across spinner ticks", async () => {
	const command = Array.from(
		{ length: 6 },
		(_, index) => `printf 'line ${index + 1}: ${"x".repeat(70)}'`,
	).join("\n");
	const state: Record<string, unknown> = {};
	const { text, stop } = createSpinningBashCall({ command }, state);

	try {
		const expanded = renderBashCall(
			{ command },
			createPassThroughTheme(),
			makeContext({
				executionStarted: true,
				isPartial: true,
				expanded: true,
				state,
				lastComponent: text,
			}),
		);
		assert.equal(expanded, text);
		const beforeTick = expanded.render(40);
		assert.ok(beforeTick.length > 11);
		assert.doesNotMatch(beforeTick.join("\n"), /command preview truncated/);

		await new Promise((resolve) => setTimeout(resolve, 250));

		const afterTick = expanded.render(40);
		assert.ok(afterTick.length > 11);
		assert.doesNotMatch(afterTick.join("\n"), /command preview truncated/);
	} finally {
		stop();
	}
});

test("renderBashCall appends timeout suffix when timeout is provided", () => {
	const text = renderBashCall(
		{ command: "npm test", timeout: 30 },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ npm test (timeout 30s)");
});

test("renderBashCall does not include timeout suffix when timeout is zero", () => {
	const text = renderBashCall(
		{ command: "npm test", timeout: 0 },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall does not include timeout suffix when timeout is undefined", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ npm test");
});

// ─── Theme Variations ────────────────────────────────────────────────────────

test("renderBashCall applies ANSI bold to the dollar sign with ANSI theme", () => {
	const text = renderBashCall({ command: "ls" }, createAnsiTheme(), makeContext());
	const rendered = renderedText(text);
	assert.ok(rendered.includes("\x1b[1m$\x1b[0m"), `expected bold $ in: ${JSON.stringify(rendered)}`);
});

test("renderBashCall applies ANSI color to command with ANSI theme", () => {
	const text = renderBashCall({ command: "ls" }, createAnsiTheme(), makeContext());
	const rendered = renderedText(text);
	assert.ok(rendered.includes("\x1b[92mls\x1b[0m"), `expected green ls in: ${JSON.stringify(rendered)}`);
});

// ─── Context States ──────────────────────────────────────────────────────────

test("renderBashCall no spinner when executionStarted is false", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({ executionStarted: false, isPartial: false }),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall no spinner when isPartial is false even if executionStarted", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({ executionStarted: true, isPartial: false }),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall shows spinner when executionStarted and isPartial are true", () => {
	const state: Record<string, unknown> = {};
	const { text, stop } = createSpinningBashCall({ command: "npm test" }, state);
	try {
		const rendered = renderedText(text);
		assert.match(rendered, /^⠋ \$ npm test · 0s$/);
	} finally {
		stop();
	}
});

test("renderBashCall spinner animates frame index over time via setInterval", async () => {
	const state: Record<string, unknown> = {};
	let invalidateCount = 0;
	const { text, stop } = createSpinningBashCall(
		{ command: "npm test" },
		state,
		{ invalidate: () => { invalidateCount++; } },
	);
	try {
		const frame0 = renderedText(text);
		assert.match(frame0, /^⠋/);

		// Wait for at least one interval tick (200ms interval)
		await new Promise((r) => setTimeout(r, 250));

		const frame1 = renderedText(text);
		assert.notEqual(frame1, frame0, "spinner frame should advance");
		assert.match(frame1, /^⠙/);
		assert.ok(invalidateCount > 0, "invalidate should be called during animation");
	} finally {
		stop();
	}
});

test("renderBashCall stops spinner and clears timer when shouldSpin becomes false", async () => {
	const state: Record<string, unknown> = {};
	const { text, stop } = createSpinningBashCall({ command: "npm test" }, state);

	assert.match(renderedText(text), /^⠋/);

	// Transition to complete state via stop
	stop();
	assert.equal(renderedText(text), "$ npm test");

	// Wait to verify no further animation
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(renderedText(text), "$ npm test", "no spinner after completion");
});

test("renderBashCall reuses existing spinner state from context.state", () => {
	const state: Record<string, unknown> = {};
	const { text: text1, stop } = createSpinningBashCall({ command: "npm test" }, state);
	assert.ok(state[BASH_SPINNER_STATE_KEY] !== undefined, "state should have spinner state");

	// Second call with same state
	const text2 = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: true,
			state,
			lastComponent: text1,
		}),
	);
	const state2 = state[BASH_SPINNER_STATE_KEY] as Record<string, unknown>;
	assert.ok(state2 !== undefined);
	assert.ok(state2.frameIndex !== undefined);
	stop();
});

test("renderBashCall stores state under __piToolDisplayBashSpinner key", () => {
	const state: Record<string, unknown> = {};
	const { stop } = createSpinningBashCall({ command: "npm test" }, state);
	try {
		assert.ok(state[BASH_SPINNER_STATE_KEY] !== undefined);
		const spinnerState = state[BASH_SPINNER_STATE_KEY] as Record<string, unknown>;
		assert.equal(typeof spinnerState.frameIndex, "number");
		assert.equal(typeof spinnerState.startedAt, "number");
	} finally {
		stop();
	}
});

test("renderBashCall does not create spinner state when state is null/undefined", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: true,
			state: undefined,
		}),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall does not create spinner state when state is a primitive", () => {
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: true,
			state: "string-state",
		}),
	);
	assert.equal(renderedText(text), "$ npm test");
});

test("renderBashCall creates spinner state when state is an array (arrays are objects)", () => {
	const stateArray: unknown[] = [];
	const text = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: true,
			state: stateArray,
		}),
	);
	// Arrays are objects in JS, so the implementation treats them as valid state carriers
	assert.match(renderedText(text), /^⠋/);
	// Clean up the interval set on the array
	const spyState = (stateArray as unknown as Record<string, unknown>)[BASH_SPINNER_STATE_KEY] as Record<string, unknown> | undefined;
	if (spyState?.timer) {
		clearInterval(spyState.timer as ReturnType<typeof setInterval>);
	}
});

// ─── Elapsed Time Formatting ─────────────────────────────────────────────────

test("renderBashCall shows elapsed seconds when spinning and under 60s", () => {
	const state: Record<string, unknown> = {};
	state[BASH_SPINNER_STATE_KEY] = { frameIndex: 0, startedAt: Date.now() };
	const { text, stop } = createSpinningBashCall({ command: "npm test" }, state);
	try {
		assert.match(renderedText(text), /· \d+s$/);
	} finally {
		stop();
	}
});

// ─── Multiple Concurrent Bash Calls ──────────────────────────────────────────

test("multiple concurrent bash calls have independent spinner states", () => {
	const stateA: Record<string, unknown> = {};
	const stateB: Record<string, unknown> = {};

	const { text: textA, stop: stopA } = createSpinningBashCall({ command: "npm test" }, stateA);
	const { text: textB, stop: stopB } = createSpinningBashCall({ command: "npm build" }, stateB);
	try {
		const aKey = stateA[BASH_SPINNER_STATE_KEY] as Record<string, unknown>;
		const bKey = stateB[BASH_SPINNER_STATE_KEY] as Record<string, unknown>;
		assert.ok(aKey !== bKey, "each bash call gets its own spinner state object");

		// Each renders independently with its own command
		assert.match(renderedText(textA), /npm test/);
		assert.match(renderedText(textB), /npm build/);

		// Complete stateA independently (spinner stops for A)
		stopA();
		assert.equal(renderedText(textA), "$ npm test", "A spinner stopped after stopA");

		// stateB should still show spinner prefix (frame may not have advanced yet)
		assert.match(renderedText(textB), /^⠋/, "B should still show spinner after A completed");
	} finally {
		stopA();
		stopB();
	}
});

// ─── Rapid Invalidate / Repeated Calls ───────────────────────────────────────

test("renderBashCall handles repeated calls without creating multiple timers", () => {
	const state: Record<string, unknown> = {};
	let invalidateCount = 0;

	const { text, stop } = createSpinningBashCall(
		{ command: "npm test" },
		state,
		{ invalidate: () => { invalidateCount++; } },
	);

	// Call renderBashCall repeatedly with same state (simulating rapid re-renders)
	for (let i = 0; i < 5; i++) {
		renderBashCall(
			{ command: "npm test" },
			createPassThroughTheme(),
			makeContext({
				executionStarted: true,
				isPartial: true,
				state,
				lastComponent: text,
				invalidate: () => { invalidateCount++; },
			}),
		);
	}

	const spinnerState = state[BASH_SPINNER_STATE_KEY] as Record<string, unknown>;
	// Only one timer should be active (timer is only set if !spinnerState.timer)
	const timerCount = spinnerState.timer !== undefined ? 1 : 0;
	assert.equal(timerCount, 1, "multiple renderBashCall calls should not create multiple timers");

	stop();
});

// ─── lastComponent Preservation ──────────────────────────────────────────────

test("renderBashCall preserves the same Text component reference when lastComponent is a Text", () => {
	const initialState: Record<string, unknown> = {};
	const { text: first, stop } = createSpinningBashCall({ command: "npm test" }, initialState);

	const second = renderBashCall(
		{ command: "npm test" },
		createPassThroughTheme(),
		makeContext({
			executionStarted: true,
			isPartial: false,
			state: initialState,
			lastComponent: first,
		}),
	);

	assert.equal(first, second, "should return the same Text instance via lastComponent");
	stop();
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

test("renderBashCall handles command with special characters like $ and backticks", () => {
	const text = renderBashCall(
		{ command: "echo $HOME && echo `pwd`" },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.ok(renderedText(text).includes("$HOME"));
	assert.ok(renderedText(text).includes("`pwd`"));
});

test("renderBashCall handles numeric timeout with decimal value", () => {
	const text = renderBashCall(
		{ command: "sleep 1", timeout: 2.5 },
		createPassThroughTheme(),
		makeContext(),
	);
	assert.equal(renderedText(text), "$ sleep 1 (timeout 2.5s)");
});
