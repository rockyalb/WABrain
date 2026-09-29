/**
 * Application-level encryption for the few secrets stored in the database (model provider API
 * keys). AES-256-GCM with a random 96-bit IV and an AAD that binds each ciphertext to its purpose,
 * so a ciphertext copied to another row does not decrypt. The key comes from APP_ENCRYPTION_KEY.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/**
 * Parses APP_ENCRYPTION_KEY: 32 random bytes, as base64/base64url (`openssl rand -base64 32`) or as
 * 64 hex characters. Throws (without echoing the value) when it is anything else.
 */
export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!key || key.length !== 32) {
    throw new EncryptionKeyError("APP_ENCRYPTION_KEY must be 32 random bytes, base64 or hex (openssl rand -base64 32)");
  }
  if (new Set(key).size < 8) throw new EncryptionKeyError("APP_ENCRYPTION_KEY has too little variety to be random");
  return key;
}

/** Encrypts `plaintext`; the result is "v1:<iv>:<tag>:<ciphertext>" in base64url. */
export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(key: Buffer, blob: string, aad: string): string {
  const [version, iv, tag, ciphertext] = blob.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new EncryptionKeyError("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new EncryptionKeyError("Could not decrypt a stored secret (wrong APP_ENCRYPTION_KEY?)");
  }
}
