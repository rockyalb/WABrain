# Product specification

This is the product specification. [Architecture](ARCHITECTURE.md) describes how
it is built.

## Summary

WABrain is a self-hosted, read-only memory layer over one person's
WhatsApp. It parses incoming and outgoing messages in the background, creates
and closes to-dos from what is said, learns who each person is and whether a
conversation is work or personal, and later answers questions over the chat
history. The client is a sideloadable native Android app with a home-screen
widget.

## Deployment model

- One user per server instance. Anyone can self-host it and sideload the APK.
- One Docker Compose bundle: OpenWA (Baileys engine), the brain API and worker,
  PostgreSQL with pgvector, and an optional ntfy server for push.
- Railway is also a supported topology, next to a new or existing OpenWA
  service (which may be shared with another app).
- A small web setup page handles WhatsApp pairing, provider keys, the history
  import, and a QR code that the Android app scans to connect.
- WABrain never writes to WhatsApp: no send, react, edit, delete,
  mark-read, presence, or group-management call exists in the codebase.

## Message intake

- Watched by default: every direct chat. Groups only when the owner is truly
  @mentioned or one of the owner's aliases appears as a word.
- A chat can be switched to **Off**. Off chats are not stored and never reach
  a model; only the minimum identifier needed to recognize the chat is kept.
- Always skipped: one-time codes and verification messages, view-once media,
  and status updates.
- Messages are grouped per chat and analyzed once the chat has been quiet for
  about 90 seconds, so a burst of short messages costs one model call.
- Both directions are analyzed. Outgoing messages can create, update, and close
  tasks.
- Media in watched chats: images (description + OCR) and voice notes
  (transcription) in phase 1; PDFs, rendered as page images for the vision
  model, in phase 2. Video is not analyzed.

## Tasks

### Kinds

