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
import { mkdirSync, readFileSync, writeFileSync, renameSync, utimesSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { authHeaders } from "./supabaseHeaders.js";

// Storage answers a burst of downloads with 429, and an overloaded
// database with 5xx (544 is its DatabaseTimeout). Both are "not now",
// not "no": the first archive backtest over ten days died on its first
// 429, and a venue compare on a 544. So each request is retried with
// backoff, honouring Retry-After when given; a 4xx other than 408/429 is
// an answer and is returned at once.
const RETRYABLE = s => s === 0 || s === 408 || s === 429 || s >= 500;
export async function fetchRetrying(doFetch, { tries = 6, baseMs = 1000, maxMs = 30000, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
  for (let i = 1; ; i++) {
    let r, status;
    try { r = await doFetch(); status = r.status; } catch (e) { if (i >= tries) throw e; status = 0; }
    if (r && (r.ok || !RETRYABLE(status))) return r;
    if (i >= tries) return r;
    const ra = Number(r?.headers?.get?.("retry-after"));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, maxMs) : Math.min(baseMs * 2 ** (i - 1), maxMs);
    log(`  storage answered ${status || "a network error"}; retrying in ${(wait / 1000).toFixed(1)}s (${i}/${tries - 1})`);
    try { await r?.body?.cancel?.(); } catch {}
    await sleep(wait);
  }
}

// A local copy of files already downloaded, so a job that reads the same
// days every run (the daily report: 7 days, every morning) pays Storage
// egress for the new day only. Set ARCHIVE_CACHE_DIR, or pass cacheDir.
//
// A cached file is used only when it is the version the listing just
// reported: the recorder uploads with x-upsert, so a file CAN be replaced
// (a re-upload after a crash), and a stale copy would read as a short
// hour. The version is the listing's size plus its updated time; a path
// that was not listed in this run is always downloaded. Nothing is ever
// deleted from Storage; the cache holds copies, and losing it costs only
// a re-download. A hit refreshes the file's mtime, so `find -mtime` can
// prune copies no run has used lately.
export function archiveReader({ url, key, bucket = "stream-archive", log = console.log, retry = {}, cacheDir = process.env.ARCHIVE_CACHE_DIR || null }) {
  const get = doFetch => fetchRetrying(doFetch, { log, ...retry });
  const versions = new Map();   // path -> "size|updated" from this run's listings
  const cache = { hits: 0, hitBytes: 0, misses: 0, missBytes: 0 };
  if (cacheDir) process.once("exit", () => {
    if (cache.hits + cache.misses) log(`archive cache: ${cache.hits} files from disk (${(cache.hitBytes / 1e6).toFixed(0)} MB), ${cache.misses} downloaded (${(cache.missBytes / 1e6).toFixed(0)} MB)`);
  });
  const cachePath = path => join(cacheDir, bucket, path);
  function fromCache(path) {
    const v = versions.get(path);
    if (!cacheDir || v == null) return null;
    const f = cachePath(path);
    try {
      if (!existsSync(f) || readFileSync(f + ".v", "utf8") !== v) return null;
      const buf = readFileSync(f);
      const now = new Date();
      utimesSync(f, now, now); utimesSync(f + ".v", now, now);
      cache.hits++; cache.hitBytes += buf.length;
      return buf;
    } catch { return null; }
  }
  function toCache(path, buf) {
    const v = versions.get(path);
    if (!cacheDir || v == null) return;
    const f = cachePath(path);
    try {
      mkdirSync(dirname(f), { recursive: true });
      // Written whole then renamed, so a run killed mid-write never leaves
      // a short file that a later run would trust.
      writeFileSync(f + ".tmp", buf); renameSync(f + ".tmp", f);
      writeFileSync(f + ".v", v);
    } catch (e) { log(`::warning::archive cache: could not keep ${path} (${e.message})`); }
  }
  // One hour's files under <prefix>/<day>/<hour>/.
  async function listHour(prefix) {
    const out = [];
    for (let offset = 0; ; offset += 100) {
      const r = await get(() => fetch(`${url}/storage/v1/object/list/${bucket}`, {
        method: "POST",
        headers: authHeaders(key, { "Content-Type": "application/json" }),
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
      }));
      if (!r.ok) throw new Error(`list ${prefix}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const page = await r.json();
      for (const e of page.filter(e => e.id && e.name.endsWith(".ndjson.gz"))) {
        const f = { path: prefix + e.name, size: e.metadata?.size ?? null };
        // Unversionable without a size: such a file is never cached.
        if (f.size != null) versions.set(f.path, `${f.size}|${e.updated_at ?? e.metadata?.lastModified ?? ""}`);
        out.push(f);
      }
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

  // The whole compressed file, downloaded before any of it is parsed.
  // Streaming it straight into gunzip held the HTTP body open and PAUSED
  // for as long as the lines took to process; when the server closed that
  // socket meanwhile, Node's fetch asserted (`!this.paused`) and killed the
  // process. Destroying the body when a read stopped early (2026-10-07)
  // did not end it: the daily report died the same way on 2026-10-09 with
  // no early stop at all. An hourly file is a few MB compressed, so holding
  // one costs nothing, the socket is drained as fast as it arrives, and a
  // download cut off part way is retried instead of read as a short file.
  async function download(path) {
    const hit = fromCache(path);
    if (hit) return hit;
    const buf = await fetchFile(path);
    if (cacheDir && versions.has(path)) { cache.misses++; cache.missBytes += buf.length; }
    // Only a complete download of the listed size is kept.
    if (versions.get(path)?.startsWith(`${buf.length}|`)) toCache(path, buf);
    return buf;
  }
  async function fetchFile(path) {
    const tries = retry.tries ?? 4, sleep = retry.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    for (let i = 1; ; i++) {
      const r = await get(() => fetch(`${url}/storage/v1/object/authenticated/${bucket}/${path}`, { headers: authHeaders(key) }));
      if (!r.ok) throw new Error(`download ${path}: ${r.status}`);
      try { return Buffer.from(await new Response(r.body).arrayBuffer()); } catch (e) {
        if (i >= tries) throw new Error(`download ${path}: cut off ${i} times (${e.cause?.code || e.message})`);
        log(`  download ${path} cut off (${e.cause?.code || e.message}); retrying (${i}/${tries - 1})`);
        await sleep(Math.min((retry.baseMs ?? 1000) * 2 ** (i - 1), 30000));
      }
    }
  }

  // Calls onLine(parsedObject) for each line; `keep`, if given, sees the
  // raw text first so a reader interested in a sliver of a large file
  // skips parsing the rest. Returns the count of unparseable lines.
  async function eachLine(path, onLine, keep = null) {
    const gz = await download(path);
    const gunzip = createGunzip();
    const lines = createInterface({ input: Readable.from([gz]).pipe(gunzip), crlfDelay: Infinity });
    let bad = 0;
    try {
      for await (const line of lines) {
        if (!line || (keep && !keep(line))) continue;
        let o; try { o = JSON.parse(line); } catch { bad++; continue; }
        onLine(o);
      }
    } catch (e) {
      // A truncated file (a crashed recorder run) is readable up to its last flush.
      log(`::warning::${path}: stopped early (${e.code || e.message}) — kept what was readable`);
    } finally {
      lines.close(); gunzip.destroy();
    }
    return bad;
  }

  return { listHour, listRange, eachLine };
}
