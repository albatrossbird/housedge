// The Polymarket US 15-minute recorder, end to end against
// scripts/fake-polyus.mjs and a fake Supabase (PostgREST credential probe
// + Storage). Also pins lib/pmus15.js and lib/polyUsAuth.js.
//
// Rules pinned here:
//   1. Slugs and Kalshi tickers are built from the clock, and agree with
//      the real ones read off both venues on 2026-09-28.
//   2. Every file that leaves the box is a complete gzip opening with a
//      meta line, under pmus15/<day>/<hour>/.
//   3. Books are recorded best-first on both sides, from `offers` — never
//      an empty ask side because the reader looked for `asks`.
//   4. A window not listed yet is an error on the tape and is asked for
//      again, not a crash and not a silent absence.
//   5. A dropped or silent socket is reconnected with a fresh signature.
//   6. A refused key, a skewed clock, a damaged secret and a missing
//      bucket are all FATAL, before recording, and say which.
//   7. The secret never appears in anything the recorder prints.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, readdirSync, mkdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pmusSlug, parsePmusSlug, kalshiM15Ticker, normalizeBook, wantedSlugs, WINDOW_MS } from "../lib/pmus15.js";
import { parsePolyUsSecret, polyUsAuthHeaders } from "../lib/polyUsAuth.js";

