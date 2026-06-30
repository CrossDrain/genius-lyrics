// Test-only stub for "@luna/core". The real module is injected by TidaLuna's
// host app at runtime and only resolves via luna/buildPlugins' custom esbuild
// plugin during the actual plugin build — it isn't a real npm package, so
// Vite's resolver (which vitest uses) can't find it on its own. This stub
// satisfies the import surface our code actually uses in tests.

export const Tracer = (_prefix: string) => ({
	trace: {
		log: () => {},
		err: () => {},
		msg: { log: () => {}, err: () => {} },
	},
});
