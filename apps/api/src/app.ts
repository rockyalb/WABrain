import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ensureVapidKeys } from "@wabrain/notify";
import type { AppDeps, AppEnv } from "./deps.js";
import { errorJson, handleError } from "./http/errors.js";
import { deviceAuth, ownerWebAuth, sameOrigin } from "./middleware/auth.js";
import { rateLimit, requestContext } from "./middleware/common.js";
import { idempotency } from "./middleware/idempotency.js";
import { buildOpenApiDocument } from "./openapi/document.js";
import { askRoutes } from "./routes/ask.js";
import { chatRoutes } from "./routes/chats.js";
import { miscRoutes } from "./routes/misc.js";
import { pairDevice } from "./routes/pairing.js";
import { setupRoutes } from "./routes/setup.js";
import { taskRoutes } from "./routes/tasks.js";
import { openWaWebhook } from "./routes/webhooks.js";
import { RATE_LIMITS } from "./security/rate-limit.js";
import { isSetupStaticPath, registerSetupStatic, SETUP_PAGE_CSP } from "./setup-static.js";

const tooLarge = (c: Parameters<typeof errorJson>[0]) => errorJson(c, "payload_too_large", "Request body too large");

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError(handleError(deps.logger));
  app.notFound((c) => errorJson(c, "not_found", "Not found"));

  app.use("*", requestContext(deps));
  // secureHeaders writes after the handler, so the setup page's CSP has to be chosen here; a header
  // set by the page handler itself would be overwritten.
  const headers = { crossOriginResourcePolicy: "same-origin", referrerPolicy: "no-referrer" } as const;
  const apiHeaders = secureHeaders({ ...headers, contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } });
  const pageHeaders = secureHeaders({ ...headers, contentSecurityPolicy: SETUP_PAGE_CSP });
  app.use("*", (c, next) => (isSetupStaticPath(c.req.path) ? pageHeaders : apiHeaders)(c, next));

  // Public, reveals nothing but liveness.
  app.get("/health", rateLimit(deps, "health", RATE_LIMITS.health), async (c) => {
    const ok = await deps.database.sql`select 1`.then(
      () => true,
      () => false,
    );
    return c.json({ ok }, ok ? 200 : 503);
  });

  app.post(
    "/webhooks/openwa",
    rateLimit(deps, "webhook", RATE_LIMITS.webhook),
    // OpenWA embeds downloaded media as base64 (its default cap is 50 MB, about 67 MB encoded). The
    // signature is checked before parsing, and the file is dropped before the event is stored.
    bodyLimit({ maxSize: 70 * 1024 * 1024, onError: tooLarge }),
    openWaWebhook(deps),
  );

  // Setup page API: cookie session, strict CORS for the setup origin only.
  const setup = new Hono<AppEnv>();
  setup.use(
    "*",
    cors({
      origin: deps.config.setupOrigin,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowHeaders: ["Content-Type", "Idempotency-Key", "X-Setup-Token"],
      maxAge: 600,
    }),
    sameOrigin(deps),
    rateLimit(deps, "setup", RATE_LIMITS.setup),
    bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }),
  );
  setup.route("/", setupRoutes(deps));
  app.route("/setup", setup);

  // Device API: bearer device token on every route except pairing and the schema.
  const v1 = new Hono<AppEnv>();
  v1.use("*", bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }));
  const openApi = buildOpenApiDocument();
  v1.get("/openapi.json", (c) => c.json(openApi));
  v1.post("/devices/pair", rateLimit(deps, "pairing", RATE_LIMITS.pairing), pairDevice(deps));
  v1.use(
    "*",
    // Per-IP ceiling before the token lookup, then per-device.
    rateLimit(deps, "device-ip", RATE_LIMITS.deviceIp),
    deviceAuth(deps),
    rateLimit(deps, "device", RATE_LIMITS.device, (c) => c.get("deviceId") ?? c.get("clientIp")),
    idempotency(deps),
  );
  v1.route("/", taskRoutes(deps));
  v1.route("/", chatRoutes(deps));
  v1.route("/", miscRoutes(deps));
  v1.route("/", askRoutes(deps));
  app.route("/v1", v1);

  // Browser workspace: the existing task API with the owner's HttpOnly session.
  // A session-scoped device lets Web Push reuse durable per-device delivery.
  const web = new Hono<AppEnv>();
  web.use("*", sameOrigin(deps), rateLimit(deps, "setup", RATE_LIMITS.setup), bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }), ownerWebAuth(deps), idempotency(deps));
  web.get("/push/public-key", async (c) => c.json({ publicKey: (await ensureVapidKeys(deps.database)).publicKey }));
  web.route("/", taskRoutes(deps));
  web.route("/", chatRoutes(deps));
  web.route("/", miscRoutes(deps));
  web.route("/", askRoutes(deps));
  app.route("/web", web);

  registerSetupStatic(app);

  return app;
}
