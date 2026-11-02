// The sports board for the page (pages/sports.js): the scanner's data.json,
// fetched server-side and passed through lib/sportsBoard.js's whitelist.
//
// SPORTS_BOARD_URL is the scanner's data.json (its own server; the odds feed
// and its key never leave that box). SPORTS_BOARD_TOKEN, if set, is sent as
// a bearer token, for a scanner that serves the file behind one. Neither is
// a NEXT_PUBLIC_ variable: the browser only ever sees this route.
//
// Cached at the edge for 60s: the scanner rewrites every 5 minutes, so a
// hundred open pages cost the scanner one read a minute.
import { sanitizeBoard } from "../../lib/sportsBoard.js";

export default async function handler(req, res) {
  const url = process.env.SPORTS_BOARD_URL;
  if (!url) return res.status(503).json({ error: "sports board not configured (SPORTS_BOARD_URL)" });
  const headers = { accept: "application/json" };
  if (process.env.SPORTS_BOARD_TOKEN) headers.authorization = `Bearer ${process.env.SPORTS_BOARD_TOKEN}`;
  let body;
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) return res.status(502).json({ error: `scanner answered ${r.status}` });
    body = await r.json();
  } catch (e) {
    return res.status(502).json({ error: `scanner unreachable: ${e.name === "TimeoutError" ? "timed out" : e.message}` });
  }
  let board;
  try { board = sanitizeBoard(body); } catch (e) { return res.status(502).json({ error: e.message }); }
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=240");
  return res.status(200).json(board);
}
