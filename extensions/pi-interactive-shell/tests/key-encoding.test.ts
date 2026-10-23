import { describe, expect, it } from "vitest";
import { toLegacyInput, translateInput } from "../key-encoding.ts";

describe("translateInput", () => {
	it("encodes named keys and modifiers", () => {
		expect(translateInput({ keys: ["up", "shift+tab", "ctrl+c", "m-x"] })).toBe("\x1b[A\x1b[Z\x03\x1bx");
	});

	it("emits paste before trailing keys so pasted input can be submitted afterward", () => {
		expect(translateInput({
			text: "hi",
			keys: ["enter"],
			hex: ["0x21"],
			paste: "body",
		})).toBe("!hi\x1b[200~body\x1b[201~\r");
	});

	it("supports xterm modifier encoding for CSI keys", () => {
		expect(translateInput({ keys: ["ctrl+alt+delete", "s-up"] })).toBe("\x1b[3;7~\x1b[1;2A");
	});
});

describe("toLegacyInput", () => {
	it("rewrites Kitty CSI-u key reports to legacy bytes", () => {
		expect(toLegacyInput("\x1b[103;5u")).toBe("\x07"); // ctrl+g
		expect(toLegacyInput("\x1b[97u\x1b[13u\x1b[27u")).toBe("a\r\x1b");
		expect(toLegacyInput("\x1b[27;5;103~")).toBe("\x07"); // modifyOtherKeys ctrl+g
	});

	it("leaves legacy input and unknown reports alone", () => {
		expect(toLegacyInput("ls -la\r")).toBe("ls -la\r");
		expect(toLegacyInput("\x1b[A\x1b[1;5C")).toBe("\x1b[A\x1b[1;5C");
		expect(toLegacyInput("\x1b[200~hi\x1b[201~")).toBe("\x1b[200~hi\x1b[201~");
	});

	it("never rewrites inside a bracketed paste", () => {
		expect(toLegacyInput("\x1b[200~\x1b[97u\x1b[201~")).toBe("\x1b[200~\x1b[97u\x1b[201~");
	});
});
