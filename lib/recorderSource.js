// Which recorder wrote this row — 'actions', 'box', or neither.
//
// SHARED BECAUSE TWO COPIES DRIFT. The 15-minute recorder and the
// weather recorder are both migrating off GitHub Actions onto the box,
// both stamp a `source` column so the cutover can be measured per
// recorder rather than as a union, and both had this logic inline. Two
// copies of a rule is the shape this repo has already paid for twice
// (matchNonSportsMarkets across matchonly and normal mode; refreshPrices
// across the route and the runner script) — and here a drift would not
// break anything visibly, it would mislabel a column and make the
// comparison read wrong while looking fine.
//
// DERIVED, NOT CONFIGURED, and that is the load-bearing part. The
// obvious place is an env var in the systemd unit. Unit files are
// copies in /etc/systemd/system, and marketslap-update.service only
// does `git reset --hard` on the REPO — so before deploy/sync-units.sh
// existed, a unit change never reached a running box at all. That
// happened: an M15_SOURCE set in the unit could never arrive, so the
// rows went out unlabelled and the comparison they existed for measured
// nothing.
//
// Both runtimes already identify themselves, so ask them rather than
// configuring what they already know:
//   GITHUB_ACTIONS  set by Actions on every runner.
//   INVOCATION_ID   set by systemd for every service invocation.
//
// ANYTHING ELSE IS 'unlabelled', NOT A DEFAULT. A laptop, a manual
// `node scripts/...` in an ssh session, a cron that is neither — each
// is a real third case, and crediting it to whichever of the two was
// convenient would put rows nobody scheduled into a coverage figure
// somebody is about to turn a recorder off on the strength of.
//
// The override exists for a case not foreseen here, and is checked
// first so it can name any of the three.
export function recorderSource(env = process.env, overrideVar) {
  const override = overrideVar ? env[overrideVar] : undefined;
  if (override) return override;
  if (env.GITHUB_ACTIONS) return "actions";
  if (env.INVOCATION_ID) return "box";
  return "unlabelled";
}
