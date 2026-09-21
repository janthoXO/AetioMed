import crypto from "node:crypto";

/**
 * Encryption-at-rest for per-request LLM API keys stored on a `JobRecord`
 * (#159, plan mode). A paused job's `encryptedApiKey` column holds only
 * `seal()`'s output — the repo layer never sees a plaintext key.
 *
 * AES-256-GCM, one random 12-byte IV per `seal()` call. Wire format:
 * `v1.<iv b64>.<tag b64>.<ciphertext b64>` — versioned so a future format
 * change can be detected rather than misparsed.
 */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";

/**
 * `keyBase64` must decode to exactly 32 bytes (AES-256). Throws a clear
 * error otherwise — a truncated or malformed key is a deploy-time mistake
 * that should fail loudly at construction, not silently at the first seal.
 */
export function createSecretBox(keyBase64: string): SecretBox {
  let key: Buffer;
  try {
    key = Buffer.from(keyBase64, "base64");
  } catch {
    throw new Error(
      `Invalid JOB_ENCRYPTION_KEY: not valid base64 (expected base64 of exactly ${KEY_BYTES} bytes).`
    );
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Invalid JOB_ENCRYPTION_KEY: decoded to ${key.length} bytes, expected exactly ${KEY_BYTES} (generate one with \`openssl rand -base64 32\`).`
    );
  }

  function seal(plain: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  function open(sealed: string): string {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecretBoxError(
        "Cannot open sealed value: unknown format or version."
      );
    }
    const [, ivB64, tagB64, ciphertextB64] = parts;
    try {
      const iv = Buffer.from(ivB64!, "base64");
      const tag = Buffer.from(tagB64!, "base64");
      const ciphertext = Buffer.from(ciphertextB64!, "base64");
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plain.toString("utf-8");
    } catch (err) {
      throw new SecretBoxError(
        `Cannot open sealed value: wrong key or tampered data (${err instanceof Error ? err.message : String(err)}).`
      );
    }
  }

  return { seal, open };
}

/**
 * Reads `JOB_ENCRYPTION_KEY` from `env` and builds a `SecretBox` from it.
 * Pure function of its arguments — the caller passes `process.env` (never
 * read here directly), keeping this module import-safe per the Repo Layer
 * convention (CLAUDE.md) even though it lives beside, not inside,
 * `persistence/`.
 *
 * - `ALLOW_LLMS` on and the key missing → throws, naming the variable and
 *   how to generate one.
 * - key present but malformed → throws, naming the variable.
 * - key absent and `ALLOW_LLMS` off → returns `undefined` (no encryption
 *   needed: no per-request key is ever stored without it).
 * - key present → returns the box.
 */
export function parseJobEncryptionKey(
  env: Record<string, string | undefined>,
  features: ReadonlySet<string>
): SecretBox | undefined {
  const keyBase64 = env["JOB_ENCRYPTION_KEY"];

  if (!keyBase64) {
    if (features.has("ALLOW_LLMS")) {
      throw new Error(
        "JOB_ENCRYPTION_KEY is required when ALLOW_LLMS is enabled (per-request LLM API keys are stored encrypted at rest). Generate one with `openssl rand -base64 32`."
      );
    }
    return undefined;
  }

  try {
    return createSecretBox(keyBase64);
  } catch (err) {
    throw new Error(
      `Invalid JOB_ENCRYPTION_KEY: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}
