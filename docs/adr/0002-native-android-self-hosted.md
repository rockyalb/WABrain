# ADR 0002: Native Android client, UnifiedPush, and a self-host bundle

Status: accepted

## Context

The first plan shipped an installable PWA and deferred Android and home-screen
widgets. The home-screen widget is now the main way tasks are managed. The
backend must also be self-hostable so other people can run their own instance
and sideload the same APK.

Options considered for the client:

- A PWA only. It cannot provide an Android home-screen widget.
- A Capacitor wrapper around the PWA. It shares the UI, but a Glance widget must
  be written in Kotlin anyway, which leaves two UI stacks to maintain.
- Native Kotlin with Jetpack Compose and Glance. One stack, and the widget is a
  first-class part of the app.

Options considered for push:

- Firebase Cloud Messaging. The Firebase configuration is compiled into the APK
  and the server must hold that project's credentials. A self-hoster could not
  use a shared APK without rebuilding it with their own Firebase project.
- WorkManager polling only. Simple, but Android enforces at least 15 minutes
  between runs.
- UnifiedPush. An open protocol whose distributor (for example ntfy) can be
  self-hosted. One APK works against any server.

## Decision

- Build the client as a native Android app: Kotlin, Jetpack Compose, and a
  Glance widget. Distribute it as a sideloadable APK. Do not target the Play
  Store.
- Deliver push through UnifiedPush, with a 15-minute WorkManager sync as a
  fallback when no distributor is installed.
- Connect the app by scanning a QR code on the server's setup page. The code
  contains the server URL and a one-time pairing secret that is exchanged for a
  revocable device token.
- Ship one Docker Compose bundle: OpenWA (Baileys), the brain API and worker,
  PostgreSQL with pgvector, and optional ntfy.
- Reduce the web app to a setup page.
- Use the Vercel AI SDK on the server so the text, vision, transcription, and
  embedding providers are each chosen in configuration.

## Consequences

- The TypeScript backend packages (contracts, rules, agent, openwa-adapter)
  remain. The PWA task UI is retired.
- The API is the only thing the app talks to. The app never contains WhatsApp
  code, OpenWA credentials, or model-provider keys.
- The contract between API and app must be versioned. It is defined with Zod in
  `packages/contracts` and exported as an OpenAPI document from which the Kotlin
  client is generated or checked.
- Self-hosters who want instant notifications install a UnifiedPush
  distributor. Everyone else gets updates within 15 minutes.
- Sideloading avoids Play Store policy review of an app that reads WhatsApp,
  but updates must be delivered by the app itself or manually.
