// Is this credential actually usable?
//
// WHY THIS EXISTS. Four scripts printed a line like:
//
//   credential: ${SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon"}
//
// which reports WHICH VARIABLE IS SET and nothing about whether the
// value in it works. On 2026-09-18 the 15-minute recorder printed
// "credential: service_role" and then wrote nothing for fourteen hours,
// warning `401 Invalid API key` once every fifteen seconds while
// Restart=always kept it alive. Every counter that could have said so
// was structurally incapable of it — the same defect this repo has
// recorded as a Set that collapsed 79 frozen series into one null, and
// as a counter that could only be non-zero.
//
// A FAILED WRITE ONLY WARNS, and that is correct mid-run: a recorder
// should not die on one bad response from a venue or a blip from
// Postgres. It is wrong for a credential, which will not fix itself and
// makes every subsequent write pointless. So the credential is proven
// ONCE, before any work, and a bad one is fatal — under systemd that
// means StartLimitBurst stops the unit rather than looping on it, which
// is loud instead of infinite.
//
// A JWT's middle segment is base64 of {iss, ref, role, exp} and is NOT
// secret — only the signature is. So the diagnostics below can name the
// project and role a key belongs to without ever printing the key.

// A value that is present, wrong, and looks right at a glance.
//
// MEASURED, the hard way: /etc/marketslap/env carried
//   SUPABASE_SERVICE_ROLE_KEY=<eyJhbGci...>
// because the instructions wrote the placeholder as `<the service_role
// key>` and the brackets were kept along with the key. systemd's
// EnvironmentFile takes the value literally, brackets included, so a
// perfectly good key was sent as `<key>` and refused for fourteen
// hours. `<` is also a redirection operator, so `. env` in a shell dies
// at that line and reports every variable as empty — which reads as a
// missing key rather than a wrapped one.
//
// Checked before anything else, because the fix is "delete two
// characters" and no other diagnosis leads there.
export function unwrapped(key) {
  const k = String(key || "");
  const pairs = [["<", ">"], ['"', '"'], ["'", "'"], ["`", "`"]];
  for (const [a, b] of pairs) {
    if (k.startsWith(a) && k.endsWith(b) && k.length > 2) {
      return { wrapped: `${a}${b}`, value: k.slice(1, -1) };
    }
  }
  return { wrapped: null, value: k };
}

export function describeKey(key) {
  const { wrapped, value } = unwrapped(key);
  if (wrapped) {
    const inner = describeKey(value);
    return { ...inner, shape: "wrapped", wrapped, innerShape: inner.shape };
  }
  const parts = String(key || "").split(".");
  if (parts.length !== 3) return { shape: "not-a-jwt", segments: parts.length };
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return {
      shape: "jwt",
      ref: p.ref || null,
      role: p.role || null,
      // Reported as a date because "is it expired" is the question, and
      // a raw epoch makes the reader do arithmetic to find out.
      expires: Number.isFinite(p.exp) ? new Date(p.exp * 1000).toISOString() : null,
      expired: Number.isFinite(p.exp) ? p.exp * 1000 < Date.now() : null,
    };
  } catch {
    return { shape: "jwt-unreadable", segments: 3 };
  }
}

// The host carries the project ref as its first label, so a key for the
// wrong project is detectable locally, before any request.
export function refFromUrl(url) {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\./i.exec(String(url || ""));
  return m ? m[1] : null;
}

export async function assertCredential(url, key, {
  table = "m15_quotes", fetchImpl = fetch, exit = code => process.exit(code),
  log = console.error,
} = {}) {
  const info = describeKey(key);
  const urlRef = refFromUrl(url);

  // Cheapest authenticated call there is: ask for zero rows.
  let r;
  try {
    r = await fetchImpl(`${url}/rest/v1/${table}?select=*&limit=0`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    log(`::error::cannot reach Supabase: ${err.message}`);
    return exit(2);
  }
  if (r.ok) return { ok: true, ...info };

  const body = await r.text?.().catch(() => "") ?? "";
  log(`::error::credential rejected (HTTP ${r.status}) ${String(body).slice(0, 200)}`);

  // Say which of the likely causes it actually is, rather than listing
  // all of them and leaving the reader to check each by hand.
  if (info.shape === "wrapped") {
    log(`::error::THE KEY IS WRAPPED IN ${info.wrapped} — delete those two characters.`);
    log("::error::The placeholder's brackets were kept along with the key. systemd takes");
    log("::error::the value literally, so the brackets were sent as part of the key.");
  } else if (info.shape !== "jwt") {
    log(`::error::the value is not a JWT (${info.shape}) — it may be truncated or the wrong field entirely`);
  } else {
    if (urlRef && info.ref && urlRef !== info.ref) {
      log(`::error::WRONG PROJECT: key is for '${info.ref}', SUPABASE_URL points at '${urlRef}'`);
    }
    if (info.expired) log(`::error::EXPIRED: the key expired ${info.expires}`);
    if (info.role && info.role !== "service_role") {
      log(`::error::ROLE IS '${info.role}': writes are refused by RLS, which needs service_role`);
    }
    if ((!urlRef || urlRef === info.ref) && !info.expired && info.role === "service_role") {
      log(`::error::key names the right project and role, so it has been ROTATED or revoked — reissue it`);
    }
  }
  log("::error::Fix /etc/marketslap/env. Nothing is recorded until it is.");
  return exit(2);
}
