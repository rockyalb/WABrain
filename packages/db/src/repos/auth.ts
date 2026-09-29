/** Owner account, owner sessions, pairing codes, and devices. Secrets are stored only as sha256 hashes. */
import { and, asc, count, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "../client.js";
import { notFound } from "../errors.js";
import { sha256Hex } from "../ids.js";
import { devices, owner, ownerSessions, pairingCodes, pushEndpoints } from "../schema.js";

export async function getOwner(db: Db) {
  const [row] = await db.select().from(owner).where(eq(owner.id, 1));
  return row ?? null;
}

/** Creates the owner only if none exists. Returns false when one already did. */
export async function createOwner(db: Db, passwordHash: string): Promise<boolean> {
  const rows = await db.insert(owner).values({ id: 1, passwordHash }).onConflictDoNothing().returning({ id: owner.id });
  return rows.length > 0;
}

export async function createOwnerSession(db: Db, tokenHash: string, expiresAt: Date): Promise<void> {
  await db.insert(ownerSessions).values({ tokenHash, expiresAt });
}

export async function findOwnerSession(db: Db, tokenHash: string, now = new Date()) {
  const [row] = await db
    .select()
    .from(ownerSessions)
    .where(and(eq(ownerSessions.tokenHash, tokenHash), gt(ownerSessions.expiresAt, now)));
  return row ?? null;
}

export async function deleteOwnerSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(devices).where(eq(devices.id, webDeviceId(tokenHash)));
  await db.delete(ownerSessions).where(eq(ownerSessions.tokenHash, tokenHash));
}

/** A browser session is a revocable notification device without a token exposed to JavaScript. */
export function webDeviceId(sessionHash: string): string {
  return `web:${sessionHash}`;
}

export async function ensureWebDevice(db: Db, sessionHash: string): Promise<boolean> {
  const id = webDeviceId(sessionHash);
  await db.insert(devices).values({ id, name: "Web browser", tokenHash: sha256Hex(`web-device:${sessionHash}`) }).onConflictDoNothing();
  const [row] = await db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, id));
  return Boolean(row && row.revokedAt === null);
}

export async function createPairingCode(db: Db, codeHash: string, expiresAt: Date): Promise<void> {
  await db.insert(pairingCodes).values({ codeHash, expiresAt });
}

/** Atomically marks a pairing code used. False when unknown, used, or expired. */
export async function consumePairingCode(db: Db, codeHash: string, deviceId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(pairingCodes)
    .set({ usedAt: now, deviceId })
    .where(and(eq(pairingCodes.codeHash, codeHash), isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, now)))
    .returning({ codeHash: pairingCodes.codeHash });
  return rows.length > 0;
}

export async function createDevice(db: Db, input: { id: string; name: string; tokenHash: string }): Promise<void> {
  await db.insert(devices).values(input);
}

export async function findActiveDeviceByTokenHash(db: Db, tokenHash: string) {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt)));
  return row ?? null;
}

export async function touchDevice(db: Db, id: string, at = new Date()): Promise<void> {
  await db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, id));
}

export async function listActiveDevices(db: Db) {
  return db
    .select({ id: devices.id, name: devices.name, createdAt: devices.createdAt, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(isNull(devices.revokedAt))
    .orderBy(asc(devices.createdAt));
}

export async function countActiveDevices(db: Db): Promise<number> {
  const [row] = await db.select({ value: count() }).from(devices).where(isNull(devices.revokedAt));
  return row?.value ?? 0;
}

/** Revokes a device and removes its push endpoint. */
export async function revokeDevice(db: Db, id: string, at = new Date()): Promise<void> {
  const rows = await db
    .update(devices)
    .set({ revokedAt: at })
    .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  if (!rows.length) throw notFound("Device");
  await db.delete(pushEndpoints).where(eq(pushEndpoints.deviceId, id));
}

/** Housekeeping: expired sessions and pairing codes. */
export async function purgeExpiredAuth(db: Db, now = new Date()): Promise<void> {
  const expired = await db.select({ tokenHash: ownerSessions.tokenHash }).from(ownerSessions).where(lt(ownerSessions.expiresAt, now));
  if (expired.length) await db.delete(devices).where(inArray(devices.id, expired.map((row) => webDeviceId(row.tokenHash))));
  await db.delete(ownerSessions).where(lt(ownerSessions.expiresAt, now));
  await db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, new Date(now.getTime() - 86_400_000)));
}
