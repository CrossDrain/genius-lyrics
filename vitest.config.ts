import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// happy-dom silently fails to sanitize via DOMPurify (script tags pass
		// through untouched) — confirmed during V2 implementation. jsdom is
		// DOMPurify's actually-tested environment; use it instead.
		environment: "jsdom",
	},
	resolve: {
		alias: {
			// "@luna/core" is host-injected at runtime by TidaLuna, not a real
			// npm package — see test/stubs/luna-core.ts for why this is needed.
			"@luna/core": path.resolve(__dirname, "test/stubs/luna-core.ts"),
		},
	},
});
