// scripts/pmus15-probe.mjs against scripts/fake-polyus.mjs and a fake
// Kalshi /orderbook priced off the same book.
//
// The control is the point: a Kalshi book that is the MIRROR of the .us
// one (i.e. the .us book is the Down side) must fail "same side". A probe
// that passed both would be proving nothing.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, r) => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${r?.slice(-1500) || ""}`); } };

function newSecret() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { secret: Buffer.concat([seed, pub]).toString("base64"), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) };
}

function run({ kalshi = "same", secretOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pmus15probe-"));
  const { secret, publicKeyPem } = newSecret();
  const kf = join(dir, "polyus.key"); writeFileSync(kf, (secretOverride || secret) + "\n");
  const h = join(dir, "h.mjs");
  writeFileSync(h, `
    import { installFakePolyUs, FAKE_PMUS_WS, FAKE_PMUS_GATEWAY } from ${JSON.stringify(join(HERE, "fake-polyus.mjs"))};
    const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    const fake = installFakePolyUs({
      publicKeyPem: ${JSON.stringify(publicKeyPem)},
      fallback: async url => {
        if (!url.includes("/orderbook")) return reply(404, {});
        const mid = [...fake.mids.values()][0];
        if (mid == null) return reply(200, { orderbook_fp: { yes_dollars: [], no_dollars: [] } });
        const bid = mid - 0.005, ask = mid + 0.005;
        const [yb, ya] = ${JSON.stringify(kalshi)} === "same" ? [bid, ask] : [1 - ask, 1 - bid];
        return reply(200, { orderbook_fp: { yes_dollars: [[yb.toFixed(4), "100.00"]], no_dollars: [[(1 - ya).toFixed(4), "100.00"]] } });
      },
    });
    Object.assign(process.env, {
      PMUS_WS_URL: FAKE_PMUS_WS, PMUS_GATEWAY_BASE: FAKE_PMUS_GATEWAY, KALSHI_REST_BASE: "https://fake-kalshi.test/trade-api/v2",
      PMUS_KEY_FILE: ${JSON.stringify(kf)}, PM_KEY_ID: "test-pm-key", PROBE_SECONDS: "1.5", PROBE_SAMPLE_MS: "150",
    });
    await import(${JSON.stringify(join(HERE, "pmus15-probe.mjs"))});
  `);
  try { return { code: 0, text: execFileSync(process.execPath, [h], { stdio: "pipe", timeout: 30000 }).toString() }; }
  catch (e) { return { code: e.status, text: String(e.stdout) + String(e.stderr) }; }
}

console.log("a good key, the Up book");
{
  const r = run();
  ok(r.code === 0 && /ALL REQUIRED CHECKS PASSED/.test(r.text), "passes", r.text);
  ok(/ok {2}same side/.test(r.text) && /ok {2}book/.test(r.text) && /ok {2}clock/.test(r.text), "book, clock and side each checked", r.text);
  ok(/88 characters/.test(r.text), "prints the secret's length", r.text);
}

console.log("CONTROL: Kalshi's book is the mirror (the .us book would be Down)");
{
  const r = run({ kalshi: "mirror" });
  ok(r.code === 1 && /FAIL {2}same side/.test(r.text) && /Down side/.test(r.text), "fails, and says it is the Down side", r.text);
}

console.log("a key the socket refuses");
{
  const { secret } = newSecret();
  const r = run({ secretOverride: secret });
  ok(r.code === 1 && /FAIL {2}handshake/.test(r.text), "fails at the handshake", r.text);
  ok(!r.text.includes(secret.slice(0, 20)), "without printing the secret", r.text);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
