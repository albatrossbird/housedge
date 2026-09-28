// Kalshi request signing, pinned.
//
// Every assertion here exists because getting it wrong produces the same
// symptom — a bare 401 with no hint — and that is the most expensive kind
// of failure to debug from a box you reach through a phone browser.
//
// The cross-check against OpenSSL is the one that matters: it verifies
// our signature with a DIFFERENT implementation under Kalshi's exact
// parameters, and requires two wrong-parameter controls to fail. A test
// that verifies Node with Node would pass on a scheme both got wrong.

import { generateKeyPairSync, verify, constants } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kalshiAuthHeaders, signMessage, loadKalshiKey, keyPath, WS_PATH, parsePastedKey } from "../lib/kalshiAuth.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const dir = mkdtempSync(join(tmpdir(), "kauth-"));
// PKCS#1 — the "BEGIN RSA PRIVATE KEY" form Kalshi's web app hands out.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pemPath = join(dir, "k.pem");
writeFileSync(pemPath, privateKey.export({ type: "pkcs1", format: "pem" }));
const key = loadKalshiKey(pemPath);

console.log("the signed message");
{
  const h = kalshiAuthHeaders("key-123", key, "get", "/trade-api/v2/portfolio/balance?limit=5", 1703123456789);
  ok(h["KALSHI-ACCESS-KEY"] === "key-123", "key id in KALSHI-ACCESS-KEY");
  ok(h["KALSHI-ACCESS-TIMESTAMP"] === "1703123456789", "timestamp in MILLISECONDS, as a string");
  const msg = Buffer.from("1703123456789GET/trade-api/v2/portfolio/balance");
  const sig = Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64");
  const v = saltLength => verify("sha256", msg, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength }, sig);
  ok(v(32), "query string stripped, method upper-cased, salt = digest length (32)");
  ok(!v(222), "control: the same signature does NOT verify at max salt length");
  ok(!verify("sha256", Buffer.from("1703123456789GET/trade-api/v2/portfolio/balance?limit=5"),
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig),
    "control: signing the query string would have been a different signature");
}

console.log("\nthe WebSocket handshake path");
{
  const h = kalshiAuthHeaders("k", key, "GET", WS_PATH, 1700000000000);
  ok(verify("sha256", Buffer.from("1700000000000GET/trade-api/ws/v2"),
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")), "signs GET /trade-api/ws/v2");
}

console.log("\nan independent implementation agrees (OpenSSL)");
{
  let have = true;
  try { execFileSync("openssl", ["version"], { stdio: "pipe" }); } catch { have = false; }
  if (!have) console.log("  --  openssl not installed here; skipped (it runs on the Actions runner)");
  else {
    const pub = join(dir, "pub.pem"), msgf = join(dir, "m.txt"), sigf = join(dir, "s.bin");
    writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
    writeFileSync(msgf, "1703123456789GET/trade-api/ws/v2");
    writeFileSync(sigf, Buffer.from(signMessage(key, "1703123456789GET/trade-api/ws/v2"), "base64"));
    const osl = salt => { try { execFileSync("openssl", ["dgst", "-sha256", "-sigopt", "rsa_padding_mode:pss",
      "-sigopt", `rsa_pss_saltlen:${salt}`, "-verify", pub, "-signature", sigf, msgf], { stdio: "pipe" }); return true; } catch { return false; } };
    ok(osl(32), "OpenSSL verifies it under Kalshi's parameters");
    ok(!osl(222), "and rejects it under the wrong salt length");
  }
}

console.log("\nEd25519 keys sign the message directly");
{
  const ed = generateKeyPairSync("ed25519");
  const p = join(dir, "ed.pem"); writeFileSync(p, ed.privateKey.export({ type: "pkcs8", format: "pem" }));
  const h = kalshiAuthHeaders("k", loadKalshiKey(p), "GET", WS_PATH, 1);
  ok(verify(null, Buffer.from("1GET/trade-api/ws/v2"), ed.publicKey, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")), "Ed25519 verifies");
}

console.log("\nwhere the key comes from, and what is refused");
{
  ok(keyPath({ CREDENTIALS_DIRECTORY: "/run/credentials/x", KALSHI_KEY_FILE: "/other" }) === "/run/credentials/x/kalshi.pem",
     "systemd LoadCredential wins over KALSHI_KEY_FILE");
  ok(keyPath({ KALSHI_KEY_FILE: "/k.pem" }) === "/k.pem", "KALSHI_KEY_FILE by hand");
  ok(keyPath({}) === null, "neither -> null, not a guessed default");
  const junk = join(dir, "junk.pem");
  writeFileSync(junk, "\x1b[200~" + privateKey.export({ type: "pkcs1", format: "pem" }));
  let e1 = null; try { loadKalshiKey(junk); } catch (e) { e1 = e; }
  ok(e1 && /paste markers/.test(e1.message), "a key with bracketed-paste junk is refused by name, not by a later 401");
  let e2 = null; try { kalshiAuthHeaders("", key, "GET", "/x"); } catch (e) { e2 = e; }
  ok(e2 && /KALSHI_KEY_ID/.test(e2.message), "a missing key id names the variable");
}

console.log("\na key mangled by a phone paste");
{
  // Every case here made OpenSSL throw "DECODER routines::unsupported".
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const lines = pem.trim().split("\n");
  const want = privateKey.export({ type: "pkcs1", format: "der" }).toString("hex");
  const same = k => k.export({ type: "pkcs1", format: "der" }).toString("hex") === want;
  const cases = {
    "newlines turned into spaces": pem.replace(/\n/g, " "),
    "every line indented": pem.split("\n").map(l => "  " + l).join("\n"),
    "first line run into the second": lines[0] + lines.slice(1).join("\n"),
    "Windows line endings": pem.replace(/\n/g, "\r\n"),
    "PKCS#1 body under a PKCS#8 label": pem.replace(/RSA PRIVATE KEY/g, "PRIVATE KEY"),
  };
  for (const [name, text] of Object.entries(cases)) {
    let k = null; try { k = parsePastedKey(text); } catch {}
    ok(k && same(k), `recovers: ${name}`);
  }
  const ed = generateKeyPairSync("ed25519").privateKey;
  const edPem = ed.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, " ");
  let edk = null; try { edk = parsePastedKey(edPem); } catch {}
  ok(edk?.asymmetricKeyType === "ed25519", "recovers an Ed25519 key too");

  const cut = lines.slice(0, 10).join("\n") + "\n" + lines.at(-1);
  let e3 = null; try { parsePastedKey(cut); } catch (e) { e3 = e; }
  ok(e3 && /cut short/.test(e3.message) && /\d+ characters/.test(e3.message), "a paste cut short says so, with its length");
  ok(e3 && !lines.slice(1, 10).some(l => e3.message.includes(l.slice(0, 12))), "and prints no part of the key");
  let e4 = null; try { parsePastedKey(lines.slice(1).join("\n")); } catch (e) { e4 = e; }
  ok(e4 && /no -----BEGIN line/.test(e4.message), "a paste missing its first line says so");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
