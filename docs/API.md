# API contract (v1)

This is the HTTP contract between the brain API and its clients: the Android app
and the setup page. Request and response bodies use the Zod schemas in
`packages/contracts/src/domain.ts`, abbreviated below by schema name without the
`Schema` suffix. The API also serves this contract as an OpenAPI document at
`GET /v1/openapi.json`, and the Android client is checked against it.

The conventions:

- JSON only, UTF-8, and ISO-8601 timestamps with offsets.
- Errors are `{ "error": { "code": string, "message": string } }` with a
  matching HTTP status. Codes include `unauthorized`, `forbidden`, `not_found`,
  `validation_failed`, `conflict`, `rate_limited`, `budget_exceeded` (429,
  a daily model budget is used up), and `unavailable` (503).
- Every mutating request accepts an `Idempotency-Key` header. The server
  stores it for 24 h and replays the first response for that key. The
  read-only `POST /v1/ask` ignores the header.
- A list response has the shape `{ "items": [...], "nextCursor": string|null }`,
  and the request takes `?cursor=&limit=` (default limit 50, maximum 200).

## Authentication

### Owner (setup page)

- `POST /setup/login` `{ password }` sets an HttpOnly, Secure, SameSite=Strict
  session cookie. The first run sets the password with
  `POST /setup/bootstrap { password }`, and only while no owner exists yet.
  When configured, send `SETUP_BOOTSTRAP_TOKEN` in `X-Setup-Token`.
- `POST /setup/logout`.
- `GET /setup/session` publicly reports owner existence, login state, and whether
  a bootstrap token is required. All other `/setup/*` routes except login and bootstrap
  require the owner session cookie.

### Device pairing

1. The owner calls `POST /setup/pairing-codes`, which returns
   `{ qrPayload, expiresAt }`. The pairing code expires after 10 minutes and
   can be used once.
   `qrPayload` is the string
   `wabrain://pair?server=<urlencoded https base URL>&code=<32+ char secret>`.
2. The app scans the QR code and calls
   `POST /v1/devices/pair { code, deviceName }`, which returns
   `{ deviceId, token }`. The server stores only a hash of the token.
3. Except the initial pairing exchange, every `/v1/*` request sends `Authorization: Bearer <token>`.
- `GET /setup/devices` returns
  `{ items: [{ id, name, createdAt, lastSeenAt }] }`, and
  `DELETE /setup/devices/:id` revokes a device.
- `DELETE /v1/devices/self` unpairs the device making the request.

## Sync (the app's primary read path)

`GET /v1/sync?since=<cursor>`

With no `since`, it returns a full snapshot. Otherwise it returns only what
changed after the cursor.

```json
{
  "cursor": "opaque",
  "full": false,
  "tasks": [Task],
  "reviewItems": [ReviewItem],
  "contexts": [Context],
  "chats": [Chat],
  "people": [Person],
  "settings": Settings,
  "deleted": { "tasks": [id], "reviewItems": [id], "contexts": [id], "chats": [id], "people": [id] }
}
```

- `tasks` includes open tasks, plus tasks closed within the last 7 days.
  Older closed tasks come from `GET /v1/tasks?status=done`.
- `reviewItems` includes only items whose state is `pending`.
- The app stores the result in Room, and the widget reads from Room. The app
  syncs when a push arrives, when it opens, and every 15 minutes through
  WorkManager.

## Tasks

- `GET /v1/tasks?status=open|done|cancelled|closed&kind=&contextId=&chatId=&personId=`
  returns a list. `closed` means done or cancelled together, newest closed
  first; the cursor then pages by close time.
- `GET /v1/tasks/:id` returns
  `{ task: Task, events: [TaskEvent], evidence: [MessageView] }`.
- `POST /v1/tasks` creates a manual task from
  `{ id?, kind, title, description?, dueAt?, dueHasTime?, contextId?, chatId?, personId? }`
  and returns `Task`.
  - `id` is optional and client-generated (a UUID), so the widget can create
    tasks offline.
  - When `dueAt` is a date only (`YYYY-MM-DD`), the server resolves it to
    endOfWorkDay and sets `dueHasTime=false`.
- `PATCH /v1/tasks/:id` accepts
  `{ title?, description?, dueAt?, dueHasTime?, contextId?, kind? }` and returns
  `Task`.
- `POST /v1/tasks/:id/complete`, `/reopen`, and `/cancel` return `Task`. Each
  writes a TaskEvent whose actor is the owner.
- `POST /v1/task-events/:id/undo` returns `Task`. It returns `409 conflict` when
  the event is past `undoableUntil` or has already been undone.

## Review