const HERE = new URL(".", import.meta.url).pathname;
let failed = 0;
const ok = (c, w, r) => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${r?.text?.slice(-1500) || ""}`); } };

// A .us secret in the shape the box holds: base64 of seed || public key.
function newSecret() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { secret: Buffer.concat([seed, pub]).toString("base64"), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) };
}

console.log("slugs and tickers");
{
  const s = Date.parse("2026-09-28T21:30:00Z");
  ok(pmusSlug("btc", s) === "cpc-btc-updown-15m-2026-09-28-2130z", "the market slug read off polymarket.us");
  ok(kalshiM15Ticker("btc", s + WINDOW_MS) === "KXBTC15M-26SEP281745-45", "the Kalshi ticker for the same window (EDT)");
  ok(kalshiM15Ticker("btc", Date.parse("2026-09-28T15:30:00Z")) === "KXBTC15M-26SEP281130-30", "another settled one read off Kalshi");
  ok(kalshiM15Ticker("btc", Date.parse("2026-12-01T15:30:00Z")) === "KXBTC15M-26DEC011030-30", "EST moves the hour, not a hand-written offset");
  const p = parsePmusSlug("cpc-btc-updown-15m-2026-09-28-2130z");
  ok(p.asset === "btc" && p.start === s && p.close === s + WINDOW_MS, "a slug parses back to its window");
  ok(parsePmusSlug("btc-updown-15m-2026-09-28-2130z") === null, "the EVENT slug is not a market slug");
  const w = wantedSlugs(s + 7 * 60000, ["btc"], 1);
  ok(w.length === 2 && w[0].endsWith("2130z") && w[1].endsWith("2145z"), "holds the current window and the next");
}

console.log("books");
{
  const bk = normalizeBook({ bids: [{ px: { value: "0.5500" }, qty: "2" }, { px: { value: "0.5600" }, qty: "900" }],
    offers: [{ px: { value: "0.5800" }, qty: "5" }, { px: { value: "0.5700" }, qty: "1092" }], transactTime: "2026-09-28T21:35:32Z" });
  ok(bk.b[0][0] === 0.56 && bk.a[0][0] === 0.57 && bk.a[0][1] === 1092, "bids and offers ordered best-first");
  ok(bk.x === Date.parse("2026-09-28T21:35:32Z"), "transactTime kept");
  ok(normalizeBook({ bids: [], asks: [{ px: { value: "0.5" }, qty: "1" }] }).a.length === 0, "`asks` is not the ask side (it is `offers`)");
}

console.log("the secret");
{
  const { secret } = newSecret();
  ok(secret.length === 88, "88 base64 characters, as on the box");
  let threw = null; try { parsePolyUsSecret(secret + "\n"); } catch (e) { threw = e; }
  ok(!threw, "a trailing newline is trimmed");
  const other = newSecret().secret;
  const spliced = Buffer.concat([Buffer.from(secret, "base64").subarray(0, 32), Buffer.from(other, "base64").subarray(32)]).toString("base64");
  try { parsePolyUsSecret(spliced); threw = null; } catch (e) { threw = e; }
  ok(threw && /does not match/.test(threw.message) && !threw.message.includes(spliced.slice(0, 12)), "a damaged secret is refused without echoing it");
  const h = polyUsAuthHeaders("id", parsePolyUsSecret(secret), "get", "/v1/ws/markets?x=1", 1790631000000);
  ok(h["X-PM-Timestamp"] === "1790631000000" && h["X-PM-Access-Key"] === "id" && Buffer.from(h["X-PM-Signature"], "base64").length === 64, "signed headers");
}

function run({ fake = {}, listed = "() => true", storage = "ok", seconds = 3, envx = {}, secretOverride = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pmus15-"));
  const arch = join(dir, "arch"); mkdirSync(arch);
  const { secret, publicKeyPem } = newSecret();
  const kf = join(dir, "polyus.key"); writeFileSync(kf, (secretOverride || secret) + "\n");
  const res = join(dir, "res.json"), h = join(dir, "h.mjs");
  writeFileSync(h, `
    import { writeFileSync } from "node:fs";
    import { installFakePolyUs, FAKE_PMUS_WS, FAKE_PMUS_GATEWAY } from ${JSON.stringify(join(HERE, "fake-polyus.mjs"))};
    const uploads = [];
    const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    const fake = installFakePolyUs({
      publicKeyPem: ${JSON.stringify(publicKeyPem)}, listed: ${listed}, ...${JSON.stringify(fake)},
      fallback: async (url, init) => {
        if (url.includes("/rest/v1/")) return reply(200, []);
        if (url.includes("/storage/v1/object/")) {
          if (${JSON.stringify(storage)} === "nobucket") return reply(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
          uploads.push({ path: url.split("/storage/v1/object/")[1], body: Buffer.from(init.body).toString("base64") });
          return reply(200, { Key: "x" });
        }
        return reply(404, {});
      },
    });
    Object.assign(process.env, {
      PMUS_WS_URL: FAKE_PMUS_WS, PMUS_GATEWAY_BASE: FAKE_PMUS_GATEWAY,
      PMUS_KEY_FILE: ${JSON.stringify(kf)}, PM_KEY_ID: "test-pm-key",
      SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fake",
      STREAM_DIR: ${JSON.stringify(arch)}, INVOCATION_ID: "t",
      STREAM_RUN_MINUTES: String(${seconds} / 60), STREAM_ALIGN_EXIT: "0",
      STREAM_ROTATE_MS: "1200", STREAM_TICK_MS: "100", STREAM_UPLOAD_MS: "500", STREAM_STATS_MS: "100000",
      STREAM_HEARTBEAT_MS: "400", PMUS_RETRY_SUBSCRIBE_MS: "400", PMUS_BACKOFF_MS: "50",
      ...${JSON.stringify(envx)},
    });
    delete process.env.CREDENTIALS_DIRECTORY; delete process.env.GITHUB_ACTIONS; delete process.env.PMUS_SOURCE;
    process.on("exit", () => writeFileSync(${JSON.stringify(res)}, JSON.stringify({ uploads, log: fake.log })));
    await import(${JSON.stringify(join(HERE, "pmus15-stream.mjs"))});
  `);
  let code = 0, text = "";
  try { text = execFileSync(process.execPath, [h], { stdio: "pipe", timeout: 30000 }).toString(); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  const r = JSON.parse(readFileSync(res, "utf8"));
  const local = readdirSync(arch);
  const files = [
    ...r.uploads.filter(u => u.path.endsWith(".gz")).map(u => ({ name: u.path, buf: Buffer.from(u.body, "base64") })),
    ...local.filter(n => n.endsWith(".ndjson.gz")).map(n => ({ name: n, buf: readFileSync(join(arch, n)) })),
  ];
  const leaked = text.includes(secret) || text.includes(secret.slice(0, 20));
  return { code, text, ...r, local, files, leaked };
}

const linesOf = f => gunzipSync(f.buf).toString().trim().split("\n").map(l => JSON.parse(l));
const base = n => n.split("/").pop().replace(/^\d{4}-\d\d-\d\d_\d\d_/, "");
const allLines = files => [...files].sort((a, b) => base(a.name).localeCompare(base(b.name))).flatMap(linesOf);
const current = () => wantedSlugs(Date.now(), ["btc"], 0)[0];

console.log("a normal run");
{
  const r = run();
  ok(r.code === 0, "exits cleanly at the end of its run", r);
  ok(r.uploads.some(u => u.path === "stream-archive/pmus15/_probe/box.txt"), "proves the bucket before recording", r);
  const gz = r.uploads.filter(u => u.path.endsWith(".gz"));
  ok(gz.length >= 1 && gz.every(u => /^stream-archive\/pmus15\/\d{4}-\d\d-\d\d\/\d\d\/\d{8}T\d{9}Z_box\.ndjson\.gz$/.test(u.path)), "files are uploaded to pmus15/<day>/<hour>/", r);
  let clean = true; for (const f of r.files) { try { if (linesOf(f)[0].k !== "meta") clean = false; } catch { clean = false; } }
  ok(clean, "every file is a complete gzip that opens with a meta line", r);
  const L = allLines(r.files), kind = k => L.filter(l => l.k === k);
  const cur = current();
  const pb = kind("pb").filter(l => l.m === cur);
  ok(pb.length > 5, `books recorded for the current window (${pb.length})`, r);
  ok(pb.every(l => l.a.length > 0 && l.b.length > 0 && l.b[0][0] > l.b[1][0] && l.a[0][0] < l.a[1][0] && l.b[0][0] < l.a[0][0]), "every book two-sided, best-first, uncrossed", r);
  ok(pb.every(l => Number.isFinite(l.x) && Number.isFinite(l.t)), "each book carries the exchange's time and the box's", r);
  let dup = 0; const last = new Map();
  for (const l of pb) { const k = JSON.stringify([l.st, l.b, l.a]), p = last.get(l.m); if (p && p.k === k && l.t - p.t < 400) dup++; last.set(l.m, { k, t: l.t }); }
  ok(dup === 0, "an unchanged book is not written again inside the heartbeat", r);
  ok(kind("tr").some(l => l.m === cur && l.p === 0.5 && l.q === 10 && l.side === "BUY"), "trades recorded", r);
  const mk = kind("mkt");
  ok(mk.length >= 2 && mk.every(l => /^KXBTC15M-\d\d[A-Z]{3}\d{6}-\d\d$/.test(l.kalshi)), "each window names its Kalshi twin", r);
  const subs = r.log.commands.filter(c => c.subscribe).map(c => c.subscribe);
  ok(subs.some(s => s.subscriptionType === "SUBSCRIPTION_TYPE_MARKET_DATA" && s.marketSlugs[0] === wantedSlugs(Date.now(), ["btc"], 1)[1])
    || subs.some(s => s.marketSlugs[0] !== cur), "the NEXT window is subscribed ahead", r);
  ok(r.log.sockets === 1, "one socket, not one per window", r);
  ok(!r.leaked, "the secret appears nowhere in the output", r);
}

console.log("the next window is not listed yet");
{
  const r = run({ listed: `slug => slug === ${JSON.stringify(current())}`, seconds: 2.5 });
  const L = allLines(r.files);
  ok(r.code === 0, "not a crash", r);
  ok(L.some(l => l.k === "err" && /^md:/.test(l.id)), "the refusal is on the tape", r);
  const asks = r.log.commands.filter(c => c.subscribe && c.subscribe.marketSlugs[0] !== current() && c.subscribe.subscriptionType === "SUBSCRIPTION_TYPE_MARKET_DATA");
  ok(asks.length >= 2, `and it is asked for again (${asks.length} times)`, r);
  const cmds = r.log.commands.filter(c => (c.subscribe?.requestId || c.unsubscribe?.requestId || "").startsWith("tr:") && !(c.subscribe?.marketSlugs?.[0] === current()));
  let open = 0, maxOpen = 0;
  for (const c of cmds) { open = Math.max(0, open + (c.subscribe ? 1 : -1)); maxOpen = Math.max(maxOpen, open); }
  ok(maxOpen === 1, "each retry drops the earlier request first, so trades are never subscribed twice", r);
  ok(L.some(l => l.k === "pb" && l.m === current()), "the current window is still recorded", r);
}

console.log("the server drops the socket");
{
  const r = run({ fake: { dropSocketAfterMs: 700 }, seconds: 3 });
  const L = allLines(r.files);
  const closeAt = L.find(l => l.k === "conn" && l.ev === "close")?.t;
  ok(closeAt && r.log.sockets >= 2, "the close is recorded and the socket reopened", r);
  ok(L.some(l => l.k === "pb" && l.t > closeAt + 50), "recording resumes on the new connection", r);
  ok(r.log.rejected === 0, "the reconnect is freshly signed and accepted", r);
  const resub = r.log.commands.filter(c => c.socket === 2 && c.subscribe);
  ok(resub.some(c => c.subscribe.marketSlugs[0] === current()), "and resubscribes the windows it held", r);
}

console.log("a silent socket");
{
  const r = run({ fake: { silentAfterMs: 500 }, envx: { STREAM_SILENCE_MS: "600" }, seconds: 3 });
  const L = allLines(r.files);
  ok(L.some(l => l.k === "conn" && l.ev === "silent") && r.log.sockets >= 2, "is noticed and replaced", r);
}

console.log("a key the socket refuses");
{
  const r = run({ secretOverride: newSecret().secret, envx: { STREAM_MAX_REFUSED: "3" }, seconds: 20 });
  ok(r.code === 3 && /refused 3 handshakes/.test(r.text) && /PM_KEY_ID/.test(r.text), "exits 3 (the unit does not restart it), naming the key", r);
  ok(r.log.handshakes === 3, "after exactly the allowed attempts", r);
  ok(!r.leaked, "without printing the secret", r);
}

console.log("refused handshakes during an OUTAGE (the gateway is down too)");
{
  const r = run({ secretOverride: newSecret().secret, fake: { gatewayDown: true }, envx: { STREAM_MAX_REFUSED: "2" }, seconds: 2 });
  ok(r.code === 0 && /treating it as an outage/.test(r.text), "keeps trying rather than exiting: a window not recorded is lost", r);
  ok(allLines(r.files).some(l => l.k === "conn" && l.ev === "outage"), "and the outage is on the tape", r);
}

console.log("a skewed clock");
{
  const r = run({ fake: { clockOffsetMs: 120000 } });
  ok(r.code === 1 && /clock is -?\d+\.\ds off/.test(r.text), "fatal, and says it is the clock", r);
  ok(r.log.handshakes === 0, "before any socket is opened", r);
}

console.log("a damaged secret");
{
  const a = newSecret().secret, b = newSecret().secret;
  const spliced = Buffer.concat([Buffer.from(a, "base64").subarray(0, 32), Buffer.from(b, "base64").subarray(32)]).toString("base64");
  const r = run({ secretOverride: spliced });
  ok(r.code === 1 && /damaged/.test(r.text) && r.log.handshakes === 0, "fatal before any socket", r);
  ok(!r.text.includes(spliced.slice(0, 20)), "without printing it", r);
}

console.log("no bucket (migration 0029 not run)");
{
  const r = run({ storage: "nobucket" });
  ok(r.code === 1 && /0029_stream_archive_bucket/.test(r.text), "fatal at startup, naming the migration", r);
  ok(r.log.handshakes === 0, "before any socket is opened", r);
}

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
