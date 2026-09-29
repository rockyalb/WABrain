import { defineConfig } from "vitest/config";

/**
 * The setup page is served by the API at `/` in production (same origin, so the
 * SameSite=Strict owner cookie works). In development Vite serves it on :5173 and
 * proxies the API paths to the API on :8787. The proxy rewrites Origin to the API's
 * own origin so the API's same-origin check (SETUP_ORIGIN) passes without extra config.
 */
const api = process.env.WABRAIN_API_URL ?? "http://localhost:8787";
const proxied = {
  target: api,
  changeOrigin: true,
  configure(proxy: { on(event: "proxyReq", listener: (request: { setHeader(name: string, value: string): void }) => void): void }) {
    proxy.on("proxyReq", (request) => request.setHeader("origin", new URL(api).origin));
  },
};

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/setup/": proxied,
      "/web/": proxied,
      "/v1/": proxied,
      "/health": proxied,
    },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
    // No inline scripts: the API serves this page under a CSP without 'unsafe-inline'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
