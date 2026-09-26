// Signed requests to Kalshi's authenticated API — REST and the WebSocket
// handshake use the same scheme.
//
// VERIFIED, NOT TRANSCRIBED. The signing string, algorithm and salt
// length below were checked by signing with this code and verifying with
// OpenSSL under Kalshi's reference parameters, with two controls that had
// to fail (a wrong salt length, a different message) and did. A wrong
// PSS salt length is the classic way to get a bare 401 with no hint why.
//
// The scheme (docs.kalshi.com, "Quick Start: Authenticated Requests"):
//   message    = timestamp_ms + METHOD + path   (path from the API root,
//                                                WITHOUT the query string)
//   RSA keys   : RSA-PSS, SHA-256, MGF1(SHA-256), salt = digest length
//   Ed25519    : the message is signed directly
//   signature  : base64
//
// Headers: KALSHI-ACCESS-KEY (the key id), KALSHI-ACCESS-TIMESTAMP,
// KALSHI-ACCESS-SIGNATURE. The WebSocket handshake signs
// `timestamp + "GET" + "/trade-api/ws/v2"`, and Node 22's built-in
// WebSocket carries these as handshake headers — confirmed on the wire.
import { sign, constants, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KALSHI_REST = "https://external-api.kalshi.com/trade-api/v2";
export const KALSHI_WS = "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
export const WS_PATH = "/trade-api/ws/v2";

// WHERE THE KEY LIVES. On the box the service reads it through systemd's
// LoadCredential=, so the PEM stays root-owned at rest and the
// unprivileged service user only ever sees a private per-run copy under
// $CREDENTIALS_DIRECTORY. KALSHI_KEY_FILE is the fallback for running by
// hand. The key is never read from an environment variable: a
// multi-line PEM in an EnvironmentFile is the placeholder-paste failure
// this project already paid fourteen hours for.
export function keyPath(env = process.env) {
  if (env.CREDENTIALS_DIRECTORY) return join(env.CREDENTIALS_DIRECTORY, "kalshi.pem");
  return env.KALSHI_KEY_FILE || null;
}

export function loadKalshiKey(path) {
  if (!path) throw new Error("no Kalshi key file: set KALSHI_KEY_FILE, or run under systemd with LoadCredential=kalshi.pem:<path>");
  let pem;
  try { pem = readFileSync(path, "utf8"); }
  catch (e) { throw new Error(`cannot read Kalshi key at ${path}: ${e.code || e.message}`); }
  // A pasted key that picked up terminal junk — bracketed-paste markers,
  // a stray prompt — fails here with a message that says so, rather than
  // at the first handshake as an opaque 401.
  if (/\x1b|200~|201~/.test(pem)) throw new Error(`Kalshi key at ${path} contains terminal paste markers — re-paste it`);
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ed25519")
    throw new Error(`Kalshi key at ${path} is ${key.asymmetricKeyType}; expected RSA or Ed25519`);
  return key;
}

export function signMessage(key, message) {
  const data = Buffer.from(message, "utf8");
  const sig = key.asymmetricKeyType === "ed25519"
    ? sign(null, data, key)
    : sign("sha256", data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return sig.toString("base64");
}

// `path` may carry a query string; only the part before `?` is signed.
export function kalshiAuthHeaders(keyId, key, method, path, now = Date.now()) {
  if (!keyId) throw new Error("no Kalshi key id: set KALSHI_KEY_ID");
  const ts = String(Math.trunc(now));
  const bare = String(path).split("?")[0];
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": signMessage(key, `${ts}${method.toUpperCase()}${bare}`),
  };
}

// An authenticated REST GET. `path` is relative to /trade-api/v2.
export async function kalshiAuthedGet(path, { keyId, key, base = KALSHI_REST, fetchImpl = fetch } = {}) {
  const url = new URL(base + path);
  const headers = kalshiAuthHeaders(keyId, key, "GET", url.pathname);
  const r = await fetchImpl(url, { headers: { ...headers, "User-Agent": "marketslap/1.0" } });
  let body = null;
  const text = await r.text();
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { ok: r.ok, status: r.status, body, date: r.headers?.get?.("date") || null };
}
