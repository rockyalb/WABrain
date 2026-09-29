import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "./deps.js";
import { registerSetupStatic } from "./setup-static.js";
import { createHarness } from "./test/harness.js";

let directory: string;
const app = new Hono<AppEnv>();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wabrain-setup-"));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "index.html"), "<html>Setup</html>");
  await writeFile(join(directory, "favicon.svg"), "<svg></svg>");
  await writeFile(join(directory, "assets", "index-abc123.js"), "console.log('setup')");
  await writeFile(join(directory, "assets", "index-abc123.css"), "body{color:green}");
  registerSetupStatic(app, directory);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("setup static files", () => {
  it("serves the page and its built assets with a restrictive page CSP", async () => {
    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Setup");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const script = await app.request("/assets/index-abc123.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("console.log");
    const style = await app.request("/assets/index-abc123.css");
    expect(style.headers.get("content-type")).toContain("text/css");
  });

  it("does not serve arbitrary files from the setup directory", async () => {
    expect((await app.request("/assets/index-abc123.map")).status).toBe(404);
    expect((await app.request("/assets/secrets.js")).status).toBe(404);
    expect((await app.request("/anything-else")).status).toBe(404);
  });
});

describe("setup static files in the full app", () => {
  it("keeps the page CSP instead of the API's default-src 'none'", async () => {
    process.env.SETUP_DIST_DIR = directory;
    const h = await createHarness({ worker: false });
    try {
      for (const path of ["/", "/favicon.svg", "/assets/index-abc123.js"]) {
        const csp = (await h.request(path)).headers.get("content-security-policy");
        expect(csp, path).toContain("script-src 'self'");
        expect(csp, path).toContain("img-src 'self' data:");
      }
      expect((await h.request("/health")).headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    } finally {
      delete process.env.SETUP_DIST_DIR;
      await h.close();
    }
  });
});
