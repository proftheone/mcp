import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless sealed tokens (AES-256-GCM). Every OAuth artefact (client_id, authorization code,
 * access token, refresh token) is an encrypted JSON payload, so the MCP server needs no database.
 * Revoking the customer's EPRPilot API token invalidates everything derived from it.
 */

/** false = account endpoint and OAuth are disabled (public knowledge tools keep working). */
export let cryptoReady = true;

function loadKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    console.error("[crypto] ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32) - account endpoint disabled");
    cryptoReady = false;
    return randomBytes(32);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("[crypto] ENCRYPTION_KEY not set - account endpoint and OAuth disabled");
    cryptoReady = false;
  } else {
    console.warn("[crypto] ENCRYPTION_KEY not set - using an ephemeral dev key (tokens die on restart)");
  }
  return randomBytes(32);
}

const KEY = loadKey();

export type TokenType = "client" | "code" | "access" | "refresh";

export function seal(typ: TokenType, payload: Record<string, unknown>, ttlSeconds?: number): string {
  const body = { ...payload, typ, exp: ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : undefined };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  cipher.setAAD(Buffer.from(typ));
  const ct = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return `${typ}.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

export function unseal<T = Record<string, unknown>>(expected: TokenType, token: string | undefined): (T & { typ: TokenType; exp?: number }) | null {
  if (!token) return null;
  const [typ, data] = token.split(".", 2);
  if (typ !== expected || !data) return null;
  try {
    const buf = Buffer.from(data, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(typ));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    const body = JSON.parse(json);
    if (body.typ !== expected) return null;
    if (body.exp && body.exp < Date.now() / 1000) return null;
    return body;
  } catch {
    return null;
  }
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Short, non-reversible id of a customer token - for logs and rate limiting. */
export function tokenFingerprint(apiToken: string): string {
  return createHash("sha256").update(apiToken).digest("hex").slice(0, 12);
}
