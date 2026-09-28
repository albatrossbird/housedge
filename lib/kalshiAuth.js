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

// The *_BASE overrides exist for the end-to-end tests, which run these
// scripts against a fake Kalshi on localhost. Nothing in production sets them.
export const KALSHI_REST = process.env.KALSHI_REST_BASE || "https://external-api.kalshi.com/trade-api/v2";
export const KALSHI_WS = process.env.KALSHI_WS_URL || "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
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
  const key = parsePastedKey(pem, path);
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ed25519")
    throw new Error(`Kalshi key at ${path} is ${key.asymmetricKeyType}; expected RSA or Ed25519`);
  return key;
}

// A key pasted from a phone arrives MANGLED in ways that do not change
// the key: newlines turned into spaces, every line indented, the first
// line run into the second. OpenSSL rejects all of them with the same
// opaque "DECODER routines::unsupported" — measured on the box, 2026-09-28.
// So the key is read from what lies BETWEEN the markers, whitespace
// dropped, and decoded as DER, trying PKCS#1 and PKCS#8 whichever label
// it came under. What cannot be recovered — a paste cut short — is
// reported by its shape, never by its content: the error names the
// label and the character count, and prints no part of the key.
export function parsePastedKey(text, where = "the key file") {
  const m = String(text).match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) {
    const begin = /-----BEGIN [A-Z0-9 ]+-----/.test(text), end = /-----END [A-Z0-9 ]+-----/.test(text);
    throw new Error(`Kalshi key in ${where} is incomplete: ${begin ? "" : "no -----BEGIN line"}${!begin && !end ? " and " : ""}${end ? "" : "no -----END line"}. Paste the whole key, from -----BEGIN to -----END.`);
  }
  const [, label, raw] = m;
  const body = raw.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error(`Kalshi key in ${where} has characters that are not part of a key between its BEGIN and END lines — re-paste it.`);
  const der = Buffer.from(body, "base64");
  for (const type of label === "RSA PRIVATE KEY" ? ["pkcs1", "pkcs8"] : ["pkcs8", "pkcs1"]) {
    try { return createPrivateKey({ key: der, format: "der", type }); } catch {}
  }
  throw new Error(`Kalshi key in ${where} could not be read: "${label}" with ${body.length} characters between the lines ` +
    `(a 2048-bit RSA key has about 1,590; an Ed25519 key about 64). It was probably cut short — re-paste it.`);
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

// An authenticated REST request. `path` is relative to /trade-api/v2.
export async function kalshiAuthed(method, path, { keyId, key, base = KALSHI_REST, body, fetchImpl = fetch } = {}) {
  const url = new URL(base + path);
  const headers = { ...kalshiAuthHeaders(keyId, key, method, url.pathname), "User-Agent": "marketslap/1.0" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null;
  const text = await r.text();
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
  return { ok: r.ok, status: r.status, body: parsed, date: r.headers?.get?.("date") || null };
}

export const kalshiAuthedGet = (path, opts) => kalshiAuthed("GET", path, opts);
