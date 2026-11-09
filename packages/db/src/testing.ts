/**
 * Test helper: creates an isolated, migrated database per test file on the
 * Postgres at TEST_DATABASE_URL / DATABASE_URL (default: the docker test
 * container on port 55432), and drops it afterwards.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDatabase, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { ensureDefaults } from "./repos/settings.js";

export const TEST_SERVER_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://postgres:test@localhost:55432/postgres";

export interface TestDatabase {
  url: string;
  database: Database;
  drop(): Promise<void>;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `wabrain_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(TEST_SERVER_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const url = new URL(TEST_SERVER_URL);
  url.pathname = `/${name}`;
  const database = createDatabase(url.toString(), { max: 10 });
  if (options.migrate !== false) {
    await runMigrations(database);
    await ensureDefaults(database.db);
  }
  return {
    url: url.toString(),
    database,
    async drop() {
      await database.close();
      const cleanup = postgres(TEST_SERVER_URL, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}

let fixtureSeq = 0;

/** A signed-webhook-shaped OpenWA envelope for tests. */
export function makeOpenWaEnvelope(
  overrides: {
    event?: "message.received" | "message.sent";
    sessionId?: string;
    idempotencyKey?: string;
    data?: Record<string, unknown>;
  } = {},
) {
  fixtureSeq += 1;
  const id = `wamid-${Date.now()}-${fixtureSeq}`;
  return {
    event: overrides.event ?? "message.received",
    timestamp: new Date().toISOString(),
    sessionId: overrides.sessionId ?? "session-1",
    idempotencyKey: overrides.idempotencyKey ?? `idem-${id}`,
    deliveryId: `delivery-${id}`,
    data: {
      id,
      chatId: "447690000001@s.whatsapp.net",
      from: "447690000001@s.whatsapp.net",
      to: "447690000000@s.whatsapp.net",
      body: "Can you send the contract tomorrow?",
      type: "text",
      timestamp: Math.floor(Date.now() / 1000),
      isGroup: false,
      contact: { name: "Sam" },
      ...overrides.data,
    },
  };
}
