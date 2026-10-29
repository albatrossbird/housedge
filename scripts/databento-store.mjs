// The durable copy of what was bought from Databento: every raw file
// scripts/databento-fetch.py keeps, in the PRIVATE bucket stream-archive
// under databento/. The Actions cache is not enough on its own: GitHub
// drops an entry nobody has read for 7 days, and a fetch that finds no raw
// file BUYS IT AGAIN. So the workflow pulls before the fetch decides what
// is held, and pushes after it, and the push fails the run unless every
// local raw file is in the bucket at its full size.
//
// CME data bought for this project's own use: like the Kalshi archive in
// the same bucket, never add a read policy or make the bucket public.
//
//   node scripts/databento-store.mjs pull --dir=databento
//   node scripts/databento-store.mjs push --dir=databento
import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { authHeaders } from "../lib/supabaseHeaders.js";
import { fetchRetrying } from "../lib/archiveRead.js";

const BUCKET = "stream-archive", PREFIX = "databento/";
const mode = process.argv[2];
const opt = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const RAW = join(opt("dir", "databento"), "raw");
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!["pull", "push"].includes(mode)) { console.error("usage: databento-store.mjs pull|push --dir=<dir>"); process.exit(2); }
if (!URL || !KEY) { console.error("::error::SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — the bucket is private"); process.exit(2); }
const get = doFetch => fetchRetrying(doFetch, { log: console.log });
const isRaw = name => /^[0-9A-Z]+\.[a-z0-9-]+\.\d+-\d+\.dbn\.zst$/.test(name);

export async function listRemote() {
  const out = new Map();   // name -> size
  for (let offset = 0; ; offset += 100) {
    const r = await get(() => fetch(`${URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: authHeaders(KEY, { "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix: PREFIX, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
    }));
    if (!r.ok) throw new Error(`list ${PREFIX}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const page = await r.json();
    for (const e of page) if (e.id && isRaw(e.name)) out.set(e.name, e.metadata?.size ?? null);
    if (page.length < 100) return out;
  }
}

const local = () => existsSync(RAW) ? new Map(readdirSync(RAW).filter(isRaw).map(n => [n, statSync(join(RAW, n)).size])) : new Map();
const remote = await listRemote();
const here = local();
mkdirSync(RAW, { recursive: true });

if (mode === "pull") {
  let n = 0, bytes = 0;
  for (const [name, size] of remote) {
    if (here.get(name) === size) continue;
    const r = await get(() => fetch(`${URL}/storage/v1/object/authenticated/${BUCKET}/${PREFIX}${name}`, { headers: authHeaders(KEY) }));
    if (!r.ok) throw new Error(`download ${name}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (size != null && buf.length !== size) throw new Error(`download ${name}: ${buf.length} bytes, listed ${size}`);
    writeFileSync(join(RAW, name + ".tmp"), buf); renameSync(join(RAW, name + ".tmp"), join(RAW, name));
    n++; bytes += buf.length;
  }
  console.log(`Storage holds ${remote.size} raw files; pulled ${n} (${(bytes / 1e6).toFixed(1)} MB), ${remote.size - n} already here`);
} else {
  let n = 0, bytes = 0;
  for (const [name, size] of here) {
    if (remote.get(name) === size) continue;
    const r = await get(() => fetch(`${URL}/storage/v1/object/${BUCKET}/${PREFIX}${name}`, {
      method: "POST", body: readFileSync(join(RAW, name)),
      headers: authHeaders(KEY, { "Content-Type": "application/octet-stream", "x-upsert": "true" }),
    }));
    if (!r.ok) throw new Error(`upload ${name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    n++; bytes += size;
  }
  // Proved, not assumed: every local raw file listed back at its size.
  const after = await listRemote();
  const missing = [...here].filter(([name, size]) => after.get(name) !== size).map(([name]) => name);
  console.log(`pushed ${n} raw files (${(bytes / 1e6).toFixed(1)} MB); Storage now holds ${after.size}`);
  if (missing.length) { console.error(`::error::not in Storage at full size after upload: ${missing.join(" ")}`); process.exit(1); }
}