- **To-do**: something the owner must do, whether someone asked for it
  ("can you check the invoice?") or the owner committed to it ("I'll send the
  contract tomorrow").
- **Waiting on**: something the owner asked someone else for ("can you send me
  the photos?"). It is a task with its own section and ⏳ marker.

### Lifecycle

| Change | Automatic when | Otherwise |
| --- | --- | --- |
| Create | Confidence ≥ threshold, no ambiguity (after the trial) | Review inbox |
| Close (done) | The **owner's** message clearly completes one specific open task | Review prompt |
| Cancel | The **owner's** message clearly cancels one specific open task | Review prompt |
| Reschedule | The conversation clearly moves the date | Review prompt |
| Merge duplicates | Never | Suggested in Review |

- Messages from other people never change a task directly. "Here are the
  photos" or "never mind, I handled it" produce a **Possibly done?** or
  **Possibly cancelled?** prompt that the owner confirms with one tap.
- A proposal still waiting in Review is not forgotten by later messages. If the
  request is repeated, nothing new is proposed. If someone says it was done or
  is no longer needed, the Review card says so, quoting the message, and offers
  **Already done** / **No longer needed** (kept in history as a closed task),
  **Keep as open task**, or **Reject**.
- Every automatic change is recorded in the task history with its evidence and
  can be undone.
- Manual tasks (widget "+" or app) can optionally be linked to a chat or
  person. Once linked, they close from the owner's messages like any other
  task.

### Trial period

For the first 7 days, every proposed task goes to Review. Approvals and
rejections form a labelled evaluation set, and the automatic-creation threshold
is tuned on it before auto-create is enabled. The set is then reused to test
prompt and model changes.

### Language and dates

- Titles and descriptions are written in the conversation's language.
- No stated date means no due date. The model never invents a deadline.
- A date-only due ("tomorrow", "on Friday") resolves to the configured
  end-of-work-day time, default **17:00**, in the configured timezone, default
  **UTC**. Both are settings in the app; set the timezone during setup.
- "today", "tomorrow" and "next week" (next Monday) are understood in any
  language the model reads.

## Contexts

- Each chat has a default context, suggested from the person profile and
  confirmed by the owner once. A single task can override it; for example, a
  colleague organizing a birthday dinner gives a Personal task.
- Contexts are an editable list with the defaults **Work** and **Personal**.
- The widget and task list filter by context.

## People

- Profiles are learned automatically: name, company, role, relationship to the
  owner, languages, and recurring topics.
- Every fact carries its source messages and a confidence, and is editable.
- Claims a person makes about themselves ("I'm the CFO") stay unverified until
  corroborated or confirmed by the owner.
- Languages are tracked per person, and every message gets its own language tag
  because many chats mix languages.

## AI providers

- The server uses the Vercel AI SDK. The provider and model for text, vision,
  transcription, and embeddings are each set in configuration. OpenAI, Anthropic,
  and OpenAI-compatible endpoints such as Ollama are supported.
- A strong multimodal model for both text and images is recommended, because
  chats are informal, full of typos, and often mix languages. The exact model is
  chosen and verified at setup.
- Evaluate voice transcription on a handful of real voice notes in your own
  languages before committing to a model (`pnpm --filter @wabrain/agent
  transcribe-eval`).
- Embeddings: OpenAI `text-embedding-3-large` reduced to 1536 dimensions, so
  vectors fit pgvector's HNSW index. Each vector records the model that produced
  it. Local embedding models (for example bge-m3 through Ollama) are supported
  for self-hosters.
- Retrieval combines vector search with `pg_trgm` trigram matching so typos
  still match.

## History import

- The initial import reaches back 90 days; anything older in OpenWA is not
  imported. From then on nothing ages out: imported and live messages are kept
  indefinitely (see "Data and security") and everything builds on top of the
  initial import. Imported history feeds profiles, contexts, and search.
- Imported history never proposes tasks. New live incoming and outgoing messages may propose tasks.
- Source: OpenWA's stored messages from Baileys full-history sync. First check
  the coverage OpenWA already holds, because the session was paired with
  `BAILEYS_SYNC_FULL_HISTORY=true`. Re-pair only if coverage is insufficient,
  and note that re-pairing also affects any other app sharing the session.
- A per-chat coverage report shows what actually arrived.
- Importing a WhatsApp "Export chat" .zip is deferred.

## Android app

Native Kotlin, Jetpack Compose, and Glance. It connects by scanning the setup
QR code, which provides the server URL and a revocable per-device token.

### Screens

- **Tasks**: Today, Upcoming, Waiting on, and Review tabs with a context filter.
- **Task detail**: the source messages (tap for the surrounding conversation),
  change history, undo, edit, and context override.
- **People**: profile cards with the source of each fact, editable, with the
  person's default context.
- **Chats**: Off, On, or mentions-only for groups; default context; search.
- **Settings**: server connection, contexts, timezone, end-of-work-day time,
  reminders, daily summary time, and AI and privacy information.
- **Ask** (phase 3): see below.

### Widget

- A header with a Work / Personal / All filter and a badge showing the number of
  Review items.
- Open tasks sorted by due date: overdue, then today, then upcoming. Waiting-on
  items are marked ⏳.
- A checkbox completes a task, tapping a row opens it, and "+" adds a task.
- Multiple widget instances are allowed, each with its own filter.

### Notifications

- Due-date reminders.
- A daily summary at a configurable time.
- Every Review item, including new proposals and Possibly done/cancelled
  prompts, with inline action buttons.
- Lock-screen notifications never show message text.
- Delivery uses UnifiedPush (ntfy or another distributor), with a 15-minute
  WorkManager sync as a fallback. There is no Firebase dependency, so one APK
  works against any self-hosted server.

## Ask your chats (phase 3)

- A chat-style screen that answers only from stored messages and cites the
  messages each claim comes from; the citations can be tapped.
- Questions can be limited by person, context, and date range.
- It says "I didn't find this" instead of guessing.
- It is read-only: it creates or edits tasks only when the owner taps a
  suggested action.

## Data and security

- Message text, image descriptions, and transcripts are kept indefinitely. Raw
  media is deleted after processing.
- The owner can delete a chat, delete a person, or wipe everything.
- The host encrypts the disk and backups are encrypted. Fields are not encrypted
  at the application level because that would break search.
- Single-user authentication. Each phone gets its own revocable device token.
  All traffic uses HTTPS, and every endpoint is rate-limited.
- The OpenWA admin key stays inside the compose bundle. The brain API holds only
  a session-scoped read key.
- Every message, OCR result, transcript, and document is treated as untrusted
  evidence, never as instructions.

## Phases

1. **Phase 1:** PostgreSQL and authentication; signed webhook intake; grouped
   analysis of text, images, and voice notes; task create, close, cancel, and
   reschedule; contexts; person profiles; the Android app, widget, and
   notifications through UnifiedPush; the trial mode; and the self-host bundle
   with its setup page.
2. **Phase 2:** the 90-day history import with a coverage report; PDFs;
   embeddings and hybrid search indexing.
3. **Phase 3:** Ask your chats.
