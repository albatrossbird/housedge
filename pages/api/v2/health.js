// v2 schema health + security posture check.
//
//   /api/v2/health
//
// Reports three things that are otherwise easy to get wrong silently:
//
//   1. Which credential the write path is using. Vercel only exposes an
//      env var to deployments built *after* it was added, so a freshly
//      added SUPABASE_SERVICE_ROLE_KEY reads as absent until a redeploy.
//      That failure looks identical to "I typed the name wrong".
//
//   2. Whether RLS is genuinely refusing anon writes — by attempting one
//      and checking it fails. `alter table ... enable row level security`
//      succeeds silently, so "I ran the migration" is not evidence the
//      policy is in force. If the probe row does get inserted, that is
//      the answer: RLS is off. It's cleaned up immediately either way.
//
//   3. Row counts per v2 table, so backfill progress is visible.

import { rest, restAs, credentialInUse } from "../../../lib/v2/db.js";

const PROBE_ID = "__rls_probe__";

async function countOf(table) {
  // PostgREST returns the count in Content-Range with HEAD + count=exact,
  // which avoids pulling any rows.
  try {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/${table}?select=id`,
      {
        method: "HEAD",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY}`,
          Prefer: "count=exact",
          Range: "0-0",
        },
      }
    );
    const cr = r.headers.get("content-range");
    if (!cr) return r.ok ? null : `http ${r.status}`;
    return Number(cr.split("/")[1]);
  } catch (err) {
    return `error: ${err.message}`;
  }
}

export default async function handler(req, res) {
  try {
    const anonKey = process.env.SUPABASE_ANON_KEY;

    // Does an anon-credentialed write get refused?
    const probe = await restAs(anonKey, "venues", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ id: PROBE_ID, name: "rls probe" }]),
    });

    // If it went through, RLS is not protecting writes. Remove the row
    // regardless of which credential can do it.
    let probeCleanup = "not needed";
    if (probe.ok) {
      const del = await rest(`venues?id=eq.${PROBE_ID}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      });
      probeCleanup = del.error ? `FAILED: ${JSON.stringify(del.error)}` : "removed";
    }

    const [venues, events, outcomes, listings, quotes] = await Promise.all(
      ["venues", "events", "outcomes", "listings", "quotes"].map(countOf)
    );

    const rlsEnforced = !probe.ok;
    const usingServiceRole = credentialInUse() === "service_role";

    res.status(200).json({
      credential: credentialInUse(),
      rls: {
        enforcedOnWrites: rlsEnforced,
        anonWriteProbe: { status: probe.status, body: probe.body.slice(0, 160) },
        probeCleanup,
      },
      counts: { venues, events, outcomes, listings, quotes },
      verdict:
        rlsEnforced && usingServiceRole
          ? "OK — RLS enforced, writes use service_role"
          : !rlsEnforced && usingServiceRole
          ? "RLS is NOT enforcing anon writes — check that 0002_v2_rls.sql ran against this project"
          : rlsEnforced && !usingServiceRole
          ? "RLS enforced but service_role key not visible — writes will fail. Add SUPABASE_SERVICE_ROLE_KEY in Vercel and REDEPLOY (env vars only reach deployments built after they're added)"
          : "Neither RLS nor service_role active — running in the pre-migration posture",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
