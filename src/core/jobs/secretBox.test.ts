import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  createSecretBox,
  parseJobEncryptionKey,
  SecretBoxError,
} from "@/core/jobs/secretBox.js";

const KEY = crypto.randomBytes(32).toString("base64");
const OTHER_KEY = crypto.randomBytes(32).toString("base64");

describe("createSecretBox", () => {
  it("round trips a plaintext value", () => {
    const box = createSecretBox(KEY);
    const sealed = box.seal("sk-super-secret");
    expect(box.open(sealed)).toBe("sk-super-secret");
  });

  it("uses a fresh IV each seal, so two seals of the same value differ", () => {
    const box = createSecretBox(KEY);
    const a = box.seal("same-value");
    const b = box.seal("same-value");
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe("same-value");
    expect(box.open(b)).toBe("same-value");
  });

  it("fails to open with the wrong key", () => {
    const sealed = createSecretBox(KEY).seal("secret");
    const wrongBox = createSecretBox(OTHER_KEY);
    expect(() => wrongBox.open(sealed)).toThrow(SecretBoxError);
  });

  it("fails to open tampered ciphertext", () => {
    const box = createSecretBox(KEY);
    const sealed = box.seal("secret");
    const parts = sealed.split(".");
    // Flip a byte in the ciphertext by tweaking the last character.
    const ciphertext = parts[3]!;
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      ciphertext.slice(0, -1) + (ciphertext.endsWith("A") ? "B" : "A"),
    ].join(".");
    expect(() => box.open(tampered)).toThrow(SecretBoxError);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => createSecretBox(Buffer.alloc(16).toString("base64"))).toThrow(
      /32/
    );
  });

  it("open rejects an unknown version/format", () => {
    const box = createSecretBox(KEY);
    expect(() => box.open("v2.a.b.c")).toThrow(SecretBoxError);
    expect(() => box.open("garbage")).toThrow(SecretBoxError);
  });
});

describe("parseJobEncryptionKey", () => {
  it("throws naming JOB_ENCRYPTION_KEY when ALLOW_LLMS is set and the key is missing", () => {
    expect(() => parseJobEncryptionKey({}, new Set(["ALLOW_LLMS"]))).toThrow(
      /JOB_ENCRYPTION_KEY/
    );
    try {
      parseJobEncryptionKey({}, new Set(["ALLOW_LLMS"]));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/ALLOW_LLMS/);
      expect(String(err)).toMatch(/openssl rand -base64 32/);
    }
  });

  it("throws naming JOB_ENCRYPTION_KEY when present but malformed", () => {
    expect(() =>
      parseJobEncryptionKey(
        { JOB_ENCRYPTION_KEY: "not-base64-32-bytes" },
        new Set()
      )
    ).toThrow(/JOB_ENCRYPTION_KEY/);
  });

  it("returns undefined when absent and ALLOW_LLMS is off", () => {
    expect(parseJobEncryptionKey({}, new Set())).toBeUndefined();
  });

  it("returns a working SecretBox when the key is present and valid", () => {
    const box = parseJobEncryptionKey(
      { JOB_ENCRYPTION_KEY: KEY },
      new Set(["ALLOW_LLMS"])
    );
    expect(box).toBeDefined();
    expect(box!.open(box!.seal("hello"))).toBe("hello");
  });
});
