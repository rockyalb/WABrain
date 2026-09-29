import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger, redact } from "./logger.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  PUBLIC_BASE_URL: "https://brain.example.com/",
  OPENWA_WEBHOOK_SECRET: "k9Qz-7vLx2Rw_Tb4Nm8Hc1Yf6Ud3Pj0Sa",
};

describe("configuration", () => {
  it("loads a valid environment with defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ port: 8787, publicBaseUrl: "https://brain.example.com", setupOrigin: "https://brain.example.com", runMigrations: true, embeddedWorker: false });
  });

  it("fails closed on missing or weak secrets without echoing them", () => {
    expect(() => loadConfig({ ...base, OPENWA_WEBHOOK_SECRET: undefined })).toThrow(ConfigError);
    for (const secret of ["short", "replace-with-a-long-random-secret-value", "a".repeat(40)]) {
      try {
        loadConfig({ ...base, OPENWA_WEBHOOK_SECRET: secret });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain(secret);
      }
    }
    expect(() => loadConfig({ ...base, SETUP_BOOTSTRAP_TOKEN: "weak" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: "mysql://x" })).toThrow(ConfigError);
  });

  it("validates APP_ENCRYPTION_KEY at startup without echoing it", () => {
    expect(loadConfig(base).encryptionKey).toBeNull();
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));
    expect(loadConfig({ ...base, APP_ENCRYPTION_KEY: key.toString("base64") }).encryptionKey?.equals(key)).toBe(true);
    expect(loadConfig({ ...base, APP_ENCRYPTION_KEY: key.toString("hex") }).encryptionKey?.equals(key)).toBe(true);
    for (const value of ["too-short-to-be-a-key", Buffer.alloc(32).toString("base64"), key.toString("base64").slice(0, 20)]) {
      try {
        loadConfig({ ...base, APP_ENCRYPTION_KEY: value });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain("APP_ENCRYPTION_KEY");
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it("treats empty variables as unset", () => {
    expect(loadConfig({ ...base, OPENWA_SESSION_ID: "", SETUP_BOOTSTRAP_TOKEN: "" })).toMatchObject({ openwaSessionId: null, bootstrapToken: null });
    expect(() => loadConfig({ ...base, OPENWA_WEBHOOK_SECRET: "" })).toThrow(ConfigError);
  });

  it("requires https outside local development", () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: "http://brain.example.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", PUBLIC_BASE_URL: "http://localhost:8787" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: "http://localhost:8787" }).publicBaseUrl).toBe("http://localhost:8787");
  });
});

describe("log redaction", () => {
  it("removes secrets, message content, and URL queries", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    logger.info("event", {
      body: "send me the contract",
      password: "hunter2",
      authorization: "Bearer abc",
      nested: { token: "t", endpoint: "https://push.example/up?k=1" },
      error: new Error("failed GET https://openwa.example/api/x?apiKey=secret Bearer abc.def"),
      chatId: "c1",
    });
    const line = lines[0]!;
    for (const secret of ["contract", "hunter2", "abc", "k=1", "apiKey=secret"]) expect(line).not.toContain(secret);
    expect(line).toContain("c1");
    expect(redact({ url: "x" })).toEqual({ url: "[redacted]" });
  });
});