- `GET /v1/review` returns a list of pending ReviewItems.
- `GET /v1/review/:id` returns `{ reviewItem, task }` for a pending or decided
  item, so a notification can open the exact proposal or its resulting task.
  `task` is nullable (for example a rejected create, or a deleted result task);
  a missing item returns `404`. The browser uses the same route at `/web/review/:id`.
- `POST /v1/review/:id/accept` `{ edits?, closeAs? }` applies the item's action. For a
  `create`, `edits` may override the title, description, dueAt, contextId, or
  kind, and `closeAs` (`done` or `cancelled`) closes the new task at once, for a
  create whose `handled` hint says a later message already dealt with it. It
  returns `{ reviewItem, task }`.
- A pending `create` carries `handled`: null, or `{ status: done | cancelled,
  evidenceMessageIds, confidence, excerpt, fromOwner, at }` when a message after
  the request (in a later burst, or the same one: the create's
  `alreadyHandled`, reason `already_handled`) suggests it was already handled
  before it was reviewed.
- `POST /v1/review/:id/reject` returns `{ reviewItem }`.
- Every decision is stored as a labelled evaluation example.

## Messages

- `GET /v1/chats/:chatId/messages?around=<messageId>&before=20&after=20` returns
  `{ items: [MessageView] }`. The task detail screen uses it to show the
  surrounding conversation.

## Chats

- `GET /v1/chats?q=&mode=` returns a list.
- `PATCH /v1/chats/:id` accepts
  `{ mode?, defaultContextId?, contextConfirmed?, autoCreate?, minimumAutoConfidence?, aliases? }`
  and returns `Chat`. Setting `mode` to `off` purges that chat's stored messages
  and media.
- `DELETE /v1/chats/:id/data` deletes the chat's messages, media, derived text,
  and embeddings. Its tasks are kept, but their evidence links are removed.

## People

- `GET /v1/people?q=` returns a list, and `GET /v1/people/:id` returns `Person`.
- `PATCH /v1/people/:id` accepts `{ displayName?, defaultContextId? }`.
- `POST /v1/people/:id/facts` accepts `{ key, value }`. The fact is stored with
  owner as its source and marked verified.
- `PATCH /v1/people/:id/facts/:factId` accepts `{ value?, verified? }`, and
  `DELETE /v1/people/:id/facts/:factId` deletes the fact.
- `GET /v1/people/:id/facts/:factId/sources` returns `{ items: MessageView[] }`:
  every stored source message of the fact, each with its own `chatId`, so a
  source opens in the chat it came from. Purged messages are omitted.
- `DELETE /v1/people/:id/data` deletes the person's profile and the data of
  every chat that belongs to them.

## Contexts

- `GET /v1/contexts`, `POST /v1/contexts { name, color? }`,
  `PATCH /v1/contexts/:id { name?, color?, sortOrder? }`, and
  `DELETE /v1/contexts/:id?reassignTo=<id>`.

## Settings

- `GET /v1/settings` returns `Settings`.
- `PATCH /v1/settings` accepts
  `{ timezone?, endOfWorkDay?, dailySummaryTime?, remindersEnabled?, reminderLeadMinutes? }`.
  The trial fields and `autoCreateThreshold` are read-only here; the setup page
  changes them.

## Push (UnifiedPush with Web Push encryption)

- `POST /v1/push-endpoints` registers `{ endpoint, p256dh, auth }` for the
  calling device, and `DELETE /v1/push-endpoints` removes it. `endpoint` must
  be an https URL; the server also enforces an SSRF deny list for private
  addresses, unless the host is the configured ntfy host.
- Payloads are encrypted with RFC 8291 (aes128gcm) and kept under 3 KB:

```json
{ "type": "sync" }
{ "type": "review",   "notificationId": "…", "reviewItemId": "…", "reviewType": "create|possibly_done|…", "title": "…", "from": "Arben · Zyra" }
{ "type": "reminder", "notificationId": "…", "taskId": "…", "title": "…", "dueAt": "…" }
{ "type": "summary",  "notificationId": "…", "open": 12, "dueToday": 3, "overdue": 1, "review": 2 }
```

- A review's optional `from` says who it came from: the person, "Person · Group"
  for a group chat, or the chat's name when no person is known. It is left out
  when the item has neither.
- Review, reminder and summary notifications are durable. The server stores
  them in the same transaction as their cause, pushes them to each device, and
  records a push only when the push service accepts it. It retries failed
  pushes with backoff (30 s doubling to 10 min) on every per-minute tick until
  they succeed or expire (Review 30 days, reminder 24 h, summary 12 h). It does
  not send a notification whose Review item was decided, or a reminder whose
  task was closed or rescheduled.
