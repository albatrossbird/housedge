// Accounts: the flag, sessions, profiles and referrals, and the board each
// plan may see — driven end to end through the API routes against a fake
// Supabase (Auth and REST), with no network.
process.env.SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
process.env.SPORTS_BOARD_URL = "https://scanner.example/data.json";

const { accountsMode, emailAllowed, safeNext } = await import("../lib/auth/config.js");
const { parseCookies, serializeCookie } = await import("../lib/auth/cookies.js");
const { entitlementsOf, limitBoard, FREE_EV_CAP } = await import("../lib/entitlements.js");
const { normalizeCode, ensureProfile } = await import("../lib/auth/profiles.js");
const { getSession } = await import("../lib/auth/session.js");
const board = (await import("../pages/api/sports-board.js")).default;
const send = (await import("../pages/api/auth/send.js")).default;
const verify = (await import("../pages/api/auth/verify.js")).default;
const refRoute = (await import("../pages/api/auth/ref.js")).default;
const callback = (await import("../pages/api/auth/callback.js")).default;
const me = (await import("../pages/api/me.js")).default;

let failed = 0;
const ok = (c, w, extra = "") => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w} ${extra}`); } };

// ---- fake Supabase -------------------------------------------------------
const S = {};
function reset() {
  Object.assign(S, {
    users: { u1: { id: "u1", email: "a@x.com", user_metadata: {} }, u2: { id: "u2", email: "b@x.com", user_metadata: {} } },
    access: { AT1: "u1", AT2: "u2" },          // live access tokens
    refresh: { RT1: "u1" },                    // live refresh tokens
    hashes: {}, codes: {}, pkce: {},
    profiles: [], affiliates: [{ code: "CREATOR", name: "C", profile_id: "u9", active: true }, { code: "OLDCODE", name: "O", profile_id: null, active: false }],
    authDown: false, otpSent: [], insertRace: false, scanner: null,
  });
}
const session = uid => { const at = `AT-${uid}-${Math.random()}`; const rt = `RT-${uid}-${Math.random()}`; S.access[at] = uid; S.refresh[rt] = uid; return { access_token: at, refresh_token: rt, expires_in: 3600, user: S.users[uid] }; };
const J = (status, body) => new Response(body == null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const qp = u => Object.fromEntries(u.searchParams);

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  const bearer = String(opts.headers?.Authorization || "").replace(/^Bearer /, "");
  if (u.host === "scanner.example") return S.scanner ? J(200, S.scanner) : J(500, {});
  if (u.pathname.startsWith("/auth/v1/")) {
    if (S.authDown) return J(503, { msg: "down" });
    const p = u.pathname.slice(9);
    if (p === "user") return S.access[bearer] ? J(200, S.users[S.access[bearer]]) : J(401, { msg: "invalid JWT" });
    if (p === "token" && u.searchParams.get("grant_type") === "refresh_token") {
      const uid = S.refresh[body.refresh_token]; if (!uid) return J(400, { error_description: "Invalid Refresh Token" });
      delete S.refresh[body.refresh_token]; return J(200, session(uid));
    }
    if (p === "token" && u.searchParams.get("grant_type") === "pkce") {
      const uid = S.pkce[`${body.auth_code}|${body.code_verifier}`]; return uid ? J(200, session(uid)) : J(400, { msg: "bad code" });
    }
    if (p === "otp") {
      S.otpSent.push(body);
      if (!Object.values(S.users).some(x => x.email === body.email)) { const id = `n${Object.keys(S.users).length}`; S.users[id] = { id, email: body.email, user_metadata: body.data || {} }; }
      return J(200, {});
    }
    if (p === "verify") {
      const uid = body.token_hash ? S.hashes[body.token_hash] : S.codes[`${body.email}|${body.token}`];
      return uid ? J(200, session(uid)) : J(403, { msg: "Token has expired or is invalid" });
    }
    if (p === "logout") return new Response(null, { status: 204 });
    return J(404, {});
  }
  if (u.pathname.startsWith("/rest/v1/")) {
    if (opts.headers?.apikey !== "service-key") return J(401, { message: "no key" });
    const table = u.pathname.slice(9), q = qp(u);
    const rows = table === "profiles" ? S.profiles : S.affiliates;
    if ((opts.method || "GET") === "GET") {
      return J(200, rows.filter(r => Object.entries(q).every(([k, v]) => k === "select" || (v.startsWith("eq.") ? String(r[k]) === v.slice(3) : v === "is.true" ? r[k] === true : true))));
    }
    if (opts.method === "POST" && table === "profiles") {
      if (S.insertRace) { S.profiles.push({ ...body[0], plan: "free", referred_by: "RACER" }); return J(201, []); }
      const made = body.filter(b => !S.profiles.some(p => p.id === b.id)).map(b => ({ plan: "free", plan_until: null, pass_until: null, ...b }));
      S.profiles.push(...made); return J(201, made);
    }
  }
  return J(404, {});
};

function mkRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, location: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.getHeader = k => res.headers[k.toLowerCase()];
  res.redirect = (c, l) => { res.statusCode = c; res.location = l; return res; };
  res.cookies = () => Object.fromEntries([].concat(res.headers["set-cookie"] ?? []).map(c => { const [kv, ...attrs] = c.split("; "); const i = kv.indexOf("="); return [kv.slice(0, i), { value: decodeURIComponent(kv.slice(i + 1)), attrs }]; }));
  return res;
}
const mkReq = ({ method = "GET", query = {}, body, cookies = {}, origin } = {}) => ({
  method, query, body, headers: { host: "marketslap.com", ...(origin ? { origin } : {}), cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") },
});
async function run(handler, reqOpts) { const res = mkRes(); await handler(mkReq(reqOpts), res); return res; }

// ---- config, cookies -----------------------------------------------------
ok(accountsMode({}) === "off" && accountsMode({ ACCOUNTS_MODE: "ON" }) === "on" && accountsMode({ ACCOUNTS_MODE: "yes" }) === "off", "the flag: off by default, unknown values read as off");
ok(emailAllowed("A@x.com", { ACCOUNTS_MODE: "preview", ACCOUNTS_ALLOWLIST: "a@x.com, b@y.com" }) && !emailAllowed("c@x.com", { ACCOUNTS_MODE: "preview", ACCOUNTS_ALLOWLIST: "a@x.com" }) && !emailAllowed("a@x.com", {}), "preview admits only the allowlist; off admits nobody");
ok(safeNext("/account") === "/account" && safeNext("//evil.com") === "/sports" && safeNext("https://evil.com") === "/sports" && safeNext("/\\evil.com") === "/sports" && safeNext(undefined) === "/sports", "only on-site paths are post-sign-in destinations");
const c = serializeCookie("ms_at", "a b", { maxAge: 60, secure: true });
ok(/HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c) && /Max-Age=60/.test(c) && parseCookies("x=1; ms_at=a%20b").ms_at === "a b", "session cookies are httpOnly, Secure, Lax; values round-trip");

// ---- entitlements --------------------------------------------------------
const now = Date.parse("2026-11-03T12:00:00Z");
const e = p => entitlementsOf(p, now);
ok(!e(null).ev && !e(null).arb, "no profile is the free plan");
ok(e({ plan: "ev" }).ev && !e({ plan: "ev" }).arb && e({ plan: "arb" }).arb && !e({ plan: "arb" }).ev, "the +EV and Arbitrage plans each unlock their own board only");
ok(e({ plan: "pro", plan_until: "2026-12-01T00:00:00Z" }).arb && !e({ plan: "pro", plan_until: "2026-11-01T00:00:00Z" }).ev && e({ plan: "pro", plan_until: "2026-11-01T00:00:00Z" }).plan === "free", "a plan past its end is free");
ok(e({ plan: "ev", pass_until: "2026-11-03T20:00:00Z" }).arb && e({ plan: "ev", pass_until: "2026-11-03T20:00:00Z" }).plan === "ev" && !e({ plan: "free", pass_until: "2026-11-03T11:00:00Z" }).ev, "a day pass unlocks everything until it ends, beside the plan held");

const B = {
  scannedAt: "2026-11-03T12:00:00.000Z", ageSeconds: 0, truncated: false,
  rows: [{ sport: "nfl", label: "low", evNet: 0.01, link: "https://a" }, { sport: "nfl", label: "edge", evNet: 0.031, link: "https://b" }, { sport: "mlb", label: "big", evNet: 0.08, link: "https://c" }, { sport: "mlb", label: "cap", evNet: FREE_EV_CAP }],
  arbs: [{ sport: "nfl", ret: 0.02, legs: [{ link: "https://d" }] }, { sport: "nba", ret: 0.01, legs: [] }],
};
const free = limitBoard(B);
const freeJson = JSON.stringify(free);
ok(free.rows.map(r => r.label).join() === "low" && !/"edge"|"big"|https:\/\/b|https:\/\/c|https:\/\/d/.test(freeJson), "free: prices at the cap or above, and every arb, are not in the response at all", freeJson);
ok(free.locked.ev.count === 3 && free.locked.ev.bySport.mlb === 2 && free.locked.arb.count === 2 && free.locked.arb.bySport.nba === 1 && free.arbs.length === 0, "free: what is locked is counted, by sport");
const evOnly = limitBoard(B, { ev: true, arb: false });
ok(evOnly.rows.length === 4 && evOnly.arbs.length === 0 && !evOnly.locked.ev && evOnly.locked.arb.count === 2, "+EV plan: every price, arbs counted");
const pro = limitBoard(B, { ev: true, arb: true });
ok(pro.rows.length === 4 && pro.arbs.length === 2 && pro.locked === null, "Sports Pro: the whole board");

// ---- profiles and referrals ----------------------------------------------
ok(normalizeCode(" creator ") === "CREATOR" && normalizeCode("a b") === null && normalizeCode("ab") === null && normalizeCode(null) === null, "codes are trimmed, capitalised and checked");
reset();
let p = await ensureProfile(S.users.u1, { ref: "creator", agreedAt: "2026-11-03T00:00:00Z" });
ok(p.referred_by === "CREATOR" && p.agreed_18_at === "2026-11-03T00:00:00Z" && p.email === "a@x.com", "a first sign-in creates the profile with the referral and the age confirmation");
p = await ensureProfile(S.users.u1, { ref: "OTHER" });
ok(p.referred_by === "CREATOR" && S.profiles.length === 1, "a later sign-in never rewrites the referral");
reset(); S.affiliates[0].profile_id = "u1";
ok((await ensureProfile(S.users.u1, { ref: "CREATOR" })).referred_by === null, "a code is not credited for its own owner's account");
reset();
ok((await ensureProfile(S.users.u1, { ref: "OLDCODE" })).referred_by === null && (await ensureProfile(S.users.u2, { ref: "NOPE" })).referred_by === null, "inactive and unknown codes credit no one");
reset(); S.insertRace = true;
ok((await ensureProfile(S.users.u1, {})).referred_by === "RACER", "a concurrent first sign-in reads the row that won, not an empty answer");

// ---- sessions ------------------------------------------------------------
process.env.ACCOUNTS_MODE = "on";
reset();
let res = mkRes();
ok((await getSession(mkReq({ cookies: { ms_at: "AT1" } }), res)).user?.id === "u1" && !res.headers["set-cookie"], "a live access token is a session, with no cookie churn");
res = mkRes();
let s = await getSession(mkReq({ cookies: { ms_at: "DEAD", ms_rt: "RT1" } }), res);
ok(s.user?.id === "u1" && res.cookies().ms_at?.value.startsWith("AT-u1") && res.cookies().ms_rt?.value.startsWith("RT-u1"), "an expired access token is renewed with the refresh token, and both cookies replaced");
res = mkRes();
s = await getSession(mkReq({ cookies: { ms_at: "DEAD", ms_rt: "GONE" } }), res);
ok(s.user === null && res.cookies().ms_at?.attrs.includes("Max-Age=0") && res.cookies().ms_rt?.attrs.includes("Max-Age=0"), "a rejected refresh token signs out and clears both cookies");
S.authDown = true; res = mkRes();
s = await getSession(mkReq({ cookies: { ms_at: "AT1", ms_rt: "RT1" } }), res);
ok(s.user === null && s.unavailable && !res.headers["set-cookie"], "an Auth outage keeps the cookies: a blip must not sign everyone out");
res = mkRes();
s = await getSession(mkReq({ cookies: { ms_at: "AT1" } }), res);
ok(s.unavailable && !res.headers["set-cookie"], "...including when only the access token is held");
S.authDown = false;
process.env.ACCOUNTS_MODE = "preview"; process.env.ACCOUNTS_ALLOWLIST = "b@x.com"; res = mkRes();
ok((await getSession(mkReq({ cookies: { ms_at: "AT1" } }), res)).user === null && res.cookies().ms_at?.attrs.includes("Max-Age=0"), "preview: an email taken off the allowlist loses its session on the next request");
process.env.ACCOUNTS_MODE = "off";
ok((await getSession(mkReq({ cookies: { ms_at: "AT1" } }), mkRes())).user === null, "off: no sessions at all");

// ---- routes --------------------------------------------------------------
reset();
S.scanner = { scannedAt: "2026-11-03T12:00:00Z", rows: B.rows, arbs: B.arbs };
process.env.ACCOUNTS_MODE = "off";
res = await run(board, {});
ok(res.statusCode === 200 && res.body.rows.length === 4 && res.body.arbs.length === 2 && /s-maxage/.test(res.headers["cache-control"]), "off: the public board is whole, exactly as before accounts");
ok((await run(me, {})).body.enabled === false && (await run(send, { method: "POST", body: { email: "a@x.com", agree: true } })).statusCode === 404, "off: /api/me says disabled and the sign-in routes answer 404");
process.env.ACCOUNTS_MODE = "preview"; process.env.ACCOUNTS_ALLOWLIST = "a@x.com";
ok((await run(board, {})).body.rows.length === 4, "preview: the public board stays whole for everyone");
process.env.ACCOUNTS_MODE = "on";
res = await run(board, {});
ok(res.body.rows.length === 1 && res.body.arbs.length === 0 && res.body.locked.arb.count === 2 && /public/.test(res.headers["cache-control"]), "on: the public (cached) URL serves only the free view");
res = await run(board, { query: { tier: "member" } });
ok(res.statusCode === 401 && /no-store/.test(res.headers["cache-control"]), "the member URL needs a session and is never cached");
S.profiles.push({ id: "u1", email: "a@x.com", plan: "pro", plan_until: null, pass_until: null });
res = await run(board, { query: { tier: "member" }, cookies: { ms_at: "AT1" } });
ok(res.statusCode === 200 && res.body.rows.length === 4 && res.body.arbs.length === 2 && /private/.test(res.headers["cache-control"]), "a Sports Pro member gets the whole board, privately");
res = await run(board, { query: { tier: "member" }, cookies: { ms_at: "AT2" } });
ok(res.statusCode === 200 && res.body.rows.length === 1 && S.profiles.some(p => p.id === "u2"), "a member with no profile yet gets one, on the free plan");

// sign-in by email
reset();
res = await run(send, { method: "POST", body: { email: "new@x.com" } });
ok(res.statusCode === 400 && /18/.test(res.body.error), "no link without the 18+ confirmation");
res = await run(send, { method: "POST", body: { email: "new@x.com", agree: true }, origin: "https://evil.com" });
ok(res.statusCode === 403, "a cross-site POST is refused");
res = await run(send, { method: "POST", body: { email: "New@X.com", agree: true }, cookies: { ms_ref: "CREATOR" }, origin: "https://marketslap.com" });
ok(res.statusCode === 200 && S.otpSent[0].email === "new@x.com" && S.otpSent[0].data.ref === "CREATOR" && S.otpSent[0].data.agreed_18_at, "the link request carries the referral and the age confirmation on the new user");
const newId = Object.values(S.users).find(x => x.email === "new@x.com").id;
S.hashes.H1 = newId;
res = await run(verify, { method: "POST", body: { token_hash: "H1", type: "email" } });   // a different browser: no ms_ref cookie
const prof = S.profiles.find(p => p.id === newId);
ok(res.statusCode === 200 && res.cookies().ms_at && /HttpOnly/.test(res.cookies().ms_at.attrs.join(";")) && prof?.referred_by === "CREATOR" && prof?.agreed_18_at, "the link signs in on any device, and the profile keeps the referral from the device that asked", JSON.stringify(prof));
res = await run(verify, { method: "POST", body: { token_hash: "H1-used" } });
ok(res.statusCode === 400 && /expired/.test(res.body.error) && !res.headers["set-cookie"], "a spent link says so and signs nobody in");
S.codes["a@x.com|123456"] = "u1";
res = await run(verify, { method: "POST", body: { email: "a@x.com", code: "123 456" } });
ok(res.statusCode === 200 && S.profiles.some(p => p.id === "u1"), "the code typed from the email signs in too");
process.env.ACCOUNTS_MODE = "preview"; process.env.ACCOUNTS_ALLOWLIST = "b@x.com";
ok((await run(send, { method: "POST", body: { email: "a@x.com", agree: true } })).statusCode === 403, "preview: no link for an email off the allowlist");
S.codes["a@x.com|654321"] = "u1";
res = await run(verify, { method: "POST", body: { email: "a@x.com", code: "654321" } });
ok(res.statusCode === 403 && !res.headers["set-cookie"], "preview: and no session for one either, even with a valid code");
process.env.ACCOUNTS_MODE = "on";

// Google
S.pkce["C1|V1"] = "u2";
res = await run(callback, { query: { code: "C1" }, cookies: { ms_pkce: "V1", ms_agree: "2026-11-03T00:00:00Z", ms_next: "/account", ms_ref: "creator" } });
ok(res.statusCode === 302 && res.location === "/account" && res.cookies().ms_at && S.profiles.find(p => p.id === "u2")?.referred_by === "CREATOR", "Google: the code is exchanged, the profile made with the referral, and the reader lands where they were going");
res = await run(callback, { query: { code: "C1" }, cookies: { ms_next: "//evil.com" } });
ok(res.statusCode === 302 && res.location.startsWith("/signin?error=") && !res.cookies().ms_at, "Google: no verifier, no session");
res = await run(callback, { query: { code: "C1" }, cookies: { ms_pkce: "WRONG" } });
ok(res.location.startsWith("/signin?error="), "Google: a verifier that does not match is refused");

// referral cookie: first touch wins, only real codes
reset();
res = await run(refRoute, { method: "POST", body: { code: "creator" } });
ok(res.statusCode === 200 && res.cookies().ms_ref?.value === "CREATOR" && res.cookies().ms_ref.attrs.includes("HttpOnly"), "a real code is remembered, httpOnly");
res = await run(refRoute, { method: "POST", body: { code: "OTHER" }, cookies: { ms_ref: "CREATOR" } });
ok(res.body.kept && !res.headers["set-cookie"], "first touch wins: a held code is not replaced");
ok((await run(refRoute, { method: "POST", body: { code: "NOPE" } })).statusCode === 404 && (await run(refRoute, { method: "POST", body: { code: "OLDCODE" } })).statusCode === 404, "unknown and inactive codes are not stored");

// /api/me
S.profiles.push({ id: "u1", email: "a@x.com", plan: "ev", plan_until: "2099-01-01T00:00:00Z", pass_until: null });
S.affiliates.push({ code: "ACODE", name: "A", profile_id: "u1", active: true });
res = await run(me, { query: { full: "1" }, cookies: { ms_at: "AT1" } });
ok(res.body.user.email === "a@x.com" && res.body.plan.id === "ev" && res.body.entitlements.ev && !res.body.entitlements.arb && res.body.affiliateCode === "ACODE" && /no-store/.test(res.headers["cache-control"]), "/api/me: the plan, what it unlocks, and the reader's own code");
ok(!JSON.stringify(res.body).includes("AT1") && !JSON.stringify(res.body).includes("service-key"), "/api/me never echoes a token or key");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
