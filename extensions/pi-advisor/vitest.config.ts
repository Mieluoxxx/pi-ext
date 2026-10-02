import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		exclude: ["node_modules/**"],
		setupFiles: ["./test/setup.ts"],
		clearMocks: true,
		restoreMocks: true,
		unstubGlobals: true,
	},
});
