// The sports board for the page (pages/sports.js): the scanner's data.json,
// fetched server-side and passed through lib/sportsBoard.js's whitelist.
//
// SPORTS_BOARD_URL is the scanner's data.json (its own server; the odds feed
// and its key never leave that box). SPORTS_BOARD_TOKEN, if set, is sent as
// a bearer token, for a scanner that serves the file behind one. Neither is
// a NEXT_PUBLIC_ variable: the browser only ever sees this route.
//
// Two URLs, because the edge cache keys on the URL and not on cookies:
//   /api/sports-board              public, cached 60s. The whole board while
//                                  ACCOUNTS_MODE is off or preview; the free
//                                  view (lib/entitlements.js) once it is on.
//   /api/sports-board?tier=member  the signed-in user's view, by their plan,
//                                  never cached. A paid board on the public
//                                  URL would be served from the cache to
//                                  whoever asked next.
import { sanitizeBoard } from "../../lib/sportsBoard.js";
import { accountsMode } from "../../lib/auth/config.js";
import { getSession } from "../../lib/auth/session.js";
import { getProfile, ensureProfile } from "../../lib/auth/profiles.js";
import { entitlementsOf, limitBoard } from "../../lib/entitlements.js";

async function readBoard() {
  const url = process.env.SPORTS_BOARD_URL;
  if (!url) return { status: 503, error: "sports board not configured (SPORTS_BOARD_URL)" };
  const headers = { accept: "application/json" };
  if (process.env.SPORTS_BOARD_TOKEN) headers.authorization = `Bearer ${process.env.SPORTS_BOARD_TOKEN}`;
  let body;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) return { status: 502, error: `scanner answered ${r.status}` };
    body = await r.json();
  } catch (e) {
    return { status: 502, error: `scanner unreachable: ${e.name === "TimeoutError" ? "timed out" : e.message}` };
  }
  try { return { board: sanitizeBoard(body) }; } catch (e) { return { status: 502, error: e.message }; }
}

export default async function handler(req, res) {
  const mode = accountsMode();
  if (req.query.tier === "member") {
    res.setHeader("Cache-Control", "private, no-store");
    if (mode === "off") return res.status(404).json({ error: "accounts are off" });
    const s = await getSession(req, res);
    if (!s.user) return res.status(401).json({ error: "sign in to see your plan's board" });
    let ent;
    try { ent = entitlementsOf((await getProfile(s.user.id)) || (await ensureProfile(s.user))); }
    catch (e) { return res.status(502).json({ error: `plan unavailable: ${e.message}` }); }
    const { board, status, error } = await readBoard();
    if (!board) return res.status(status).json({ error });
    return res.status(200).json(limitBoard(board, ent));
  }
  const { board, status, error } = await readBoard();
  if (!board) return res.status(status).json({ error });
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=240");
  return res.status(200).json(mode === "on" ? limitBoard(board) : board);
}
