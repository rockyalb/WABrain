import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskService } from "../services/tasks.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { createContext, deleteContext, listContexts } from "./contexts.js";
import { readSync } from "./sync.js";
import { wipeAllData } from "./wipe.js";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe("sync", () => {
  it("returns a full snapshot, then deltas with tombstones", async () => {
    const { database } = testDb;
    const full = await readSync(database, null);
    expect(full.full).toBe(true);
    expect(full.contexts.map((c) => c.name).sort()).toEqual(["Personal", "Work"]);
    expect(full.settings).toMatchObject({ timezone: "UTC", endOfWorkDay: "17:00", trialDays: 7, autoCreateThreshold: 0.85 });

    const empty = await readSync(database, full.cursor);
    expect(empty).toMatchObject({ full: false, tasks: [], contexts: [], chats: [], people: [] });

    const errands = await createContext(database.db, { name: "Errands", color: "#AABBCC" });
    const delta = await readSync(database, full.cursor);
    expect(delta.contexts.map((c) => c.id)).toEqual([errands.id]);

    const service = new TaskService({ database });
    const { task } = await service.createManualTask({ kind: "todo", title: "Buy milk", contextId: errands.id });
    await deleteContext(database.db, errands.id, null);
    const afterDelete = await readSync(database, delta.cursor);
    expect(afterDelete.deleted.contexts).toEqual([errands.id]);
    expect(afterDelete.tasks.find((t) => t.id === task.id)?.contextId).toBeNull();
  });

  it("closed tasks leave the snapshot after 7 days but stay in deltas", async () => {
    const { database } = testDb;
    const service = new TaskService({ database });
    const { task } = await service.createManualTask({ kind: "todo", title: "Old closed" });
    await service.setStatus(task.id, "done");
    const later = new Date(Date.now() + 8 * 86_400_000);
    const snapshot = await readSync(database, null, later);
    expect(snapshot.tasks.some((t) => t.id === task.id)).toBe(false);
    const recent = await readSync(database, null);
    expect(recent.tasks.some((t) => t.id === task.id)).toBe(true);
  });

  it("forces a full snapshot after a wipe", async () => {
    const { database } = testDb;
    const before = await readSync(database, null);
    await wipeAllData(database);
    const after = await readSync(database, before.cursor);
    expect(after.full).toBe(true);
    expect(after.tasks).toEqual([]);
    expect((await listContexts(database.db)).map((c) => c.name).sort()).toEqual(["Personal", "Work"]);
  });

  it("never skips a change committed late by a concurrent writer", async () => {
    const { database } = testDb;
    const service = new TaskService({ database });
    const { task } = await service.createManualTask({ kind: "todo", title: "Concurrent" });
    const start = await readSync(database, null);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let updated!: () => void;
    const didUpdate = new Promise<void>((resolve) => (updated = resolve));
    // Writer takes a version, then stays uncommitted.
    const writer = database.sql.begin(async (tx) => {
      await tx`update tasks set title = 'Concurrent (edited)' where id = ${task.id}`;
      updated();
      await held;
    });
    await didUpdate;
    // A later writer commits a higher version first.
    await service.createManualTask({ kind: "todo", title: "Later" });

    let resolved = false;
    const reading = readSync(database, start.cursor).then((result) => {
      resolved = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resolved).toBe(false); // waits for the in-flight writer
    release();
    await writer;
    const delta = await reading;
    expect(delta.tasks.map((t) => t.title)).toEqual(expect.arrayContaining(["Concurrent (edited)", "Later"]));
    const next = await readSync(database, delta.cursor);
    expect(next.tasks).toEqual([]);
  });

  it("rejects a malformed cursor", async () => {
    await expect(readSync(testDb.database, "garbage")).rejects.toMatchObject({ code: "validation_failed" });
  });
});
