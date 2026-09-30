# Architecture

The product behavior is defined in [SPEC.md](SPEC.md). This document describes
how it is built.

## Product boundary

WABrain is a read-only personal memory and task layer. OpenWA remains the
only component connected to WhatsApp. WABrain receives signed events,
stores a private working copy, analyzes bounded conversation windows, and keeps
tasks, contexts, and person profiles up to date. It never writes to WhatsApp.

```text
WhatsApp
   │
   ▼
OpenWA (ENGINE_TYPE=baileys, session + stored history + media)
   │ signed message.received / message.sent webhooks
   ▼
Ingestion API ──► source_events ──► projector (chats, messages, people)
                                         │
                          chat rule / skip filters (before any model call)
                                         │
                                         ▼
                           per-chat debounce (~90 s quiet)
                                         │
                        ┌────────────────┼─────────────────┐
                        ▼                ▼                 ▼
                  media jobs       analysis job      profile job
               (vision, speech)   (task actions)   (people, context)
                        └────────────────┼─────────────────┘
                                         ▼
                        deterministic action policy
                    (auto-apply / Review / never-auto)
                                         │
                     tasks + task_events + review_items
                                         │
                     REST API ──► UnifiedPush ──► Android app + Glance widget
```

## Components

| Component | Tech | Notes |
| --- | --- | --- |
| `apps/api` | Node 22, TypeScript | Webhooks, REST API for the app, setup page, auth |
| `apps/worker` | Node 22, TypeScript | Durable jobs: debounce, media, analysis, profiles, import, embeddings |
| `apps/setup` | React/Vite web UI | OpenWA dashboard link, provider keys, import, device QR |
| `apps/android` | Kotlin, Compose, Glance | Tasks, people, chats, settings, widget, UnifiedPush |
| `packages/contracts` | Zod | API and domain schemas; exported as OpenAPI for the Kotlin client |
| `packages/rules` | TypeScript | Chat rules, skip filters, action policy |
| `packages/agent` | Vercel AI SDK | Prompts, structured output, provider registry |
| `packages/openwa-adapter` | TypeScript | HMAC verification, normalization, GET-only client |
| `deploy/` | Docker Compose | OpenWA, API, worker, Postgres + pgvector, optional ntfy |

The API and the worker can run as one process for small installs, and as
separate processes when the worker needs to scale.

## OpenWA integration

OpenWA runs with:

```dotenv
ENGINE_TYPE=baileys
BAILEYS_AUTH_DIR=/app/data/baileys
BAILEYS_SYNC_FULL_HISTORY=true
```

`BAILEYS_AUTH_DIR` must be on a persistent volume. WABrain subscribes to
both `message.received` and `message.sent`:

- Both directions are analyzed. Outgoing messages can create, update, and close
  tasks.
- Retry deduplication uses OpenWA's stable `idempotencyKey`.
- Request authenticity uses the HMAC in `X-OpenWA-Signature` over the raw body.

The webhook targets the public HTTPS API hostname, which keeps OpenWA's SSRF
protection enabled. In the compose bundle, the brain API is reached on the
internal network and SSRF allowances are scoped to that single service name.

At runtime WABrain holds only a session-scoped read key and uses these
reads:

- `GET /api/sessions/:sessionId/messages` for paginated stored history
- `GET /api/sessions/:sessionId/chats` for chat discovery
- `GET /api/sessions/:sessionId/messages/:chatId/:messageId/media` for stored media

## Processing pipeline

1. Verify the signature and validate the engine-neutral webhook schema.
2. Apply skip filters before storage: Off chats, one-time codes, view-once
   media, and status updates are discarded.
3. Insert accepted events with a unique `(session_id, idempotency_key)` and
   queue projection durably before returning `202`.
4. Project contacts, chats, participants, messages, replies, and a
   language tag for each message.
5. Apply the chat rule. Group messages without a real mention or alias are
   stored as context only.
6. Queue media jobs. Images get a description and OCR; voice notes get a
   transcript. Their derived text is attached to the message.
