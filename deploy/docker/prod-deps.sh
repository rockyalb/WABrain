#!/bin/sh
# Build-stage helper for the Dockerfiles: installs the production dependencies of one workspace
# package (and of the workspace packages it depends on) into OUT/node_modules.
#
#   sh deploy/docker/prod-deps.sh @wabrain/api /out
#
# - Versions come from pnpm-lock.yaml (--frozen-lockfile, --offline: nothing is resolved anew).
# - node-linker=hoisted gives one flat node_modules, so a bundle in OUT/dist resolves every
#   external import from OUT/node_modules.
# - The workspace packages themselves are bundled into dist, so their links are dropped. The build
#   fails if a dependency could not be hoisted (two versions of one package), because the bundle
#   could then load the wrong one.
set -eu

package=$1
out=$2
work=$(mktemp -d)

# Only the manifests: the install must not see (or copy) any source.
cp pnpm-lock.yaml pnpm-workspace.yaml package.json "$work/"
find apps packages -name package.json -not -path '*/node_modules/*' | tar -cf - -T - | tar -xf - -C "$work"

cd "$work"
pnpm install --offline --frozen-lockfile --prod --config.node-linker=hoisted --filter "$package..."

nested=$(find apps packages -mindepth 3 -maxdepth 3 -path '*/node_modules/*' ! -name '.bin' ! -name '@wabrain' ! -name '.modules.yaml' 2>/dev/null || true)
if [ -n "$nested" ]; then
  echo "Dependencies that could not be hoisted (conflicting versions):" >&2
  echo "$nested" >&2
  exit 1
fi

mkdir -p "$out"
rm -rf node_modules/@wabrain node_modules/.bin
cp -R node_modules "$out/node_modules"
# The bundles are ES modules.
printf '{ "name": "%s-runtime", "private": true, "type": "module" }\n' "$(echo "$package" | sed 's|.*/||')" >"$out/package.json"
cd /
rm -rf "$work"
