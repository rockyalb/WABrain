import { createHash, randomBytes, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** URL-safe random secret with `bytes` bytes of entropy. */
export const randomSecret = (bytes = 32): string => randomBytes(bytes).toString("base64url");
