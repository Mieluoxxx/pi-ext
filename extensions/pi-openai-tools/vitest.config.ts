import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Several tests import the Pi 1.0 runtime on first use; under `pnpm -r` load that
		// import alone can exceed the 5s default.
		testTimeout: 30_000,
	},
});
