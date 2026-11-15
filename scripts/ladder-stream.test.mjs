// The ladder recorder (scripts/ladder-stream.mjs), end to end against
// scripts/fake-kalshi.mjs and a fake Storage: it must record only the
// markets near the money for a close, every change of them, and stop
// itself (exit 3) when the box is short of memory.
//
// The fake verifies our signature and serves one book per market in the
// encoding the subscription asked for; the book encoding itself is pinned
// by scripts/m15-stream.test.mjs, whose recorder writes the same lines.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const P = 4000; // a "close" every 4 seconds

function run({ seconds = 11, envx = {}, quoted = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ladderstream-"));
  const arch = join(dir, "arch"); mkdirSync(arch);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kf = join(dir, "k.pem"); writeFileSync(kf, privateKey.export({ type: "pkcs8", format: "pem" }));
  const res = join(dir, "res.json"), h = join(dir, "h.mjs");
  writeFileSync(h, `
    import { writeFileSync } from "node:fs";
    import { installFakeKalshi, FAKE_REST, FAKE_WS } from ${JSON.stringify(join(HERE, "fake-kalshi.mjs"))};
    const uploads = [];
    const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
    // The close the fake's markets carry: a boundary 1 to 5 seconds away.
    const close = Math.ceil((Date.now() + 1000) / ${P}) * ${P}, iso = new Date(close).toISOString();
    const q = ${JSON.stringify(quoted)};
    const thr = (k, mid) => ({ strike_type: "greater", floor_strike: k, yes_bid_dollars: q ? (mid - 0.01).toFixed(4) : "0.0000", yes_ask_dollars: q ? (mid + 0.01).toFixed(4) : "1.0000" });
    const fake = installFakeKalshi({
      publicKeyPem: ${JSON.stringify(publicKey.export({ type: "spki", format: "pem" }))},
      markets: ["KXBTCD-H-T75999.99", "KXBTCD-H-T76499.99", "KXBTCD-H-T89999.99", "KXBTC-H-B76050", "KXBTC-H-B60050", "KXBTC15M-H-00"],
      closeTimes: Object.fromEntries(["KXBTCD-H-T75999.99", "KXBTCD-H-T76499.99", "KXBTCD-H-T89999.99", "KXBTC-H-B76050", "KXBTC-H-B60050", "KXBTC15M-H-00"].map(t => [t, iso])),
      marketFields: {
        "KXBTCD-H-T75999.99": thr(75999.99, 0.5), "KXBTCD-H-T76499.99": thr(76499.99, 0.3), "KXBTCD-H-T89999.99": thr(89999.99, 0.02),
        "KXBTC-H-B76050": { strike_type: "between", floor_strike: 76000, cap_strike: 76099.99, yes_bid_dollars: "0.0500", yes_ask_dollars: "0.0700" },
        "KXBTC-H-B60050": { strike_type: "between", floor_strike: 60000, cap_strike: 60099.99, yes_bid_dollars: "0.0000", yes_ask_dollars: "0.0100" },
        "KXBTC15M-H-00": { strike_type: "greater_or_equal", floor_strike: null },
      },
      fallback: async (url, init) => {
        if (url.includes("/rest/v1/")) return reply(200, []);
        if (url.includes("/storage/v1/object/")) { uploads.push({ path: url.split("/storage/v1/object/")[1], body: Buffer.from(init.body).toString("base64") }); return reply(200, { Key: "x" }); }
        return reply(404, {});
      },
    });
    process.env.KALSHI_REST_BASE = FAKE_REST;
    process.env.KALSHI_WS_URL = FAKE_WS;
    Object.assign(process.env, {
      KALSHI_KEY_FILE: ${JSON.stringify(kf)}, KALSHI_KEY_ID: "test-key-id",
      SUPABASE_URL: "https://fake.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fake",
      LADDER_DIR: ${JSON.stringify(arch)}, INVOCATION_ID: "t", KALSHI_WS_CLIENT: "global",
      LADDER_PERIOD_MS: "${P}", LADDER_LEAD_SECONDS: "2.5", LADDER_SELECT_AHEAD_MS: "300", LADDER_END_AFTER_MS: "300",
      LADDER_ROTATE_MS: "600000", LADDER_HEALTH_MS: "400", LADDER_UPLOAD_MS: "600000", LADDER_SILENCE_MS: "1500", LADDER_STATS_MS: "100000", LADDER_RUN_MINUTES: "600",
      ...${JSON.stringify(envx)},
    });
    delete process.env.CREDENTIALS_DIRECTORY; delete process.env.GITHUB_ACTIONS; delete process.env.LADDER_SOURCE;
    process.on("exit", () => writeFileSync(${JSON.stringify(res)}, JSON.stringify({ uploads, close: iso })));
    setTimeout(() => process.kill(process.pid, "SIGTERM"), ${seconds * 1000});
    await import(${JSON.stringify(join(HERE, "ladder-stream.mjs"))});
  `);
  let code = 0, text = "";
  try { text = execFileSync(process.execPath, [h], { stdio: "pipe", timeout: 40000 }).toString(); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  const r = JSON.parse(readFileSync(res, "utf8"));
  const bufs = [
    ...r.uploads.filter(u => u.path.startsWith("stream-archive/ladder/") && u.path.endsWith(".gz")).map(u => Buffer.from(u.body, "base64")),
    ...readdirSync(arch).filter(n => n.endsWith(".ndjson.gz")).map(n => readFileSync(join(arch, n))),
  ];
  const lines = bufs.flatMap(b => gunzipSync(b).toString().trim().split("\n").map(l => JSON.parse(l)));
  return { code, text, lines, close: r.close, uploads: r.uploads };
}

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

console.log("one close, recorded");
{
  const r = run();
  const sel = r.lines.filter(l => l.k === "sel" && l.close === r.close);
  ok(r.code === 0, `SIGTERM is a clean exit (${r.code})${r.code ? "\n" + r.text.slice(-600) : ""}`);
  ok(sel.length === 1 && sel[0].ref === 75999.99, `one selection for the close, referenced to the at-the-money strike (${JSON.stringify(sel[0])})`);
  const want = ["KXBTC-H-B76050", "KXBTC15M-H-00", "KXBTCD-H-T75999.99", "KXBTCD-H-T76499.99"];
  const mkts = r.lines.filter(l => l.k === "mkt").map(l => l.m).sort();
  ok(JSON.stringify(mkts) === JSON.stringify(want), `the 15-minute market and the three within 2.5% (${mkts.join(" ")})`);
  const m = r.lines.find(l => l.k === "mkt" && l.m === "KXBTC-H-B76050");
  ok(m.type === "between" && m.floor === 76000 && m.cap === 76099.99 && m.close === r.close, "each market's strike fields are in the archive");
  const touched = new Set(r.lines.filter(l => l.k === "full" || l.k === "d" || l.k === "tr").map(l => l.m));
  ok(!touched.has("KXBTCD-H-T89999.99") && !touched.has("KXBTC-H-B60050"), "the far strikes were never subscribed");
  ok(want.every(t => r.lines.some(l => l.k === "full" && l.m === t)), "every chosen market has its full book");
  const d = r.lines.filter(l => l.k === "d");
  ok(d.length > 20 && d.every(x => Number.isFinite(x.x) && Number.isFinite(x.seq) && (x.sd === "b" || x.sd === "a")), `every change is written with Kalshi's timestamp and sequence (${d.length})`);
  ok(r.lines.some(l => l.k === "tr" && Number.isFinite(l.x)), "trades are written");
  ok(r.lines.some(l => l.k === "end" && l.close === r.close && l.n === 4), "the close is ended");
  const closeMs = Date.parse(r.close);
  ok(d.every(x => x.x <= closeMs + 300 + 1500), "nothing is recorded long after the close");
  ok(d.some(x => x.x >= closeMs - 2500) && !d.some(x => x.x < closeMs - 2500 - 400), "recording starts at the lead, not before");
  ok(r.lines.some(l => l.k === "health" && l.memMB != null && l.lagP99 != null), "health lines carry lag and memory");
  ok(!r.lines.some(l => l.k === "gap"), "no sequence gap on a clean run");
  ok(r.uploads.some(u => /^stream-archive\/ladder\/\d{4}-\d\d-\d\d\/\d\d\//.test(u.path)), "the file is uploaded under ladder/ on exit");
}

console.log("a ladder nobody quotes");
{
  const r = run({ quoted: false, seconds: 7 });
  ok(r.lines.some(l => l.k === "sel" && l.close === r.close && l.ref === null), "the selection says so");
  ok(!r.lines.some(l => l.k === "full" || l.k === "d"), "and nothing is subscribed");
  ok(/no quoted ladder/.test(r.text), "the log names it");
}

console.log("the load stop");
{
  const r = run({ envx: { LADDER_MEM_STOP_MB: "100000000", LADDER_MEM_STOP_RUNS: "2" }, seconds: 20 });
  ok(r.code === 3, `short of memory exits 3, which the unit does not restart (${r.code})`);
  ok(/LOAD STOP/.test(r.text) && /memory available/.test(r.text), "and says why");
  ok(r.lines.some(l => l.k === "conn" && l.ev === "stop" && /load stop/.test(l.why)), "the archive records the stop");
}
{
  const r = run({ envx: { LADDER_LAG_STOP_MS: "-1", LADDER_LAG_STOP_RUNS: "2" }, seconds: 20 });
  ok(r.code === 3 && /receive lag p99/.test(r.text), `falling behind the socket exits 3 too (${r.code})`);
}

if (bad) { console.error(`\n${bad} failed`); process.exit(1); }
console.log("\nall ok");
