// Unit files deploy like code, and nothing else does.
//
// THE GAP: marketslap-update.service pulls the repo, so code reaches
// the box on its own. Unit files do not — they are copies bootstrap
// took once into /etc/systemd/system, and the update job runs as
// `marketslap`, which cannot write there. Over two days that cost
// three separate unit defects each needing a human at a terminal, one
// of which meant a crash-loop ceiling was silently absent on every box
// while a commit message said it was there.
//
// THE RISK it introduces is real and bounded: anything reaching
// deploy/marketslap-*.service on main becomes a root unit within ten
// minutes. The name filter is what bounds it, so it is pinned here.
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync, appendFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const root = mkdtempSync(join(tmpdir(), "syncunits-"));
const repo = join(root, "repo"), dest = join(root, "etc");
mkdirSync(join(repo, "deploy"), { recursive: true });
mkdirSync(dest, { recursive: true });

writeFileSync(join(repo, "deploy", "marketslap-a.service"), "[Service]\nExecStart=/bin/true\n");
writeFileSync(join(repo, "deploy", "marketslap-b.timer"), "[Timer]\nOnUnitActiveSec=10min\n");
// Anything not named marketslap-*: a sync that copied what it found
// would let any file added to deploy/ become a root-run service.
writeFileSync(join(repo, "deploy", "evil.service"), "[Service]\nExecStart=/bin/rm -rf /\n");
writeFileSync(join(repo, "deploy", "notes.md"), "not a unit\n");

// Stub the privileged calls so the copy logic runs unprivileged.
const src = execFileSync("sed", [
  "-e", 's#^\\[ "\\$(id -u)" -eq 0 \\].*#:#',
  "-e", `s#^DEST=/etc/systemd/system#DEST=${dest}#`,
  "-e", "s#^systemctl #echo STUB systemctl #",
  "-e", "s#\\bsystemctl is-enabled#false is-enabled#g",
  "-e", "s#\\bsystemctl is-active#false is-active#g",
  "-e", "s#      systemctl restart#      echo STUB restart#",
  "deploy/sync-units.sh",
], { encoding: "utf8" });
const runner = join(root, "t.sh");
writeFileSync(runner, src);
const run = () => execFileSync("bash", [runner], { encoding: "utf8", env: { ...process.env, DIR: repo } });

console.log("it installs our units and only ours");
{
  const out = run();
  const landed = readdirSync(dest).sort();
  ok(landed.includes("marketslap-a.service"), "the service is installed");
  ok(landed.includes("marketslap-b.timer"), "the timer is installed");
  ok(!landed.includes("evil.service"), "a unit NOT named marketslap-* is refused");
  ok(!landed.includes("notes.md"), "and a non-unit file is ignored");
  ok(landed.length === 2, `exactly two files landed (got ${landed.join(", ")})`);
  ok(/daemon-reload/.test(out), "systemd is reloaded when something changed");
}

console.log("\nit is idempotent — an unchanged box does nothing");
{
  const out = run();
  ok(/units: no change/.test(out), "second run reports no change");
  ok(!/daemon-reload/.test(out), "and does NOT reload systemd for nothing");
}

console.log("\na changed unit is reinstalled");
{
  appendFileSync(join(repo, "deploy", "marketslap-a.service"), "# edited\n");
  const out = run();
  ok(/marketslap-a\.service/.test(out) && /units changed/.test(out), "the edit is detected");
  ok(!/marketslap-b\.timer/.test(out.split("units changed:")[1].split("\n")[0]),
     "and the untouched timer is not touched");
}

console.log("\na unit that is not running is left alone");
{
  // Installed-but-not-enabled means somebody chose not to start it.
  // A sync job overruling that would start recorders by git push.
  appendFileSync(join(repo, "deploy", "marketslap-a.service"), "# again\n");
  const out = run();
  ok(/updated but not running — left alone/.test(out), "it says so rather than starting it");
  ok(!/STUB restart/.test(out), "and issues no restart");
}

rmSync(root, { recursive: true, force: true });
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
