import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { AppEnv } from "./deps.js";

/** The setup page's CSP, in secureHeaders form; app.ts applies it to the page routes below. */
export const SETUP_PAGE_CSP = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", "data:"],
  connectSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

const SETUP_CSP = Object.entries(SETUP_PAGE_CSP)
  .map(([name, sources]) => `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} ${sources.join(" ")}`)
  .join("; ");

/** The routes registerSetupStatic serves. */
export function isSetupStaticPath(path: string): boolean {
  return path === "/" || path === "/favicon.svg" || path === "/app-icon.png" || path === "/logo.webp" || path === "/sw.js" || path === "/manifest.webmanifest" || /^\/(?:sora-semibold|figtree-regular|figtree-semibold)\.ttf$/.test(path) || path.startsWith("/assets/");
}

/** The API build copies the setup assets beside its bundle; source mode uses the Vite build. */
export function setupDistDir(): string | null {
  const candidates = [
    process.env.SETUP_DIST_DIR,
    fileURLToPath(new URL("./setup/", import.meta.url)),
    fileURLToPath(new URL("../../setup/dist/", import.meta.url)),
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(`${path}/index.html`))) ?? null;
}

/** Serves only the built setup page and its hashed assets, with a page-specific CSP. */
export function registerSetupStatic(app: Hono<AppEnv>, directory = setupDistDir()): void {
  if (!directory) return;
  app.get("/", async (c) => {
    c.header("Content-Security-Policy", SETUP_CSP);
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(await readFile(`${directory}/index.html`, "utf8"));
  });
  app.get("/favicon.svg", async (c) => {
    c.header("Content-Security-Policy", SETUP_CSP);
    c.header("Content-Type", "image/svg+xml");
    return c.body(await readFile(`${directory}/favicon.svg`, "utf8"));
  });
  app.get("/app-icon.png", async (c) => {
    c.header("Content-Type", "image/png");
    return c.body(await readFile(`${directory}/app-icon.png`));
  });
  app.get("/logo.webp", async (c) => {
    c.header("Content-Type", "image/webp");
    return c.body(await readFile(`${directory}/logo.webp`));
  });
  app.get("/manifest.webmanifest", async (c) => {
    c.header("Content-Type", "application/manifest+json; charset=utf-8");
    return c.body(await readFile(`${directory}/manifest.webmanifest`, "utf8"));
  });
  app.get("/sw.js", async (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("Service-Worker-Allowed", "/");
    return c.body(await readFile(`${directory}/sw.js`, "utf8"));
  });
  for (const filename of ["sora-semibold.ttf", "figtree-regular.ttf", "figtree-semibold.ttf"]) {
    app.get(`/${filename}`, async (c) => {
      c.header("Content-Type", "font/ttf");
      return c.body(await readFile(`${directory}/${filename}`));
    });
  }
  app.get("/assets/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!/^index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(filename)) return c.notFound();
    let body: string;
    try {
      body = await readFile(`${directory}/assets/${filename}`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.notFound();
      throw error;
    }
    c.header("Content-Type", filename.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
    c.header("Content-Security-Policy", SETUP_CSP);
    return c.body(body);
  });
}
