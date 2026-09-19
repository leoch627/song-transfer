import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function key(secret: string) {
  return createHash("sha256").update(secret).digest();
}
export function seal(value: unknown, secret: string, ttlSeconds: number) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(
      JSON.stringify({ value, expires: Date.now() + ttlSeconds * 1000 }),
      "utf8",
    ),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
export function unseal<T>(value: string, secret: string): T | null {
  try {
    const data = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    const result = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
    return result.expires > Date.now() ? (result.value as T) : null;
  } catch {
    return null;
  }
}
