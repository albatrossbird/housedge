// Signing for Polymarket US's key-gated API — used here ONLY for the
// market-data WebSocket. Market data over REST needs no key at all.
//
// THIS KEY CAN TRADE. Polymarket US has no read-only keys: every key can
// place, modify and cancel orders (none can withdraw). The account behind
// the box's .us key is kept at $0, and nothing in this repo may call an
// order endpoint with it — scripts/no-order-endpoints.test.mjs fails if
// any file names one. Before any trading, the key is deleted and a new one
// is created on a separate instance.
//
// Verified against the published `polymarket-us` SDK and live on the box
// (2026-09-28):
//   - Ed25519. The secret is base64; decoded it is 64 bytes (the 32-byte
//     seed followed by the 32-byte public key) or the bare 32-byte seed.
//     The SDK signs with the first 32 bytes.
//   - Message: `${timestamp_ms}${METHOD}${path}`, path WITHOUT the query.
//   - Headers X-PM-Access-Key, X-PM-Timestamp (the same ms), X-PM-Signature
//     (base64). The timestamp must be within ~30s of the server's clock.
//
// The secret reaches a service only through systemd's LoadCredential, as
// $CREDENTIALS_DIRECTORY/polyus.key. It is never an environment variable,
// never logged, never printed — its LENGTH may be.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PMUS_WS = process.env.PMUS_WS_URL || "wss://api.polymarket.us/v1/ws/markets";
export const PMUS_WS_PATH = "/v1/ws/markets";
export const PMUS_GATEWAY = process.env.PMUS_GATEWAY_BASE || "https://gateway.polymarket.us/v1";

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function polyUsSecretPath(env = process.env) {
  if (env.PMUS_KEY_FILE) return env.PMUS_KEY_FILE;
  if (env.CREDENTIALS_DIRECTORY) return join(env.CREDENTIALS_DIRECTORY, "polyus.key");
  return null;
}

// Base64 text -> a node KeyObject. Errors describe the SHAPE of what was
// found and never any of its content.
export function parsePolyUsSecret(text) {
  const b64 = String(text).replace(/\s+/g, "");
  if (!b64) throw new Error("the .us secret is empty");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error(`the .us secret is not base64 (${b64.length} characters)`);
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 64 && raw.length !== 32) throw new Error(`the .us secret decodes to ${raw.length} bytes; expected 64 (seed + public key) or 32`);
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  // A 64-byte secret carries its own public half. If it does not match the
  // seed, the file is damaged or two keys were pasted together — and every
  // handshake would be refused with nothing to say why.
  if (raw.length === 64) {
    const pub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
    if (!pub.equals(raw.subarray(32))) throw new Error("the .us secret's public half does not match its seed — the file is damaged");
  }
  return key;
}

export function loadPolyUsSecret(path) {
  if (!path) throw new Error("no .us secret: run under systemd with LoadCredential=polyus.key:/etc/polyus/polyus.key (or set PMUS_KEY_FILE for a test)");
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { throw new Error(`cannot read the .us secret at ${path}: ${e.code || e.message}`); }
  return parsePolyUsSecret(text);
}

export function polyUsAuthHeaders(keyId, key, method, path, now = Date.now()) {
  const ts = String(now);
  const sig = sign(null, Buffer.from(`${ts}${method.toUpperCase()}${path.split("?")[0]}`), key);
  return { "X-PM-Access-Key": keyId, "X-PM-Timestamp": ts, "X-PM-Signature": sig.toString("base64") };
}
