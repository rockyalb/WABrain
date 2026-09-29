# syntax=docker/dockerfile:1.7
#
# WABrain worker image: durable jobs (projection, analysis, media, profiles, reminders, daily
# summary, Web Push). Build from the repository root:
#   docker build -f deploy/docker/worker.Dockerfile -t wabrain-worker .
#
# Stages: build (pnpm workspace install, bundle apps/worker with tsup, production node_modules) →
# runtime (Node 22, non-root, healthcheck against the job database).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /src

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm config set store-dir /pnpm/store && pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --offline --frozen-lockfile

# apps/worker has no build script (it runs with tsx in development); bundle it here with the tsup
# that apps/api already depends on. SQL migrations are copied next to the bundle, where
# packages/db looks for them.
RUN cd apps/worker \
 && ../api/node_modules/.bin/tsup --config ../../deploy/docker/worker.tsup.config.mjs \
 && cp -R ../../packages/db/drizzle dist/drizzle

# Production dependencies of the worker and its workspace packages, from the lockfile (frozen), in
# a flat (hoisted) node_modules so every external import in the bundle resolves from /app.
RUN sh deploy/docker/prod-deps.sh @wabrain/worker /out \
 && cp -R apps/worker/dist /out/dist \
 && cp deploy/docker/worker-healthcheck.mjs /out/healthcheck.mjs

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out /app

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]

# Exit code 78 means invalid configuration (names the variables, never the values).
CMD ["node", "--enable-source-maps", "dist/index.js"]
