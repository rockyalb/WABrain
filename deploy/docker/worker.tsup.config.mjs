// Bundles apps/worker for the worker image (run from apps/worker; see worker.Dockerfile).
// Workspace packages ship TypeScript sources, so they are bundled; every third-party package stays
// external and is resolved from the image's production node_modules (no CommonJS-in-ESM shims needed).
export default {
  entry: { index: "src/index.ts", operations: "src/operations.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@wabrain\//],
  skipNodeModulesBundle: true,
};
