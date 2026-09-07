// Retention endpoint. The JOB is lib/pruneMarkets.js and runs in the
// Actions runner on a schedule; this route keeps it hittable by hand
// (?dry=1, ?days=) without a second copy of the logic.
import { cronAuthorized } from "../../lib/cronAuth.js";
import { runPrune } from "../../lib/pruneMarkets.js";

export default async function handler(req, res) {
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });
  const { status, body } = await runPrune(req.query);
  res.status(status).json(body);
}
