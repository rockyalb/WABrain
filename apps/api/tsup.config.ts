import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  // The operator command for failed jobs ships in this image too (Railway runs only the API).
  entry: { index: "src/index.ts", operations: "../worker/src/operations.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@wabrain\//],
  // CommonJS dependencies bundled into this ESM file (web-push, @vercel/oidc, ...) call require()
  // for Node built-ins; esbuild's shim needs a real `require` in scope, and __dirname/__filename.
  banner: { js: 'import { createRequire as __wabrainCreateRequire } from "node:module";\nconst require = __wabrainCreateRequire(import.meta.url);' },
  shims: true,
  // The bundled db package looks for its SQL migrations next to the bundle.
  onSuccess: async () => {
    cpSync("../../packages/db/drizzle", "dist/drizzle", { recursive: true });
    cpSync("../setup/dist", "dist/setup", { recursive: true });
  },
});
