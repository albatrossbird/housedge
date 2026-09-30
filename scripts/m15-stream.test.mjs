// The stream recorder, end to end against scripts/fake-kalshi.mjs and a
// fake Supabase (PostgREST credential probe + Storage).
//
// Rules pinned here:
//   1. Every file that leaves the box is a complete gzip whose first line
//      says what it is, and a file is deleted locally ONLY after its
//      upload succeeded.
//   2. The final-window record REPLAYS: the "full" book plus every "d"
//      line reproduces each once-a-second "b" snapshot exactly. If a
//      delta were dropped or mis-signed, the two would disagree.
//   3. A lost frame is recorded as a gap, repaired with get_snapshot, and
//      recording resumes.
//   4. A dropped socket is reconnected and recording resumes.
//   5. A missing bucket is fatal at startup, naming the migration.
//   6. Markets are subscribed AHEAD (initialized), added as they appear,
//      and removed after they close.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, readdirSync, mkdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

function run({ fake = {}, storage = "ok", seconds = 4, envx = {}, leftover = false, later = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "m15stream-"));
  const arch = join(dir, "arch"); mkdirSync(arch);
  if (leftover) writeFileSync(join(arch, "2026-09-26_14_20260926T140000Z_box.ndjson.gz.part"), Buffer.from([0x1f, 0x8b]));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kf = join(dir, "k.pem"); writeFileSync(kf, privateKey.export({ type: "pkcs8", format: "pem" }));
  const res = join(dir, "res.json"), h = join(dir, "h.mjs");
  writeFileSync(h, `
    import { writeFileSync } from "node:fs";
    import { installFakeKalshi, FAKE_REST, FAKE_WS } from ${JSON.stringify(join(HERE, "fake-kalshi.mjs"))};
    const uploads = [];
    const O = ${JSON.stringify({ storage })};
    let uploadCalls = 0;
    const now = Date.now();
    const iso = ms => new Date(now + ms).toISOString();
    const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    const fake = installFakeKalshi({
      publicKeyPem: ${JSON.stringify(publicKey.export({ type: "spki", format: "pem" }))},
      markets: ["KXBTC15M-A", "KXBTC15M-NEXT", "KXETH15M-SOON"],
      statuses: { "KXBTC15M-NEXT": "initialized" },
      closeTimes: { "KXBTC15M-A": iso(60000), "KXBTC15M-NEXT": iso(960000), "KXETH15M-SOON": iso(1500) },
      ...${JSON.stringify(fake)},
      fallback: async (url, init) => {
        if (url.includes("/rest/v1/")) return reply(200, []);
        if (url.includes("/storage/v1/object/")) {
          uploadCalls++;
          if (O.storage === "nobucket") return reply(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
          if (O.storage === "fail-after-probe" && uploadCalls > 1) return reply(500, { message: "boom" });
          uploads.push({ path: url.split("/storage/v1/object/")[1], body: Buffer.from(init.body).toString("base64") });
          return reply(200, { Key: "x" });
        }
        return reply(404, {});
      },
    });
    ${later}
    process.env.KALSHI_REST_BASE = FAKE_REST;
    process.env.KALSHI_WS_URL = FAKE_WS;
    Object.assign(process.env, {
      KALSHI_KEY_FILE: ${JSON.stringify(kf)}, KALSHI_KEY_ID: "test-key-id",
      SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fake",
      STREAM_DIR: ${JSON.stringify(arch)}, INVOCATION_ID: "t", KALSHI_WS_CLIENT: "global", M15_SERIES: "all",
      STREAM_RUN_MINUTES: String(${seconds} / 60), STREAM_ALIGN_EXIT: "0",
      STREAM_ROTATE_MS: "1500", STREAM_SNAPSHOT_MS: "200", STREAM_DISCOVER_MS: "400", STREAM_UPLOAD_MS: "700",
      STREAM_FINAL_SECONDS: "59", STREAM_REMOVE_AFTER_CLOSE_MS: "300", STREAM_STATS_MS: "100000", STREAM_SERIES_MS: "1000", STREAM_HEALTH_MS: "500",
      ...${JSON.stringify(envx)},
    });
    delete process.env.CREDENTIALS_DIRECTORY; delete process.env.GITHUB_ACTIONS; delete process.env.M15_SOURCE;
    process.on("exit", () => writeFileSync(${JSON.stringify(res)}, JSON.stringify({ uploads, log: fake.log })));
    await import(${JSON.stringify(join(HERE, "m15-stream.mjs"))});
  `);
  let code = 0, text = "";
  try { text = execFileSync(process.execPath, [h], { stdio: "pipe", timeout: 30000 }).toString(); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  const r = JSON.parse(readFileSync(res, "utf8"));
  const local = readdirSync(arch);
  // Every archive line, uploaded files then whatever is still local, in name order.
  const files = [
    ...r.uploads.filter(u => u.path.endsWith(".gz")).map(u => ({ name: u.path, buf: Buffer.from(u.body, "base64") })),
    ...local.filter(n => n.endsWith(".ndjson.gz")).map(n => ({ name: n, buf: readFileSync(join(arch, n)), local: true })),
  ];
  return { code, text, ...r, local, files };
}

