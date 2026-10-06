import { defineConfig } from "tsup";

export default defineConfig({
  entry: { runner: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle everything (core, commander, zod, cheerio...) so dist/runner.js runs on its own.
  // Node built-ins stay external automatically on platform "node".
  noExternal: [/.*/],
  // CJS deps inside an ESM bundle call require(); give them one.
  banner: {
    js: 'import { createRequire as __seoCreateRequire } from "node:module"; const require = __seoCreateRequire(import.meta.url);',
  },
});