- `GET /v1/notifications` returns the calling device's unacknowledged, still
  relevant notifications as `{ items: [{ id, createdAt, payload }] }`, oldest
  first (at most 100). `payload` is the push payload above, and
  `payload.notificationId` is the same as `id`. `POST /v1/notifications/ack`
  with `{ ids }` (at most 100) marks them handled on this device. The app's
  periodic sync uses the pair as a fallback for lost pushes. It shows each
  `notificationId` at most once, whether it came by push or by this list.

- `title` is the task title, never raw message text. The app shows it only
  when the phone is unlocked (`VISIBILITY_PRIVATE`); the lock-screen version is
  generic, for example "New item to review".
- A review notification has the actions **Accept** and **Reject**, or **Done**
  and **Not yet** for a possibly-done item. Each action calls the matching
  review endpoint.
- The server sends `sync` after every change it makes, so the widget stays
  current.

## Ask (phase 3)

- `POST /v1/ask` takes `AskRequest`
  `{ question, personId?, contextId?, from?, to? }` and returns `AskResponse`
  `{ found, answer, citations: [{ messageId, chatId, excerpt, at }], suggestedAction }`.
- Retrieval is hybrid search over the stored conversation windows: vector
  search when an embedding model is configured and within its daily limit,
  plus trigram matching (so typos still match), fused by rank. Chats set to Off
  are never searched.
- Filters: `personId` limits the search to that person's direct chats and to
  group windows with one of their messages; `contextId` to chats whose default
  context it is; `from` and `to` are inclusive ISO-8601 instants, and only
  messages inside the range reach the model. `from` after `to` is `400`.
- The answer comes only from the retrieved messages, in the question's
  language. Every citation names a message that was retrieved for this
  question, and its `excerpt` is the stored text, never model output. When
  nothing answers the question, or the model cites nothing that was
  retrieved, the response is `{ found: false, answer: "I didn't find this in
  your chats.", citations: [], suggestedAction: null }`.
- `suggestedAction` is an optional `create` action the app offers as a
  suggestion; the server never applies it. The owner creates the task with
  `POST /v1/tasks`.
- The endpoint is read-only: it never changes tasks, chats, messages, or
  anything else. Its only writes are `model_usage` accounting rows (the query
  embedding and the answer call), so Ask counts toward the daily model limits.
- Errors: `409 conflict` when no text model is configured; `429 rate_limited`
  (with `Retry-After`) when the device asks too often (a burst of 10, then one
  every 6 s); `429 budget_exceeded` (with `Retry-After` pointing to local
  midnight) when the text model's daily limit is used up, which the owner can
  raise on the setup page; `503 unavailable` when the text model fails.

## Setup (owner)

- `GET /setup/status` reports database and worker health, whether OpenWA is
  configured, configured model roles, trial/calibration state, and device count.
  `GET /setup/openwa/status` separately reads live OpenWA session status.
- `GET /setup/providers` and `PUT /setup/providers` read and write the provider
  and model settings for text, vision, transcription, and embeddings. API key
  values are write-only: they are never returned, only whether each is set.
- `POST /setup/providers/test` accepts `{ roles?: [...] }` and tests selected
  configured roles (all when omitted). Embedding tests validate the same dimensions
  as production indexing. Provider responses include effective limits and nullable
  stored limits; send null to keep inheriting an environment budget.
- `GET /setup/openwa/qr` returns `{ mode: "dashboard", dashboardUrl, sessionId,
  sessionStatus, paired, message }`. Pair WhatsApp in that dashboard; the brain
  keeps only a viewer key and does not request a QR through an operator endpoint.
- `POST /setup/openwa/test` checks read access and makes no WhatsApp write.
- `PATCH /setup/policy` accepts `{ trialDays?, autoCreateThreshold? }`.
- `GET /setup/jobs/failures?queue=&limit=` lists jobs that exhausted their
  retries: `{ counts, items: [{ id, queue, attempts, failedAt, reason, … }] }`.
  It is read-only and redacted. Retrying is an operator command, described in
  [OPERATIONS.md](OPERATIONS.md#failed-jobs).
- Phase 2:
  - `GET /setup/import/coverage` returns, for each chat, the earliest
    timestamp, message count, media successes and failures, and known gaps.
  - `POST /setup/import` `{ days: 90 }` starts the import and
    `DELETE /setup/import` cancels it.
- `POST /setup/wipe` `{ confirm: "DELETE EVERYTHING" }` removes conversation and
  derived data while preserving minimal Off-chat identifiers/rules, owner access,
  devices, and configuration. See OPERATIONS.md for uninstalling everything.

## Webhooks

- `POST /webhooks/openwa` receives OpenWA events, verified with HMAC. It returns
  `202` only after the event is stored durably.

## Health

- `GET /health` returns `{ ok: boolean }`. It is public and reveals nothing
  else.
