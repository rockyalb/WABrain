/**
 * Test helpers: a push subscription (what the Android app's UnifiedPush connector holds) and an
 * independent RFC 8291 / RFC 8188 (aes128gcm) decryptor, so tests prove the payload really is
 * encrypted to the subscription's keys. Import from "@wabrain/notify/testing".
 */
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

export interface TestSubscription {
  p256dh: string;
  auth: string;
  decrypt(body: Uint8Array): string;
}

export function createTestSubscription(): TestSubscription {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = randomBytes(16);
  const uaPublic = ecdh.getPublicKey();
  return {
    p256dh: uaPublic.toString("base64url"),
    auth: authSecret.toString("base64url"),
    decrypt(body) {
      const buffer = Buffer.from(body);
      const salt = buffer.subarray(0, 16);
      const idLength = buffer.readUInt8(20);
      const asPublic = buffer.subarray(21, 21 + idLength);
      const ciphertext = buffer.subarray(21 + idLength);
      const ecdhSecret = ecdh.computeSecret(asPublic);
      const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
      let end = padded.length - 1;
      while (end >= 0 && padded[end] === 0) end -= 1;
      if (padded[end] !== 2) throw new Error("invalid aes128gcm padding delimiter");
      return padded.subarray(0, end).toString("utf8");
    },
  };
}
