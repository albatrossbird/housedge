// Raw PostgREST helpers for the v2 schema.
//
// Deliberately not supabase-js: it flattens network-layer failures to a
// bare "TypeError: fetch failed" string, discarding err.cause. Diagnosing
// the paused-project outage this session took far longer than it should
// have for exactly that reason, so every write path here preserves
// cause.code and the HTTP status/body. See CLAUDE.md > Known pitfalls.

const BASE = () => `${process.env.SUPABASE_URL}/rest/v1`;

// v2 tables have RLS enabled with SELECT-only policies for anon (see
// supabase/migrations/0002_v2_rls.sql). Writes therefore need the
// service_role key, which bypasses RLS.
//
// This is only safe because every caller is a Next.js API route running
// server-side. The key must never become a NEXT_PUBLIC_* var or be
// referenced from client components — that would hand anyone a
// full-access credential.
//
// Falls back to the anon key when the service key isn't configured, so
// reads keep working and writes fail loudly (403 with a PostgREST body)
// rather than silently doing nothing. credentialInUse() surfaces which
// one is active for diagnostics.
function writeKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
}

export function credentialInUse() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon";
}

function authHeaders(extra = {}) {
  const key = writeKey();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function describeError(err) {
  const cause = err.cause;
  return {
    name: err.name,
    message: err.message,
    ...(cause ? { cause: { code: cause.code, message: cause.message } } : {}),
  };
}

export async function rest(path, options = {}) {
  try {
    const r = await fetch(`${BASE()}/${path}`, {
      ...options,
      headers: authHeaders(options.headers),
    });
    const text = await r.text();
    if (!r.ok) {
      return { error: { httpStatus: r.status, body: text.slice(0, 400) } };
    }
    return { data: text ? JSON.parse(text) : null };
  } catch (err) {
    return { error: describeError(err) };
  }
}

// Paged select. PostgREST caps an unbounded select at 1000 rows and
// returns no indication that it truncated — this walks the full set with
// Range headers instead. (The silent 1000-row cap bit both refresh.js and
// embed.js in v1.)
export async function selectAll(table, query = "", pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = query ? "&" : "";
    const { data, error } = await rest(`${table}?${query}${sep}order=id`, {
      headers: { Range: `${offset}-${offset + pageSize - 1}` },
    });
    if (error) return { error, data: rows };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return { data: rows };
}

// Upsert with merge-duplicates. `onConflict` must name a real unique
// constraint or PostgREST rejects the request.
//
// Always send the FULL row: `INSERT ... ON CONFLICT DO UPDATE` validates
// NOT NULL columns against the attempted insert row *before* resolving
// the conflict, so a partial payload fails every row even when every row
// already exists. This cost a debugging cycle in v1.
export async function upsert(table, rows, onConflict, { returning = false, batchSize = 200 } = {}) {
  const out = [];
  const errors = [];
  let count = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { data, error } = await rest(
      `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: "POST",
        headers: {
          Prefer: `resolution=merge-duplicates,return=${returning ? "representation" : "minimal"}`,
        },
        body: JSON.stringify(batch),
      }
    );
    if (error) {
      errors.push(JSON.stringify(error));
    } else {
      count += batch.length;
      if (returning && Array.isArray(data)) out.push(...data);
    }
  }

  return { count, errors, rows: out };
}

export async function insert(table, rows, { batchSize = 500 } = {}) {
  const errors = [];
  let count = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await rest(table, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(batch),
    });
    if (error) errors.push(JSON.stringify(error));
    else count += batch.length;
  }
  return { count, errors };
}
