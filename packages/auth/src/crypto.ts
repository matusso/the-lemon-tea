/**
 * WebCrypto-only primitives so the same code runs in Node, Cloudflare Workers and Deno.
 */

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64url(b);
}

export function base64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export async function sha256(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

/** Constant-time comparison of two strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

const PBKDF2_ITERATIONS = 310_000;

/** PBKDF2-SHA256 password hash: `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, it, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2" || !it || !salt || !hash) return false;
  const computed = await pbkdf2(password, fromBase64url(salt), Number(it));
  return timingSafeEqual(base64url(computed), hash);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** PKCE S256 verification (RFC 7636). */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return timingSafeEqual(base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)))), challenge);
}

/**
 * AES-GCM for provider secrets at rest. Key: 32 bytes base64url in APP_ENCRYPTION_KEY.
 * `aad` binds the ciphertext to its context (e.g. tenant + provider) so it cannot be moved.
 */
export async function encryptSecret(plaintext: string, keyB64: string, aad?: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", fromBase64url(keyB64) as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, ...(aad ? { additionalData: enc.encode(aad) } : {}) }, key, enc.encode(plaintext)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

export async function decryptSecret(blob: Uint8Array, keyB64: string, aad?: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromBase64url(keyB64) as BufferSource, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12), ...(aad ? { additionalData: enc.encode(aad) } : {}) }, key, blob.slice(12));
  return new TextDecoder().decode(pt);
}
