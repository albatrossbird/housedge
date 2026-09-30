// Reading the WebSocket archives back out of the PRIVATE Storage bucket
// (migration 0029): list an hour's files, stream one through gunzip line
// by line. Shared by the report scripts so they read the same files the
// same way; lib/streamArchive.js is the writing half.
//
// Needs the service-role key — the bucket has no read policy, and must
// never get one (Kalshi's data terms forbid redistributing archived data).
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { authHeaders } from "./supabaseHeaders.js";

export function archiveReader({ url, key, bucket = "stream-archive", log = console.log }) {
  // One hour's files under <prefix>/<day>/<hour>/.
  async function listHour(prefix) {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const r = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
        method: "POST",
        headers: authHeaders(key, { "Content-Type": "application/json" }),
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
      });
      if (!r.ok) throw new Error(`list ${prefix}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const page = await r.json();
      out.push(...page.filter(e => e.id && e.name.endsWith(".ndjson.gz")).map(e => ({ path: prefix + e.name, size: e.metadata?.size ?? null })));
      if (page.length < 100) return out;
    }
  }

  // Every file under <top>/ whose hour folder falls in [fromMs, toMs],
  // oldest first by the start time in the file name.
  async function listRange(top, fromMs, toMs) {
    const files = [];
    for (let h = Math.floor(fromMs / 3600000); h <= Math.floor(toMs / 3600000); h++) {
      const d = new Date(h * 3600000).toISOString();
      files.push(...await listHour(`${top}/${d.slice(0, 10)}/${d.slice(11, 13)}/`));
    }
    return files.sort((a, b) => a.path.split("/").pop().localeCompare(b.path.split("/").pop()));
  }

  // Calls onLine(parsedObject) for each line; `keep`, if given, sees the
  // raw text first so a reader interested in a sliver of a large file
  // skips parsing the rest. Returns the count of unparseable lines.
  async function eachLine(path, onLine, keep = null) {
    const r = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${path}`, { headers: authHeaders(key) });
    if (!r.ok) throw new Error(`download ${path}: ${r.status}`);
    const lines = createInterface({ input: Readable.fromWeb(r.body).pipe(createGunzip()), crlfDelay: Infinity });
    let bad = 0;
    try {
      for await (const line of lines) {
        if (!line || (keep && !keep(line))) continue;
        let o; try { o = JSON.parse(line); } catch { bad++; continue; }
        onLine(o);
      }
    } catch (e) {
      // A truncated file (a crashed run) is readable up to its last flush.
      log(`::warning::${path}: stopped early (${e.code || e.message}) — kept what was readable`);
    }
    return bad;
  }

  return { listHour, listRange, eachLine };
}
