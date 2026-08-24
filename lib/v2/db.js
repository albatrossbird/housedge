// Raw PostgREST helpers for the v2 schema.
//
// Deliberately not supabase-js: it flattens network-layer failures to a
// bare "TypeError: fetch failed" string, discarding err.cause. Diagnosing
// the paused-project outage this session took far longer than it should
// have for exactly that reason, so every write path here preserves
// cause.code and the HTTP status/body. See CLAUDE.md > Known pitfalls.

const BASE = () => `${process.env.SUPABASE_URL}/rest/v1`;

function authHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
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
