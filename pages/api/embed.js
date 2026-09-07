// Discovery endpoint. The JOB is lib/discover.js and runs in the
// Actions runner on a schedule — see the banner there for why it moved
// off Vercel. This route keeps every hand-hittable mode working
// (?fetchonly=1, ?matchonly=1, ?dry=1, ?explain=, ?reprobe=1) without a
// second copy of the logic, so the scheduled job and a manual poke
// cannot drift.
import { cronAuthorized } from "../../lib/cronAuth.js";
import { runEmbed } from "../../lib/discover.js";

export default async function handler(req, res) {
  const auth = cronAuthorized(req);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });
  const { status, body } = await runEmbed(req.query);
  res.status(status).json(body);
}
