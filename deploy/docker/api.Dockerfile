# syntax=docker/dockerfile:1.7
#
# WABrain API image. It also serves the built setup page (apps/setup) at "/".
# Build from the repository root:
#   docker build -f deploy/docker/api.Dockerfile -t wabrain-api .
#
# Stages: build (pnpm workspace install, setup + API build, production node_modules) → runtime
# (Node 22, non-root, read-only friendly, healthcheck on /health).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /src

# Fetch every locked package once; this layer only changes with the lockfile.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm config set store-dir /pnpm/store && pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --offline --frozen-lockfile

# The setup page is built first: the API build copies apps/setup/dist into its dist/setup.
RUN pnpm --filter @wabrain/setup build \
 && pnpm --filter @wabrain/api build \
 && test -f apps/api/dist/setup/index.html \
 && test -d apps/api/dist/drizzle

# Production dependencies of the API and its workspace packages, from the lockfile (frozen), in a
# flat (hoisted) node_modules so the bundle's bare imports resolve from /app.
RUN sh deploy/docker/prod-deps.sh @wabrain/api /out \
 && cp -R apps/api/dist /out/dist \
 && mkdir -p /out/scripts \
 && cp deploy/scripts/register-webhook.mjs /out/scripts/register-webhook.mjs

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0
WORKDIR /app

# Code stays root-owned and read-only for the process user.
COPY --from=build /out /app

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.API_PORT || process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exit code 78 means invalid configuration (names the variables, never the values).
CMD ["node", "--enable-source-maps", "dist/index.js"]
