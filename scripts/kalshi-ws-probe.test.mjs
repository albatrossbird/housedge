// The stream probe, driven end to end against scripts/fake-kalshi.mjs.
//
// The probe is the evidence the box gets before a recorder runs on it,
// so what matters is that each check CAN FAIL. Every failure below is a
// real way the socket goes wrong on the day:
//   - a key that can trade            -> "key scope" fails
//   - a key Kalshi does not recognise -> REST and handshake both fail
//   - Kalshi ignoring use_yes_price   -> "book vs REST" fails (the flag
//     is being removed; a misread encoding still looks like a book)
//   - a lost frame                    -> "sequence" fails
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "wsprobe-"));

function keypair(type) {
  const { privateKey, publicKey } = type === "rsa"
    ? generateKeyPairSync("rsa", { modulusLength: 2048 })
    : generateKeyPairSync("ed25519");
  const priv = join(dir, `${type}-${Math.random()}.pem`);
  writeFileSync(priv, privateKey.export({ type: type === "rsa" ? "pkcs1" : "pkcs8", format: "pem" }));
  return { priv, pub: publicKey.export({ type: "spki", format: "pem" }) };
}

function run({ keyType = "ed25519", fake = {}, wrongKey = false }) {
  const k = keypair(keyType);
  const pub = wrongKey ? keypair(keyType).pub : k.pub;
  const file = join(dir, `h-${Math.random()}.mjs`);
  writeFileSync(file, `
    import { installFakeKalshi, FAKE_REST, FAKE_WS } from ${JSON.stringify(join(HERE, "fake-kalshi.mjs"))};
    process.env.KALSHI_REST_BASE = FAKE_REST;
    process.env.KALSHI_WS_URL = FAKE_WS;
    process.env.KALSHI_KEY_FILE = ${JSON.stringify(k.priv)};
    process.env.KALSHI_KEY_ID = "test-key-id";
    process.env.KALSHI_WS_CLIENT = "global";
    process.env.PROBE_SECONDS = "3";
    process.env.PROBE_SAMPLE_MS = "120";
    delete process.env.CREDENTIALS_DIRECTORY;
    installFakeKalshi({ publicKeyPem: ${JSON.stringify(pub)}, markets: ["KXBTC15M-26SEP261500-00", "KXBTC15M-26SEP261515-15"], statuses: { "KXBTC15M-26SEP261515-15": "initialized" }, ...${JSON.stringify(fake)} });
    await import(${JSON.stringify(join(HERE, "kalshi-ws-probe.mjs"))});
  `);
  try { return { code: 0, out: execFileSync(process.execPath, [file], { stdio: "pipe" }).toString() }; }
  catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
}

let failed = 0;
const ok = (c, w, out) => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${out}`); } };
const line = (out, name) => (out.match(new RegExp(`^(PASS|FAIL|info)  ${name}:.*$`, "m")) || [""])[0];

console.log("a read-only ed25519 key, everything working");
{
  const r = run({});
  ok(r.code === 0 && /ALL REQUIRED CHECKS PASSED/.test(r.out), "passes", r.out);
  ok(/^PASS/.test(line(r.out, "book vs REST")), "the socket's book agrees with REST's", r.out);
  ok(/^PASS/.test(line(r.out, "get_snapshot")) && /^PASS/.test(line(r.out, "add\\/remove market")), "snapshot repair and add/remove work", r.out);
}

console.log("\nan RSA key (what the web UI issues)");
{
  const r = run({ keyType: "rsa" });
  ok(r.code === 0, "passes", r.out);
}

console.log("\na key that can trade");
{
  const r = run({ fake: { scopes: ["read", "write"] } });
  ok(r.code === 1 && /^FAIL/.test(line(r.out, "key scope")) && /CAN TRADE/.test(r.out), "fails on scope, and says why", r.out);
}

console.log("\na key Kalshi does not recognise");
{
  const r = run({ wrongKey: true });
  ok(r.code === 1 && /^FAIL/.test(line(r.out, "rest auth")) && /^FAIL/.test(line(r.out, "ws connect")), "REST and the handshake both fail", r.out);
}

console.log("\nCONTROL: Kalshi ignores use_yes_price");
{
  const r = run({ fake: { ignoreYesPrice: true } });
  ok(r.code === 1 && /^FAIL/.test(line(r.out, "book vs REST")), "the cross-check catches a misread encoding", r.out);
}

console.log("\na lost frame");
{
  const r = run({ fake: { seqSkipAt: 10 } });
  ok(r.code === 1 && /^FAIL/.test(line(r.out, "sequence")), "a sequence gap fails the run", r.out);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