const linesOf = f => gunzipSync(f.buf).toString().trim().split("\n").map(l => JSON.parse(l));
const byTime = files => files.filter(f => !/truncated/.test(f.name))
  .sort((a, b) => base(a.name).localeCompare(base(b.name))).flatMap(linesOf);
// A local name carries a <day>_<hour>_ prefix that the uploaded path turns into folders.
const base = n => n.split("/").pop().replace(/^\d{4}-\d\d-\d\d_\d\d_/, "");

let failed = 0;
const ok = (c, w, r) => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${r?.text?.slice(-1500) || ""}`); } };

console.log("a normal run");
{
  const r = run({ later: `setTimeout(() => fake.addMarket("KXSOL15M-NEW", { close: iso(300000) }), 1200);` });
  ok(r.code === 0, "exits cleanly at the end of its run", r);
  ok(r.uploads.some(u => u.path === "stream-archive/m15/_probe/box.txt"), "proves the bucket before recording", r);
  const gz = r.uploads.filter(u => u.path.endsWith(".gz"));
  ok(gz.length >= 1 && gz.every(u => /^stream-archive\/m15\/\d{4}-\d\d-\d\d\/\d\d\/\d{8}T\d{9}Z_box\.ndjson\.gz$/.test(u.path)), "rotated files are uploaded to m15/<day>/<hour>/", r);
  let clean = true; for (const f of r.files) { try { const L = linesOf(f); if (L[0].k !== "meta") clean = false; } catch { clean = false; } }
  ok(clean, "every file is a complete gzip that opens with a meta line", r);
  ok(r.local.filter(n => n.endsWith(".gz")).length <= 1 && !r.local.some(n => n.endsWith(".part")), "only the last file is left locally, closed (the next run uploads it)", r);

  const L = byTime(r.files);
  const kinds = k => L.filter(l => l.k === k);
  ok(kinds("b").some(l => l.m === "KXBTC15M-A") && kinds("b").some(l => l.m === "KXBTC15M-NEXT"), "books recorded for the open market and the NEXT, not-yet-open one", r);
  ok(kinds("i5").length > 5 && kinds("i1").length > 0, "index ticks recorded (5Hz and 1Hz)", r);
  ok(kinds("final").some(l => l.m === "KXBTC15M-A") && kinds("d").some(l => l.m === "KXBTC15M-A"), "final window: marked, and every change recorded", r);
  ok(!kinds("d").some(l => l.m === "KXBTC15M-NEXT"), "no per-change record outside a final window", r);
  ok(kinds("gap").length === 0, "a clean run records NO gaps, though markets are added and removed (Kalshi's ok replies consume a sequence number)", r);
  const adds = r.log.commands.filter(c => c.params?.action === "add_markets").flatMap(c => c.params.market_tickers);
  ok(adds.includes("KXSOL15M-NEW") && kinds("b").some(l => l.m === "KXSOL15M-NEW"), "a market listed mid-run is added and recorded", r);
  const dels = r.log.commands.filter(c => c.params?.action === "delete_markets").flatMap(c => c.params.market_tickers);
  ok(dels.includes("KXETH15M-SOON"), "a closed market is removed from the subscription", r);
  const sub = r.log.commands.find(c => c.cmd === "subscribe" && c.params.channels.includes("orderbook_delta"));
  ok(sub?.params.use_yes_price === true, "use_yes_price is sent explicitly", r);
  const hs = kinds("health");
  ok(hs.length >= 3 && hs.every(h => h.lagP50 == null || h.lagP50 < 1000) && hs.some(h => h.frames > 0 && Number.isFinite(h.elu)), "a health line every interval: frames, event-loop load, receive lag", r);
  ok(!/BEHIND/.test(r.text), "a recorder keeping up does not warn", r);

  // Rule 2: replay.
  let book = null, checked = 0, bad = 0;
  const top = (m, n, dir) => [...m].sort((a, b) => dir * (a[0] - b[0])).slice(0, n).map(([p, s]) => [p / 1000, s]);
  for (const l of L) {
    if (l.m !== "KXBTC15M-A") continue;
    if (l.k === "full") book = { b: new Map(l.L[0].map(([p, s]) => [Math.round(p * 1000), s])), a: new Map(l.L[1].map(([p, s]) => [Math.round(p * 1000), s])) };
    else if (l.k === "d" && book) {
      const side = book[l.sd], p = Math.round(l.p * 1000), n = Math.round(((side.get(p) || 0) + l.q) * 100) / 100;
      if (n > 0) side.set(p, n); else side.delete(p);
    } else if (l.k === "b" && book) {
      checked++;
      if (JSON.stringify([top(book.b, 10, -1), top(book.a, 10, 1)]) !== JSON.stringify(l.L)) bad++;
    }
  }
  ok(checked >= 3 && bad === 0, `the final-window record replays to every snapshot (${checked} checked, ${bad} mismatched)`, r);
}

console.log("\na recorder that is behind the socket");
{
  // Kalshi's ts_ms a minute before the box receives it: what a recorder
  // that cannot keep up looks like from inside.
  const r = run({ fake: { tsLagMs: 60000 } });
  const hs = byTime(r.files).filter(l => l.k === "health" && l.lagP50 != null);
  ok(hs.length >= 1 && hs.every(h => h.lagP50 >= 59000), "the lag is measured against Kalshi's own timestamp", r);
  ok(/recorder is BEHIND the socket: receive lag p50 6\d\.\ds/.test(r.text), "and warned on, with the figure", r);
}

console.log("\nclosing on the exchange's clock");
{
  // KXETH15M-SOON closes 1.5s into the run. With Kalshi's timestamps 3s
  // behind the box, a box-clock recorder retires it at ~1.8s with its last
  // deltas still queued; on the exchange's clock it is still open when the
  // run ends.
  const r = run({ fake: { tsLagMs: 3000 } });
  const dels = r.log.commands.filter(c => c.params?.action === "delete_markets").flatMap(c => c.params.market_tickers);
  ok(r.code === 0 && !dels.includes("KXETH15M-SOON"), "a market is not retired before the exchange's clock reaches its close", r);
  const L = byTime(r.files);
  const last = Math.max(...L.filter(l => l.k === "b" && l.m === "KXETH15M-SOON").map(l => l.t));
  const close = L.find(l => l.k === "mkt" && l.m === "KXETH15M-SOON")?.close;
  ok(Number.isFinite(last) && close && last > Date.parse(close) + 1000, "its book keeps being recorded past the close on the box's clock", r);
}

console.log("\na lost frame");
{
  const r = run({ fake: { seqSkipAt: 20 } });
  const L = byTime(r.files);
  ok(L.some(l => l.k === "gap"), "the gap is recorded", r);
  ok(r.log.commands.some(c => c.params?.action === "get_snapshot"), "and repaired with get_snapshot", r);
  const gapAt = L.find(l => l.k === "gap")?.t;
  ok(L.some(l => l.k === "b" && l.t > gapAt), "and recording resumes after it", r);
}

console.log("\nthe server drops the socket");
{
  const r = run({ fake: { dropSocketAfterMs: 1000 }, seconds: 5 });
  const L = byTime(r.files);
  const closeAt = L.find(l => l.k === "conn" && l.ev === "close")?.t;
  ok(closeAt && L.filter(l => l.k === "conn" && l.ev === "open").length >= 2, "the close is recorded and the socket reopened", r);
  ok(L.some(l => l.k === "b" && l.t > closeAt + 500) && L.some(l => l.k === "i5" && l.t > closeAt + 500), "recording resumes on the new connection", r);
  ok(r.log.sockets >= 2 && r.log.rejected === 0, "the reconnect is freshly signed and accepted", r);
}

console.log("\na key the socket refuses");
{
  const r = run({ fake: { keyId: "some-other-key" }, envx: { STREAM_MAX_REFUSED: "2" }, seconds: 20 });
  ok(r.code === 1 && /refused 2 handshakes/.test(r.text), "exits with an error instead of retrying forever", r);
}

console.log("\nno bucket (migration 0029 not run)");
{
  const r = run({ storage: "nobucket" });
  ok(r.code === 1 && /0029_stream_archive_bucket\.sql/.test(r.text), "fatal at startup, naming the migration", r);
  ok(r.log.sockets === 0, "before any socket is opened", r);
}

console.log("\nuploads failing mid-run");
{
  const r = run({ storage: "fail-after-probe" });
  ok(r.local.filter(n => n.endsWith(".ndjson.gz")).length >= 2, "files are KEPT locally when the upload fails", r);
  ok(/upload .* failed/.test(r.text), "and the failure is reported", r);
}

console.log("\na file left by a crashed run");
{
  const r = run({ leftover: true });
  ok(r.uploads.some(u => /20260926T140000Z_box-truncated\.ndjson\.gz$/.test(u.path)), "is uploaded, labelled truncated", r);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
