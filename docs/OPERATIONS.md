# Operations

Day-2 tasks for a running WABrain: backups, restore, upgrades and
migrations, wiping data, uninstalling, rotating secrets, revoking phones, and
the WhatsApp account risk. Installation is in [DEPLOY.md](DEPLOY.md).

For the compose bundle, the commands run from the repository root on the
server and use this shell function, so each command stays readable:

```bash
dc() { docker compose -f deploy/docker-compose.yml "$@"; }
```

If you did not put `COMPOSE_PROFILES=push,https` into `deploy/.env` (see
[DEPLOY.md, B.3](DEPLOY.md#b3-edit-deployenv)), add `--profile push --profile https`
before the subcommand wherever ntfy and Caddy should be included.

## Where the data lives

| Place | Contents | Sensitivity |
| --- | --- | --- |
| Postgres (`wabrain_postgres-data` volume, or the Railway Postgres service) | Messages, derived media text, people and facts, tasks and their history, review items, embeddings, the job queue (`pgboss` schema, ids only), the owner account, device token hashes, push endpoints, encrypted provider keys, VAPID keys, the audit log | High: this is the memory |
| OpenWA (`wabrain_openwa-data` volume, or the Railway OpenWA volume) | Baileys credentials (the WhatsApp link itself), OpenWA's own stored messages and media, OpenWA API keys and webhooks | High: the credentials give access to the WhatsApp account |
| `deploy/.env` (or Railway variables) | Every secret | High |
| ntfy (`wabrain_ntfy-data`) | Its user database and a short message cache; push payloads are encrypted for each phone | Low |
| Caddy (`wabrain_caddy-data`, `wabrain_caddy-config`) | TLS certificates and account keys | Low |
| The Android app | A local cache (Room) of tasks, people, and chats for the widget and offline use | Medium |
| Model providers | Message text and media sent for analysis, kept according to each provider's policy | Outside your control |

Raw media is deleted after processing; the derived text stays in Postgres.

## Retention and disk growth

Nothing ages out. The 90 days only limit how far back the **initial** history
import reaches; after that, imported and live messages, their derived text
(image descriptions, OCR, transcripts), and their embeddings are all kept
indefinitely. There is no retention job. Data leaves the database only
through the owner's actions:

- deleting a chat's data or a person's data in the app
  (`DELETE /v1/chats/:id/data`, `DELETE /v1/people/:id/data`);
- the full wipe ([Wiping all data](#wiping-all-data)).

So the database grows for as long as the instance runs, and so do the backups.
Plan the disk (or the Railway volume) for that:

- Text and derived text are small; embeddings dominate. One 1536-dimension
  vector takes about 6 KB (1536 × 4 bytes), plus the HNSW index on top.
- Check the size now and then:

  ```bash
  dc exec -T postgres psql -U wabrain -d wabrain -c "select pg_size_pretty(pg_database_size('wabrain'))"
  dc exec -T postgres psql -U wabrain -d wabrain -c "select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace order by pg_total_relation_size(oid) desc limit 10"
  docker system df -v        # volume sizes on the host
  ```

- OpenWA keeps its own store of messages and media in its volume, under its
  own settings; that grows independently of WABrain.
- Keep enough free space for a dump and for restores, and set a retention
  period for the **backups** themselves (they are the one copy you control
  the age of).

## Backups

Back up three things, separately:

1. **The Postgres database**, as an encrypted `pg_dump`. This is the part you
   cannot recreate.
2. **The secrets** (`deploy/.env` or the Railway variables), in your password
   manager. You need the same `APP_ENCRYPTION_KEY` to use the provider keys
   stored in a dump, and the same `OPENWA_WEBHOOK_SECRET` to keep the
   registered webhook working. Never store them next to the dumps.
3. **Optionally, OpenWA's volume.** Without it you pair WhatsApp again after a
   disaster, and OpenWA's stored history (the source of the history import)
   is gone. With it, anyone who can decrypt the backup can take over the
   WhatsApp link, so treat it like a password.

Backups are encrypted before they leave the server (SPEC: "backups are
encrypted"). The examples use [age](https://age-encryption.org) with a key
pair you create on your own computer, so the server only holds the public key
and cannot read old backups even if it is compromised:

```bash
# On your computer, once. Keep wabrain-backup.key offline (password manager, hardware key).
age-keygen -o wabrain-backup.key        # prints the public key: age1...
```

GnuPG works as well: `gpg --encrypt --recipient <your key id>` instead of
`age -r`, or `gpg --symmetric --cipher-algo AES256` for a passphrase (which
cannot run unattended).

### Postgres (compose bundle)

```bash
dc exec -T postgres pg_dump -U wabrain -d wabrain --format=custom \
  | age -r age1yourpublickey... > "wabrain-$(date +%F).dump.age"
```

`pg_dump` runs inside the Postgres container (same major version as the
server), so nothing needs to be installed on the host except `age`. The dump
is consistent while the API and worker keep running.

For a nightly backup, put it in a script with `pipefail`, so a failed dump
never leaves a file that looks valid, and run it from cron:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /path/to/wabrain
out="/var/backups/wabrain/wabrain-$(date +%F-%H%M).dump.age"
docker compose -f deploy/docker-compose.yml exec -T postgres \
  pg_dump -U wabrain -d wabrain --format=custom \
  | age -R /etc/wabrain/backup-recipients.txt > "$out.partial"
mv "$out.partial" "$out"
```

Copy the files off the server (another machine or object storage), and decide
on a retention period: deleted data stays in old backups until they expire
(see [Wiping all data](#wiping-all-data)).

Check a backup now and then by listing its contents on your computer:

```bash
age -d -i wabrain-backup.key wabrain-2026-09-24.dump.age \
  | docker run --rm -i pgvector/pgvector:pg17 pg_restore --list > /dev/null && echo readable
```

A real test restore (below) into a scratch database is better still.

### OpenWA volume (compose bundle, optional)

Stop OpenWA for a consistent copy of its SQLite database, archive the volume,
and start it again:

```bash
dc stop openwa
docker run --rm -v wabrain_openwa-data:/data:ro alpine tar -C /data -czf - . \
  | age -r age1yourpublickey... > "wabrain-openwa-$(date +%F).tar.gz.age"
dc start openwa
```

The WhatsApp session reconnects on its own (`AUTO_START_SESSIONS=true`).
OpenWA receives nothing while it is stopped, so keep the pause short.

### Railway

- **Encrypted dump from your computer.** Enable a public TCP proxy on the
  Postgres service for the duration of the backup (the Railway Postgres
  templates show the resulting URL as `DATABASE_PUBLIC_URL`; *unverified* for
  the template you picked), then:

  ```bash
  read -rs PGURL && export PGURL      # paste the public connection URL
  docker run --rm -e PGURL pgvector/pgvector:pg17 sh -c 'pg_dump --format=custom -d "$PGURL"' \
    | age -r age1yourpublickey... > "wabrain-railway-$(date +%F).dump.age"
  unset PGURL
  ```

  Use a `pg_dump` at least as new as the server (the `pg17` image above for a
  Postgres 17 server). Turn the TCP proxy off again afterwards.
- **Railway's own volume backups**, where your plan offers them, are a useful
  second layer. *Unverified:* availability depends on the plan. They are not
  encrypted with your key.
- OpenWA's volume on Railway belongs to the OpenWA service; if another app
  shares it, back it up together with that app's operations.

## Restore

A restore replaces the whole database with the backup. Messages that arrived
after the backup was taken are missing afterwards. The history import can
bring them back as context from OpenWA's stored messages, but imported history
never creates tasks.

Use the same `APP_ENCRYPTION_KEY` as when the backup was made; otherwise
re-enter the provider keys on the setup page. Paired phones keep working,
because their token hashes are in the dump; phones paired after the backup
must be paired again.

### Compose bundle

Decrypt on your computer and stream the dump to the server, so the private key
never touches the server:

```bash
# On the server: stop everything that writes, then recreate an empty database.
dc stop api worker
dc exec -T postgres dropdb -U wabrain --force wabrain
dc exec -T postgres createdb -U wabrain wabrain

# On your computer:
age -d -i wabrain-backup.key wabrain-2026-09-24.dump.age \
  | ssh you@your-server 'cd /path/to/wabrain && docker compose -f deploy/docker-compose.yml exec -T postgres pg_restore -U wabrain -d wabrain --no-owner --no-acl --exit-on-error'

# On the server: start again. Migrations bring an older dump up to the current schema.
dc up -d
```

`dropdb` and `createdb` connect to the `postgres` maintenance database, and
the `wabrain` user is the superuser of the bundled Postgres, so both work while
the API and worker are stopped.

**On a new server**, deploy the bundle with the **old `deploy/.env`**, start only
Postgres (`dc up -d postgres`), restore into the empty `wabrain` database with
the `pg_restore` command above, then `dc up -d`. The database password in the
new volume comes from `POSTGRES_PASSWORD` in `.env`; a dump does not contain
passwords.

**OpenWA volume**, if you backed it up: with OpenWA stopped,

```bash
dc stop openwa
age -d -i wabrain-backup.key wabrain-openwa-2026-09-24.tar.gz.age \
  | ssh you@your-server 'docker run --rm -i -v wabrain_openwa-data:/data alpine tar -C /data -xzf -'
dc start openwa
```

This restores the WhatsApp link as it was. If WhatsApp has since logged the
device out (Linked devices on the phone), pair again instead.

### Railway

Restore into a **new** Postgres service and switch over, so the old database
stays available until the new one is verified:

1. Create a new Postgres service with pgvector (as in
   [DEPLOY.md, A.3](DEPLOY.md#a3-postgres-with-pgvector)) and enable its TCP
   proxy temporarily.
2. Restore into it from your computer:

   ```bash
   read -rs PGURL && export PGURL      # the NEW service's public URL
   age -d -i wabrain-backup.key wabrain-railway-2026-09-24.dump.age \
     | docker run --rm -i -e PGURL pgvector/pgvector:pg17 \
         sh -c 'pg_restore --no-owner --no-acl --exit-on-error -d "$PGURL"'
   unset PGURL
   ```

3. Point `DATABASE_URL` of the API and the worker at the new service and
   deploy both. Turn the TCP proxy off.
4. Once everything works, delete the old Postgres service and its volume.

## Upgrades and migrations

**Back up first.** Migrations are forward-only: there are no down migrations,
so the way back from a failed upgrade is to restore the backup taken before it
and run the previous version.

### How migrations run

- The SQL migrations live in `packages/db/drizzle` and are applied by
  drizzle's migrator, which records them in `drizzle.__drizzle_migrations`.
- With `RUN_MIGRATIONS=true` (the default) the API and the worker both apply
  pending migrations at start. A Postgres advisory lock serializes them, so
  starting both at once is safe.
- To migrate by hand instead, set `RUN_MIGRATIONS=false` on both and run, from
  a checkout of the new version with `DATABASE_URL` pointing at the database:
  `pnpm --filter @wabrain/db migrate`. In the compose bundle Postgres
  has no host port, so the automatic path is the practical one there.
- To see how many migrations are applied (compare with the number of entries
  in `packages/db/drizzle/meta/_journal.json`):

  ```bash
  dc exec -T postgres psql -U wabrain -d wabrain -c 'select count(*) from drizzle.__drizzle_migrations'
  ```

### Compose bundle

```bash
git pull
dc up -d --build
dc logs -f api worker
```

`up -d --build` rebuilds the API and worker images and recreates only the
containers whose image or configuration changed. To pick up security updates
of the Node base image as well, run `dc build --pull` first. Check the new
variables in `deploy/.env.example` after every pull: `init.sh` only fills in
secrets, it does not add new optional variables to an existing `.env`.

Other components:

- **OpenWA.** Change `OPENWA_VERSION` in `deploy/.env` after reading the
  release notes (<https://github.com/rmyndharis/OpenWA/releases>), back up its
  volume, then `dc up -d openwa`. The session restarts with the container.
  Protocol changes on WhatsApp's side can break older Baileys versions, so do
  not fall far behind.
- **ntfy and Caddy.** `NTFY_VERSION` and `CADDY_VERSION` in `deploy/.env`,
  then `dc up -d`.
- **Postgres major versions.** The image is pinned to
  `pgvector/pgvector:pg17` in `deploy/docker-compose.yml`. A newer major
  version cannot open the old data directory, so changing the tag in place
  fails. Upgrade by dump and restore: back up, stop the stack
  (`dc down`, without `--volumes`), move the old volume aside or remove it
  once the backup is verified, change the image, start Postgres alone, restore
  as above, and start the rest.

Clean up old images now and then with `docker image prune`.

### Railway

Railway builds and deploys the API and worker from the connected branch. After
a push, both services rebuild, and whichever starts first applies the
migrations. For a short time the other service may still run the previous
version against the new schema; for a single-user system that is usually
harmless, but for an upgrade with a large migration you can stop the worker
first and let the API migrate. Watch both deploy logs and the setup page's
status afterwards.

## Wiping all data

The setup page's **Danger zone** deletes all WhatsApp-derived data except
the list of Off chats. Type
`DELETE EVERYTHING` to confirm. It calls `POST /setup/wipe` with
`{"confirm": "DELETE EVERYTHING"}` using the owner session.

**Deleted:** messages, derived media text, embeddings, every chat that is
On or mentions-only (with its settings), people and their facts, tasks and
their history, review items, the trial's labelled examples, analysis runs,
contexts (recreated as the defaults Work and Personal), history import runs,
raw source events, and the notification log. Paired phones take a full
resync to the new state.

**Kept:** the Off list: every chat you switched **Off** stays Off, reduced to
its WhatsApp id (JID) and mode. Its name, person, context, aliases and other
settings are cleared. Also kept: the owner account, paired phones and their
push endpoints, settings, provider settings and their encrypted keys, VAPID
keys, model usage counters, the audit log (which never contains message
content; the wipe's entry records how many Off chats were kept), and the job
queue (which holds ids only).

**Not touched:** your WhatsApp account, OpenWA's own stored messages and media,
backups, and whatever model providers retained.

Things to know:

- New messages are stored again as soon as they arrive, except in Off chats,
  which stay Off: nothing from them is stored, by the webhook or by a history
  import. Every other chat starts over with the defaults (direct chats On,
  groups mentions-only). If nothing at all should be stored, remove
  WABrain's webhook in OpenWA (or stop the API) **before** the wipe.
- The phones' Chats screen afterwards lists only the kept Off chats, shown by
  their WhatsApp id, since their names were deleted. Switching one back On
  there makes it a watched chat again.
- A history import after the wipe brings back up to 90 days of messages from
  OpenWA's store, skipping the Off chats.
- To drop a chat from the Off list, switch it On (in the app) before the
  wipe; the wipe then deletes it like any other chat, and later messages in
  it are stored again.
- Old backups still contain everything. Delete them, or let them expire, if
  the wipe is meant to remove the data for good.

To delete less than everything, use the app: a chat's **delete data**
(`DELETE /v1/chats/:id/data`) or a person's (`DELETE /v1/people/:id/data`).

## Uninstalling and deleting everything

### Compose bundle

1. **Unlink WhatsApp.** On the phone: **Settings → Linked devices**, select the
   OpenWA device, **Log out**. This ends OpenWA's access to the account.
2. **Phones.** In the app, unpair (Settings), then uninstall it. This also
   deletes its local cache. Remove the WABrain subscription from the
   ntfy app, or uninstall ntfy.
3. **Model providers.** Revoke the API keys you gave WABrain in each
   provider's console, and check the provider's data retention if it matters
   to you.
4. **Remove the containers, networks, volumes, and images** (the profiles make
   sure the ntfy and Caddy volumes are included):

   ```bash
   dc --profile push --profile https down --volumes --rmi all
   docker volume ls --filter name=wabrain_     # should list nothing
   docker builder prune                        # build cache (source code only)
   ```

5. **Delete the rest:** `deploy/.env`, the repository checkout, every backup
   (including off-site copies), the backup key, and the password manager
   entries. Remove the DNS records.
6. If the server was dedicated to WABrain, destroy it together with its
   disks at your hosting provider.

### Railway

These steps keep OpenWA and the WhatsApp session, which may be shared with
another app. Delete the OpenWA service too if only WABrain used it.

1. In the OpenWA dashboard, delete **WABrain's** webhook (the one whose
   URL ends in `/webhooks/openwa` on the WABrain API; keep any other
   app's) and delete WABrain's viewer key and any leftover
   operator keys.
2. Delete the API, worker, and Postgres services (and ntfy, if you added it),
   and the shared variables that only they used. *Unverified:* whether
   deleting a service also deletes its volume; check the project afterwards
   and delete any orphaned volume.
3. Phones, model provider keys, and backups as in steps 2, 3, and 5 above.
4. OpenWA's own stored messages remain in OpenWA. If another app shares the
   session, deleting them affects that app too.

## Rotating secrets

The generated secrets are rotated the same way: set the line to an empty value
in `deploy/.env` (for example `OPENWA_WEBHOOK_SECRET=`) and run
`deploy/init.sh`, which generates a new value only for blank secrets. Then
apply it as the table says. On Railway, generate the value the same way into a
temporary file ([DEPLOY.md, A.2](DEPLOY.md#a2-generate-the-wabrain-secrets)),
set the variable, and deploy the affected services.

`dc up -d` recreates every container whose configuration changed, so it is the
usual way to apply a change.

| Secret | Used by | How to rotate | What breaks or must be redone |
| --- | --- | --- | --- |
| `POSTGRES_PASSWORD` | Postgres, API, worker | Only read when the volume is created. Blank it, run `init.sh`, read the new value (`grep '^POSTGRES_PASSWORD=' deploy/.env`), set it inside Postgres with `dc exec postgres psql -U wabrain -d wabrain` and `\password wabrain`, then `dc up -d` | Until `dc up -d`, the running API and worker keep the old connection string; new connections fail between the two steps, so do them together |
| `OPENWA_WEBHOOK_SECRET` | API; OpenWA's webhook | Blank it, run `init.sh`, `dc up -d api`, then `deploy/register-webhook.sh` (it updates the existing webhook's secret). On Railway, run [A.8](DEPLOY.md#a8-register-the-webhook) again | Between the two steps deliveries fail with 401 and OpenWA retries (5 times). Messages whose retries run out miss analysis; the history import can add them as context only |
| `SETUP_BOOTSTRAP_TOKEN` | API, only while no owner exists | Blank it, run `init.sh`, `dc up -d api` | Nothing once the owner exists. Keep it set: it protects the reset described under [Owner password](#owner-password-and-sessions) |
| `APP_ENCRYPTION_KEY` | API and worker (must be equal) | Blank it, run `init.sh`, `dc up -d` | Every provider key stored on the setup page becomes unreadable: **enter all provider keys again**. `AI_*_API_KEY` variables are not affected. Update Railway's shared variable for both services |
| `OPENWA_API_MASTER_KEY` | OpenWA (its `API_MASTER_KEY`); `register-webhook.sh` | Blank it, run `init.sh`, `dc up -d openwa` | OpenWA restarts and the session reconnects. Sign in to the dashboard with the new key |
| `OPENWA_API_KEY_PEPPER` | OpenWA | Blank it, run `init.sh`, `dc up -d openwa` | **Every OpenWA API key stops working**, including `OPENWA_READ_API_KEY`: create a new viewer key and rotate it as in the next row |
| `OPENWA_READ_API_KEY` | API and worker | Create a new viewer key in the OpenWA dashboard (only this session, no allowed chats), set it, `dc up -d`, then delete the old key in the dashboard | Nothing if done in this order. On Railway, update the shared variable and deploy both services |
| Model provider keys (`AI_*_API_KEY` or stored on the setup page) | API and worker | Create a new key at the provider, enter it on the setup page (or set the variable and `dc up -d`), then revoke the old one at the provider | Nothing if done in this order |

Other credentials:

- **Operator keys** for the webhook registration are temporary:
  `register-webhook.sh` deletes the one it mints, and one you create yourself
  should be revoked right after use. Check the OpenWA dashboard's **API Keys**
  list for leftovers.
- **VAPID keys** are generated on first boot and stored in the database
  (`app_state`, key `push.vapid`). They identify the server to push services
  and do not protect content (payloads are encrypted with each phone's own
  keys), so they rarely need rotating. To replace them:
  `dc exec -T postgres psql -U wabrain -d wabrain -c "delete from app_state where key = 'push.vapid'"`,
  then `dc restart api worker`. If a phone stops receiving pushes afterwards,
  unpair and pair it again.
- **ntfy users**, if you created any, are managed with the ntfy CLI inside its
  container (`dc exec ntfy ntfy user ...`).

### Owner password and sessions

There is no password change screen in this build. To reset the owner
password, delete the owner account and create it again with the setup token:

```bash
dc exec -T postgres psql -U wabrain -d wabrain -c 'delete from owner_sessions; delete from owner;'
```

Then open the setup page, which asks for a new password and
`SETUP_BOOTSTRAP_TOKEN`. Data, paired phones, and settings are not affected.
Do this quickly: until the owner exists again, anyone who has the setup token
can claim the instance. On Railway, run the same SQL through `psql` against the
database (or Railway's database view).

To sign out every setup-page session (for example after using a shared
computer): `dc exec -T postgres psql -U wabrain -d wabrain -c 'delete from owner_sessions'`.
Sessions also expire after `SESSION_TTL_HOURS` (default 12).

## Revoking phones

Each phone has its own device token. To revoke one:

- **From the setup page:** the phones list, **Revoke**
  (`DELETE /setup/devices/:id`). The token stops working immediately, the
  phone's push endpoint is deleted, and the audit log records
  `device.revoked`. The app then shows that it was unpaired by the server.
- **From the phone:** unpair in the app's Settings (`DELETE /v1/devices/self`,
  audited as `device.unpaired`).

A lost or stolen phone: revoke it on the setup page first. Revoking stops
access to the server, but the app's local cache stays on the device, so also
wipe the phone remotely (Google's Find My Device) if you can.

Pairing codes are single-use and expire after 10 minutes; unused ones need no
action.

## Logs and health

- `dc ps` shows each service's health; `dc logs -f api worker` follows the
  logs. The API and worker log JSON lines; configuration errors name the
  variable, never its value.
- `GET /health` is public and answers `{"ok":true}` when the database is
  reachable.
- The setup page's overview shows the database, the worker's last heartbeat,
  OpenWA, the configured providers, the trial, and the number of phones.
- An API or worker that keeps restarting with exit code 78 has an invalid
  configuration; the log names the variable.

## Failed jobs

Background jobs (event projection, analysis, media, profiles, history import,
embeddings, notifications) retry with backoff. A job that exhausts its retries
moves to a dead-letter queue (`dead.<queue>` in the `pgboss` schema) and stays
there for 30 days. Nothing retries it automatically.

List them, newest first. The output shows the queue, when it failed, the
number of attempts, and a fixed failure category. Payload ids appear only
when they are internal UUIDs. Exception messages and payload text are never
printed, because provider errors can echo message content, URLs or keys.

```bash
dc exec worker node dist/operations.js failures
dc exec worker node dist/operations.js failures --queue process-media --limit 20
dc exec worker node dist/operations.js failures --json
```

The owner can also read the same list, without a retry option, at
`GET /setup/jobs/failures` (it accepts `?queue=` and `?limit=`, at most 200).

Fix the cause first (a provider key or budget, OpenWA connectivity, disk),
then retry **one** job by the id from the list:

```bash
dc exec worker node dist/operations.js retry <id>
```

A retry checks the stored payload against the job's current shape. It then
queues the job again with fresh retries and removes the entry from the
dead-letter queue in the same transaction. When an equivalent job is already
queued (per-chat queues), the entry is just removed. For the worker's
detailed error, search its log for `job failed` near the failure time. The log
line has the queue and job id and may contain provider text, so treat logs as
sensitive.

On Railway, run the same commands in the worker or API service's shell, for
example `railway ssh --service worker node dist/operations.js failures`. Both
images include `dist/operations.js`. During development, use
`DATABASE_URL=… pnpm --filter @wabrain/worker ops failures`.

## WhatsApp account risk

WABrain reads WhatsApp through OpenWA's **Baileys** engine, an
unofficial, reverse-engineered implementation of WhatsApp's linked-device
protocol. WhatsApp's terms do not allow unofficial clients, and WhatsApp can
restrict or permanently ban the phone number of an account that uses one,
without warning and without appeal. Nobody can rule this out, and the risk
applies to the whole account, not just to this tool.

What WABrain does to keep the risk low:

- It never sends, reacts, edits, deletes, marks as read, sets presence, or
  manages groups. Its OpenWA client only makes GET requests, and its OpenWA
  key has the `viewer` role, which OpenWA does not allow to send anything.
- The bundle sets `BAILEYS_MARK_ONLINE_ON_CONNECT=false` (the account does not
  appear online just because OpenWA connected) and `STATUS_SEED_ON_READY=false`
  (no burst of status reads right after pairing, which can get a new linked
  device unlinked).

What you can do:

- Use it only for **your own** account and data. It is not meant for
  unsolicited messaging, monitoring other people, or business automation.
- If another app shares the OpenWA session, anything that app sends goes out from the same account, and its behavior
  counts toward the same risk.
- Pair once and leave it alone. Frequent re-pairing, several unofficial
  clients on one account, and large bursts of activity look automated.
- Keep OpenWA updated, because WhatsApp protocol changes break old versions.
- Watch the session state on the setup page and in the OpenWA dashboard
  (OpenWA reports a `restriction` when WhatsApp limits the account). If the
  account is restricted, stop OpenWA and unlink the device on the phone before
  doing anything else.
- Consider the people you talk to: their messages are stored on your server
  and sent to the model providers you configure. Local models (for example
  through Ollama) keep that on your own hardware.

You can end OpenWA's access at any time from the phone: **Settings → Linked
devices → Log out** on the OpenWA device.