7. Restart the chat's debounce timer. When the chat has been quiet for about
   90 seconds and its media jobs have finished, queue one analysis job.
8. The analysis job loads working memory (see below) and asks the model for a
   list of **task actions** with evidence message IDs.
9. The deterministic action policy decides whether each action is applied or
   sent to Review.
10. Persist the changes as `task_events`, then notify the device through
    UnifiedPush.

Analysis is serialized per chat, and each job is idempotent over its range of
messages.

### Working memory

Each analysis receives a bounded context:

- the new burst plus the preceding N messages, together with any replies they
  quote;
- the chat's open tasks and waiting-on items, including their IDs;
- the chat's creates still pending in Review, keyed by review item ID;
- the person profile and the chat's default context;
- the current time, timezone, and end-of-work-day time.

Open-task IDs are what let the model say "this message completes task 123"
instead of creating a duplicate. Pending creates serve the same purpose before
the owner has reviewed them: a repeated request is not proposed again (a create
with a pending create's exact title is also dropped in validation), and a later
"done" or "never mind" is not lost just because the task was not accepted yet.

### Task actions

The agent returns zero or more actions:

```text
create      { kind: todo | waiting_on, title, description, dueAt?, context?, alreadyHandled?, evidence }
complete    { taskId, evidence }
cancel      { taskId, evidence }
reschedule  { taskId, dueAt, evidence }
merge       { taskIds, evidence }
```

Each action carries a confidence, ambiguity reasons, and the direction of its
evidence (the owner's messages or someone else's).

### Action policy

- `create`: applied automatically when auto-create is enabled for the chat,
  confidence is at or above the threshold, and there is no ambiguity.
  Otherwise it goes to Review. During the trial period, every create goes to
  Review. Auto-create also requires usable owner-decision calibration for the
  active provider/model/prompt profile; elapsed time alone never activates it.
- `complete`, `cancel`, `reschedule`: applied automatically only when the
  evidence is the owner's own message, exactly one task is referenced, and
  confidence meets the automatic-change threshold without ambiguity.
  Evidence from anyone else turns the action into a Possibly done/cancelled
  prompt in Review.
- `complete`, `cancel`, `reschedule` of a create still pending in Review never
  apply. `complete`/`cancel` stamp the pending item with a "may already be
  handled" hint (quoting the message); `reschedule` moves its proposed due.
  The card then offers accept as done/cancelled (the task is kept, closed, and
  the create counts as accepted for calibration), keep as open task, or reject.
  If the owner accepted the create in the meantime, the change becomes an
  ordinary Review prompt on the new task; if they rejected it, it is dropped.
- A `create` whose own burst already shows it handled (a request and, a few
  messages later, "here you go" or the delivery itself; or "never mind") carries
  `alreadyHandled` and always goes to Review (`already_handled`), stamped with
  the same hint and the same choices. Whether the "done" lands in the same
  burst or a later one, the owner sees the same card.
- `merge`: always Review.
- Every applied action can be undone and is written to `task_events`.
- Every Review item triggers a notification.

Dates are resolved against the message time, the configured timezone (default
Europe/Rome), and the configured end-of-work-day time (default 17:00). A task
due on a date without a time is due at the end-of-work-day time.

## Chat rules

Rules are data, not prompt text. Each chat can configure:

- **Off** (not stored), **On**, or for groups **mentions only**;
- a default context;
- WhatsApp mention IDs plus approved textual aliases;
- auto-create on or off, and a confidence override.

A real WhatsApp mention always wins. An alias counts only when it appears as a
whole word, as a fallback for people who type the name instead of mentioning.

## People and contexts

A profile job reads direct chats in checkpointed batches of 40 messages in storage
order, waiting for pending media before advancing. Normal runs are daily; history
catch-up continues through all batches, reserving part of the budget for live
analysis. A ten-minute sweep retries deferred work; only successful extraction
records the daily completion. It proposes profile facts (name, company, role, relationship, languages, topics), each with
its source messages and a confidence. Facts are applied automatically and can be
edited. A person's claims about themselves are stored as unverified until they
are corroborated or the owner confirms them.

The chat's default context is suggested from the profile and confirmed once by
the owner. Tasks inherit it unless the model gives a specific reason to
override it.

## Media

Media jobs run in their own queue with strict limits:

- Images: metadata, OCR, and a description from a vision model.
- Voice notes and audio: transcription. Evaluating quality on real voice notes
  in your languages remains a deployment check before selecting a model.
- PDFs: extract the text layer first without requiring a vision provider/budget;
  render capped pages for vision only when needed. Worker-thread deadlines and
  pixel limits reduce risk but do not constitute an OS sandbox or hard native
  memory limit (see SECURITY.md).
- Contacts and locations: parsed deterministically, with no model call.
- Video: not analyzed.

Raw media is deleted after processing. Derived text is kept. View-once content
is never fetched.

## History import (phase 2)

The importer walks OpenWA's stored-message endpoint with the keyset `after`
cursor and `inlineMedia=false`, back to a 90-day cutoff, and resumes from a
durable checkpoint. The first step is to measure the coverage OpenWA already
holds. Re-pairing for a fresh full-history sync is a last resort, because the
session may be shared with another app.

Imported messages feed profiles, contexts, and embeddings. They do not propose
tasks; only new live messages do. The setup page reports, for each
chat, the earliest timestamp, the message count, media successes and failures,
and any known gaps.

## Retrieval (phase 2 and 3)

- `message_chunks`: message text plus derived media text, grouped into
  conversation windows, splitting long messages without dropping their tails
  and preserving citation identity, with an embedding and its model identity.
- Embeddings: `text-embedding-3-large` with `dimensions: 1536`, which fits
  pgvector's HNSW index limit of 2000 dimensions. The model is configurable, and
  changing provider/model/dimensions or endpoint identity triggers a re-embed.
- Hybrid search: HNSW vector search combined with `pg_trgm` similarity so
  misspellings still match. The two result lists are merged with reciprocal
  rank fusion, and results can be filtered by person, context, and date.
- Ask your chats (phase 3): answers only from retrieved chunks and cites message
  IDs. When nothing relevant is found, it says so.

## Client

The Android app talks only to the WABrain API (see
[ADR 0002](adr/0002-native-android-self-hosted.md)). It scans the setup QR code,
exchanges the pairing secret for a device token, and registers a UnifiedPush
endpoint. The widget reads a local Room cache, which is kept fresh by push and
by a 15-minute WorkManager sync. Checking a task off in the widget writes to the
cache first and syncs the change to the server afterwards.

## Data model

Core PostgreSQL tables:

- `source_events`, `chats`, `participants`, `people`, `person_facts`,
  `messages`, `media_objects`;
- `chat_rules`, `contexts`;
- `tasks`, `task_events`, `review_items`;
- `analysis_runs`, `model_usage`, `eval_examples`, `app_state`;
- `chat_pipeline_state`, import checkpoints, and the pg-boss `pgboss` job schema;
- `message_chunks` (pgvector);
- `devices`, `push_endpoints`, `settings`, `audit_events`;
- `notification_events`, per-device `notification_deliveries`, and sync tombstones.

Every change made by the agent stores its evidence message IDs, the provider and
model, the prompt version, the confidence, and the policy decision. Deletes and
edits are auditable and can be undone.

## Durable delivery and operations

Review/reminder/summary events persist transactionally. A per-minute tick retries
push delivery per device; the Android notification feed recovers missed delivery
and deduplicates by event ID. The app acknowledges only displayed or already
handled alerts. OS-blocked alerts remain pending until permission returns or the
event expires. The Recently closed tab provides a route to task history and Undo.

Jobs use pg-boss with retry/backoff and dead-letter queues. Owners can inspect
bounded, redacted failures at `/setup/jobs/failures`; an operator deliberately
retries a selected job with the bundled `operations.js` command. See
[OPERATIONS.md](OPERATIONS.md). Calibration labels retain the analysis profile
and evidence needed for model/prompt evaluation; calibration is an operational
gate, not a guarantee of statistical accuracy.
