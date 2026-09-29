# WABrain

**Self-hosted AI task manager and memory for WhatsApp.** WABrain reads your
WhatsApp chats (read-only), turns requests and promises into to-dos, closes
them when the chat says they are done, learns who people are, and lets you ask
questions about your chat history with cited answers. It never sends, replies
to, or changes a message.

It runs on your own server with Docker Compose, connects to WhatsApp through
[OpenWA](https://github.com/rmyndharis/OpenWA) (Baileys engine), and comes with
a native Android app, a home-screen widget, and an installable web app.

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue)](LICENSE.md)

> WABrain is an independent project. It is not affiliated with, endorsed by, or
> sponsored by WhatsApp or Meta. WhatsApp is a trademark of Meta Platforms, Inc.

## What it does

- **Tasks from chats.** "Can you send me the contract tomorrow?" becomes a to-do
  due tomorrow. "Sent ✅" closes it. Your own promises ("I'll call him on
  Friday") and things you are waiting on from others are tracked too.
- **Review first.** New tasks go to a Review queue until the model is calibrated
  on your own approvals and rejections; after that, confident ones are created
  automatically.
- **Any language.** Titles stay in the language of the chat. Mixed-language
  chats, slang, typos, and missing accents are handled.
- **Voice notes, images, PDFs.** Voice notes are transcribed, images are
  described and OCR'd, and PDFs are read, so a request in any of them counts.
- **People and contexts.** Learns names, companies, roles, and relationships
  (every fact is editable and cites its source messages), and sorts chats into
  Work, Personal, or your own contexts.
- **Ask your chats.** "When is the meeting with the accountant?" is answered
  only from your messages, with citations, using hybrid vector and trigram
  search.
- **Reminders and a daily summary**, as push notifications on Android and in the
  browser.
- **Bring your own model.** OpenAI, Anthropic, or any OpenAI-compatible
  endpoint (for example Ollama), configured per role: text, vision,
  transcription, and embeddings.
- **Privacy by design.** Everything stays on your server. Off chats, one-time
  codes, view-once media, and status updates are dropped before storage.
  Messages are treated as untrusted evidence, never as instructions.

## How it works

```
WhatsApp ──(linked device)── OpenWA (Baileys) ──signed webhook──▶ WABrain API ──▶ Postgres + pgvector
                                   ▲                                   │
                                   └──────── read-only key ◀── Worker ─┴─▶ AI provider
                                                                   │
                                                  Android app / web app / widget
```

1. **OpenWA** holds the WhatsApp linked-device session and sends each message to
   WABrain as a signed webhook. WABrain only holds a read-only (viewer) key.
2. The **worker** groups messages into bursts, adds media text, and asks the
   model for task actions. Deterministic rules then decide what is applied and
   what goes to Review.
3. The **Android app** and the **web app** show tasks, Review, people, chats,
   and Ask.

## Quick start (Docker Compose, including OpenWA)

You need a Linux server (or a Mac/PC for a trial) with Docker and the Compose
plugin, and a domain name pointing at it for HTTPS. The full guide with every
option is [docs/DEPLOY.md](docs/DEPLOY.md).

**1. Get the code and generate secrets**

```bash
git clone https://github.com/rockyalb/WABrain.git wabrain
cd wabrain
deploy/init.sh                      # creates deploy/.env with generated secrets
```

Edit `deploy/.env`: set `BRAIN_DOMAIN`, `VAPID_SUBJECT`, `SELF_JID`, and
`SELF_ALIASES`.

**2. Start OpenWA first and pair WhatsApp**

```bash
docker compose -f deploy/docker-compose.yml up -d openwa
ssh -L 2785:127.0.0.1:2785 you@your-server   # on your computer; skip when running locally
```

Open `http://127.0.0.1:2785`, sign in with `OPENWA_API_MASTER_KEY` from
`deploy/.env`, create a session, and scan its QR code in WhatsApp under
**Settings → Linked devices → Link a device**. Then create an API key with the
**viewer** role for that session only, and put the session id and the key into
`deploy/.env` as `OPENWA_SESSION_ID` and `OPENWA_READ_API_KEY`.
Details: [docs/OPENWA_SETUP.md](docs/OPENWA_SETUP.md).

**3. Start WABrain**

```bash
docker compose -f deploy/docker-compose.yml --profile push --profile https up -d --build
deploy/register-webhook.sh          # connects OpenWA to WABrain with a signed webhook
```

This adds Postgres with pgvector, the API, the worker, Caddy for HTTPS, and
ntfy for push notifications.

**4. Finish on the setup page**

Open `https://<BRAIN_DOMAIN>`, create the owner account with
`SETUP_BOOTSTRAP_TOKEN` from `deploy/.env`, add your AI provider keys, run the
optional 90-day history import, and pair the Android app by scanning the QR
code.

Prefer Railway? See [DEPLOY.md, Part B](docs/DEPLOY.md#part-b-railway).
Backups, upgrades, and uninstalling are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## WhatsApp account risk

OpenWA's Baileys engine is an **unofficial** WhatsApp client. WhatsApp can
restrict or ban accounts that use one. WABrain only reads, which keeps the
footprint small, but the risk is not zero. Read
[the risk section](docs/OPERATIONS.md#whatsapp-account-risk) before you pair an
account you depend on.

## Documentation

| Document | What is in it |
| --- | --- |
| [DEPLOY.md](docs/DEPLOY.md) | Docker Compose and Railway deployment, step by step |
| [OPENWA_SETUP.md](docs/OPENWA_SETUP.md) | OpenWA engine, key roles, webhook, pairing, checks |
| [OPERATIONS.md](docs/OPERATIONS.md) | Backups, restore, upgrades, wiping, secret rotation, account risk |
| [SPEC.md](docs/SPEC.md) | Product behaviour |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Services, pipeline, data model |
| [MEMORY.md](docs/MEMORY.md) | How working memory, people, and contexts fit together |
| [API.md](docs/API.md) | HTTP API used by the apps (OpenAPI in `packages/contracts/openapi.json`) |
| [SECURITY.md](docs/SECURITY.md) | Threat model and safety boundary |

## Local development

Requirements: Node.js 22+, pnpm, and PostgreSQL with pgvector.

```bash
docker run -d --name wabrain-pg -e POSTGRES_PASSWORD=test -p 55432:5432 pgvector/pgvector:pg17
cp .env.example .env                # set OPENWA_WEBHOOK_SECRET (openssl rand -base64 48)
pnpm install
pnpm dev                            # API on :8787, web app on :5173, worker
```

Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (set `TEST_DATABASE_URL`, see
`.env.example`), and `pnpm build`. The Android app in `apps/android` builds with
Gradle: `./gradlew :app:assembleDebug :app:testDebugUnitTest`.

Repository layout: `apps/api` (HTTP API and setup page host), `apps/worker`
(jobs), `apps/setup` (web app), `apps/android` (native app and widget),
`packages/agent` (prompts and model calls), `packages/rules` (deterministic
filters and policy), `packages/db` (schema and repositories), `packages/jobs`
(pipeline), `packages/openwa-adapter` (read-only OpenWA client),
`packages/notify` (push), `packages/contracts` (shared types and OpenAPI).

## License and commercial use

WABrain is **source-available** under the
[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md)
(FSL-1.1-ALv2):

- **Free** to use, modify, and self-host for yourself or inside your own
  company, and for non-commercial education and research.
- **Not allowed without a partnership:** offering WABrain, or something
  substantially similar built from it, to others as a commercial product or
  service (for example a hosted WABrain subscription or a resold app).
- Each release becomes available under the **Apache License 2.0** two years
  after it is published.

Want to offer WABrain commercially, host it for customers, or build on it?
Get in touch through [my GitHub profile](https://github.com/rockyalb).

## Contributing

Issues and ideas are welcome. Pull requests are not accepted at the moment; you
are free to fork the project and change it for any use the license permits. See
[CONTRIBUTING.md](CONTRIBUTING.md).
