// Retention, driven end to end against a fake PostgREST.
//
// THE CAP THAT READ AS A TABLE SIZE. The daily job printed
//
//   pruned 9059 of 200000 markets        (2026-09-28)
//   pruned 4017 of 200000 markets        (2026-09-26)
//
// 200,000 was prune's own `maxRows`, and hitting it returned what it
// had with nothing said. Every market past the 200,000th id could never
// be pruned however long it had been delisted, so the part of the table
// the pruner could not see was the part that grew.
//
// The fake serves 201,000 rows so the tail sits past the old cap, and
// holds a delisted market there.
import { runPrune } from "../lib/pruneMarkets.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const now = Math.floor(Date.now() / 1000);
const OLD = now - 30 * 86400;

function fakeDb({ n = 201000, failPairs = false, timeoutOver = Infinity } = {}) {
  // Zero-padded, so string order (Postgres's, for a text key) is numeric order.
  const id = i => `M${String(i).padStart(7, "0")}`;
  const markets = [];
  for (let i = 0; i < n; i++) {
    markets.push({ id: id(i), platform: "kalshi", sport_tag: "politics", updated_at: now, slug: null, resolution: null });
  }
  const tail = markets[n - 1];           // past the old 200,000 cap
  tail.updated_at = OLD;
  const early = markets[10];              // delisted, but paired
  early.updated_at = OLD;
  const loose = markets[5];               // delisted, unpaired, early in the key space
  loose.updated_at = OLD;
  markets[20].resolution = "rules, paired";
  markets[21].resolution = "rules, unreadable";
  markets[22].resolution = "rules, unreadable too";
  const pairs = [{ id: 1, kalshi_id: early.id, polymarket_id: markets[20].id }];

  const calls = { get: [], write: [] };
  const byId = new Map(markets.map(m => [m.id, m]));
  const index = new Map(markets.map((m, i) => [m.id, i]));

  const rest = {
    async get(path) {
      calls.get.push(path);
      const [table, qs] = path.split("?");
      const p = new URLSearchParams(qs);
      if (table === "pairs") {
        if (failPairs) throw new Error("500 canceling statement due to statement timeout");
        const gt = p.get("id");
        const from = gt ? Number(gt.slice(3)) : -Infinity;
        return pairs.filter(r => r.id > from).slice(0, Number(p.get("limit")));
      }
      const cols = p.get("select").split(",");
      const gt = p.get("id");
      let start = 0;
      if (gt) start = index.get(gt.slice(3)) + 1;
      const onlyRes = p.get("resolution") === "not.is.null";
      const out = [];
      for (let i = start; i < markets.length && out.length < Number(p.get("limit")); i++) {
        const m = markets[i];
        if (!m || (onlyRes && m.resolution == null)) continue;
        out.push(Object.fromEntries(cols.map(c => [c, m[c]])));
      }
      return out;
    },
    async write(method, path, body) {
      calls.write.push({ method, path });
      const list = decodeURIComponent(path.match(/id=in\.\((.*)\)$/)[1]);
      const ids = list.split(",").map(s => s.replace(/^"|"$/g, ""));
      if (ids.length > timeoutOver) {
        return { error: '500 {"code":"57014","message":"canceling statement due to statement timeout"}' };
      }
      let count = 0;
      for (const i of ids) {
        const m = byId.get(i);
        if (!m) continue;
        count++;
        if (method === "DELETE") { byId.delete(i); markets[index.get(i)] = null; }
        else Object.assign(m, body);
      }
      return { count };
    },
  };
  return { rest, calls, tail, early, loose, byId, markets };
}

console.log("the whole table is read — nothing past a cap goes unseen");
{
  const db = fakeDb();
  const { status, body } = await runPrune({}, { rest: db.rest });
  ok(status === 200, `200 (got ${status}${body.error ? `: ${body.error}` : ""})`);
  ok(body.marketsScanned === 201000, `scanned 201,000, not 200,000 (got ${body.marketsScanned})`);
  ok(!db.byId.has(db.tail.id), "the delisted market past the old cap is deleted");
  ok(!db.byId.has(db.loose.id), "the delisted market early in the key space is deleted");
  ok(db.byId.has(db.early.id), "a delisted market that is PAIRED survives");
  ok(body.deleted === 2 && body.candidates === 2, `deleted=${body.deleted} candidates=${body.candidates}`);
  ok(db.calls.get.every(q => /order=id\.asc/.test(q)), "every read is keyset-ordered");
}

console.log("\nresolution text is cleared only where nothing can read it");
{
  const db = fakeDb({ n: 50 });
  const { body } = await runPrune({}, { rest: db.rest });
  ok(body.resolutionRowsCarrying === 3, `3 rows carrying (got ${body.resolutionRowsCarrying})`);
  ok(body.resolutionCleared === 2, `2 cleared (got ${body.resolutionCleared})`);
  ok(db.markets[20].resolution === "rules, paired", "the paired row keeps its rules");
  ok(db.markets[21].resolution === null && db.markets[22].resolution === null, "the unreadable ones are nulled");
  ok(db.calls.get.some(q => q.includes("resolution=not.is.null")), "found through the partial-index filter");
}

console.log("\na statement timeout splits the chunk instead of losing it");
{
  // The live 09-28 shape: 200-id updates cancelled by 57014.
  const db = fakeDb({ n: 400, timeoutOver: 60 });
  for (let i = 100; i < 380; i++) db.markets[i].resolution = "text";
  const { body } = await runPrune({}, { rest: db.rest });
  ok(body.resolutionCleared === 282, `every unreadable row cleared (got ${body.resolutionCleared})`);
  ok(body.resolutionErrors.length === 0, `no errors left (got ${JSON.stringify(body.resolutionErrors)})`);
  ok(db.calls.write.some(w => w.method === "PATCH"), "cleared by PATCH, never upsert");
}

console.log("\na failed pairs read refuses the prune");
{
  const db = fakeDb({ n: 50, failPairs: true });
  const { status, body } = await runPrune({}, { rest: db.rest });
  ok(status === 500 && /refusing to prune/.test(body.error), `refused (${status} ${body.error})`);
  ok(db.calls.write.length === 0, "and nothing was written");
}

console.log("\ndry run deletes nothing");
{
  const db = fakeDb({ n: 50 });
  const { body } = await runPrune({ dry: "1" }, { rest: db.rest });
  ok(body.candidates === 2 && body.deleted === 0, `2 candidates, 0 deleted (got ${body.candidates}/${body.deleted})`);
  ok(db.calls.write.length === 0, "no writes at all");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
