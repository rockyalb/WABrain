# ADR 0001: Reuse OpenWA with its Baileys engine

Status: accepted

## Context

OpenWA may already run for another app on the same WhatsApp account. The desired engine
is browser-free Baileys to lower memory and CPU use. The app must read but never
write WhatsApp messages.

## Decision

Reuse the existing `rmyndharis/OpenWA` deployment with `ENGINE_TYPE=baileys`.
Integrate through signed engine-neutral webhooks and a deliberately read-only
REST client. Do not embed Baileys or run a second linked WhatsApp session in
WABrain.

## Consequences

- OpenWA owns pairing, auth persistence, reconnects, history storage, media, and
  Baileys upgrades.
- Another app and WABrain can consume the same session without opening a
  second companion connection.
- The new app is coupled to a small, versioned OpenWA event/read contract rather
  than to Baileys message internals.
- We must test the deployed OpenWA version's webhook and history payloads before
  production import.
- Runtime credentials can be session-scoped and read-only. Webhook creation is a
  one-time operator action.
