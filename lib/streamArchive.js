// The archive half of the WebSocket recorders: hourly gzipped NDJSON
// files, uploaded to the PRIVATE Storage bucket (migration 0029) and
// deleted locally only after the upload is confirmed.
//
// SHARED BECAUSE TWO COPIES DRIFT. scripts/m15-stream.mjs (Kalshi) and
// scripts/pmus15-stream.mjs (Polymarket US) write the same kind of file
// for the same backtests. A difference in how either names, closes or
// uploads a file would show up as a missing hour on one side of a
// comparison, which reads as a quiet market rather than a recorder bug.
//
// Rules, pinned by scripts/m15-stream.test.mjs and pmus15-stream.test.mjs:
//   - A file without the .part suffix is always a COMPLETE gzip. A crash
//     leaves a .part, which the next run uploads as "-truncated": gzip is
//     readable up to its last flush, and flush() runs every few seconds.
//   - Milliseconds in the name: two files may start in the same second (a
//     restart right after a rotation) and must not overwrite each other.
//   - A failed upload keeps the file and retries; nothing is deleted
//     until Storage has said yes.
//
// The bucket must stay private. Kalshi's data terms forbid handing
// archived data to anyone; never add a read policy to it.
import { createGzip } from "node:zlib";
import { constants as zc } from "node:zlib";
import { createWriteStream, mkdirSync, readdirSync, renameSync, readFileSync, unlinkSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { authHeaders } from "./supabaseHeaders.js";

// 2026-09-26T15:01:30.123Z -> 2026-09-26_15_20260926T150130123Z_box.ndjson.gz
export function archiveFileName(startMs, source) {
  const d = new Date(startMs).toISOString();
  return `${d.slice(0, 10)}_${d.slice(11, 13)}_${d.replace(/[-:.]/g, "").slice(0, 18)}Z_${source}.ndjson.gz`;
}

// -> <prefix>/2026-09-26/15/20260926T150130123Z_box.ndjson.gz
export function archiveRemotePath(prefix, name) {
  const [day, hour, ...rest] = name.split("_");
  return `${prefix}/${day}/${hour}/${rest.join("_")}`;
}

export function createArchive({ dir, bucket, supabaseUrl, key, prefix, source, rotateMs = 3600000, meta, log = console.log }) {
  const stats = { lines: 0, uploads: 0, uploadFails: 0 };
  let out = null;   // { gz, file, slot, part, final }
  let uploading = false;

  async function upload(path, body, type = "application/gzip", timeoutMs = null) {
    try {
      const r = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
        method: "POST", body,
        headers: authHeaders(key, { "Content-Type": type, "x-upsert": "true" }),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      return { ok: r.ok, status: r.status, body: r.ok ? "" : (await r.text()).slice(0, 200) };
    } catch (e) { return { ok: false, status: 0, body: e.message }; }
  }

  function write(obj) {
    if (!out) return;
    out.gz.write(JSON.stringify(obj) + "\n");
    stats.lines++;
  }

  function open(now) {
    mkdirSync(dir, { recursive: true });
    const final = join(dir, archiveFileName(now, source));
    const part = final + ".part";
    const gz = createGzip(), file = createWriteStream(part);
    gz.pipe(file);
    out = { gz, file, slot: Math.floor(now / rotateMs), part, final };
    if (meta) write(meta(now));
  }

  // Finish the gzip and only then drop the .part suffix.
  function close() {
    if (!out) return Promise.resolve();
    const { gz, file, part, final } = out;
    out = null;
    return new Promise(res => {
      const done = () => { try { renameSync(part, final); } catch {} res(); };
      file.on("finish", done);
      file.on("error", () => res());
      gz.end();
    });
  }

  async function uploadAll() {
    if (uploading) return;
    uploading = true;
    try {
      for (const name of readdirSync(dir).filter(n => n.endsWith(".ndjson.gz")).sort()) {
        const body = readFileSync(join(dir, name));
        const r = await upload(archiveRemotePath(prefix, name), body);
        if (r.ok) { unlinkSync(join(dir, name)); stats.uploads++; }
        else { stats.uploadFails++; log(`::warning::upload ${name} failed: ${r.status} ${r.body} — kept locally, will retry`); }
      }
    } finally { uploading = false; }
  }

  function rotateIfDue(now) {
    if (out && Math.floor(now / rotateMs) !== out.slot) {
      const old = close();
      open(now);
      old.then(uploadAll);
    }
  }

  // The bucket is proven the same way the credential is: by using it. A
  // missing bucket would otherwise surface an hour later as a failed
  // upload, with an hour of data piling up on a small disk.
  //
  // Storage that cannot answer (a network error, a timeout, a 5xx — 544 is
  // its "DatabaseTimeout") is NOT a missing bucket, and only warns: files
  // are written locally and uploaded later with retries, so waiting or
  // dying here would lose minutes the archive would otherwise keep.
  async function probe() {
    const r = await upload(`${prefix}/_probe/${source}.txt`, Buffer.from(new Date().toISOString()), "text/plain", 15000);
    if (r.ok) return null;
    if (r.status === 0 || r.status >= 500) {
      log(`::warning::Storage is not answering (${r.status} ${r.body}) — recording locally, uploads will retry`);
      return null;
    }
    const lines = [`cannot write to Storage bucket '${bucket}': ${r.status} ${r.body}`];
    if (/bucket not found|404/i.test(`${r.status} ${r.body}`)) lines.push("run migration 0029_stream_archive_bucket.sql");
    return lines;
  }

  // Leftovers from a run that died mid-file.
  function recoverLeftovers() {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir).filter(n => n.endsWith(".ndjson.gz.part"))) {
      renameSync(join(dir, name), join(dir, name.replace(/\.ndjson\.gz\.part$/, "-truncated.ndjson.gz")));
      log(`::warning::found ${name} from a run that did not finish; uploading it as truncated`);
    }
  }

  const flush = () => out?.gz.flush(zc.Z_SYNC_FLUSH);
  const backlog = () => { try { return readdirSync(dir).filter(n => n.endsWith(".ndjson.gz")).length; } catch { return 0; } };
  const diskFreeGB = () => { try { const s = statfsSync(dir); return (s.bavail * s.bsize / 1e9).toFixed(1); } catch { return null; } };

  return { stats, open, close, write, rotateIfDue, upload, uploadAll, probe, recoverLeftovers, flush, backlog, diskFreeGB };
}
