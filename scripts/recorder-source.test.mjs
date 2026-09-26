// What labels a recorded row, pinned.
//
// WHY THIS IS WORTH A TEST when it is nine lines of ternary: the value
// it produces is the only thing that can answer "can the Actions
// recorder be turned off", and every way of getting it wrong is
// SILENT. A mislabelled row still lands. A run credited to the wrong
// runtime still reports a healthy count. The failure surfaces as a
// coverage figure that looks decisive and is not — which is how a
// recorder gets switched off on the strength of a week of rows the
// other one wrote.
//
// It has already failed once in production, in the direction this
// pins: an M15_SOURCE set in the systemd unit could never reach the
// box, so the rows went out unlabelled.

import { recorderSource } from "../lib/recorderSource.js";

let failed = 0;
const eq = (got, want, what) => {
  if (got === want) return;
  console.error(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  failed++;
};

// The two runtimes, each identifying itself.
eq(recorderSource({ GITHUB_ACTIONS: "true" }, "WX_SOURCE"), "actions", "Actions runner");
eq(recorderSource({ INVOCATION_ID: "ab12" }, "WX_SOURCE"), "box", "systemd service");

// Neither is the third real case, not a default to be absorbed into
// one of the other two. A `node scripts/wx-record.mjs` typed into an
// ssh session is not the box recorder, and counting it as one puts
// rows nobody scheduled into the figure the cutover turns on.
eq(recorderSource({}, "WX_SOURCE"), "unlabelled", "bare shell");
eq(recorderSource({ HOME: "/root", PATH: "/usr/bin" }, "WX_SOURCE"), "unlabelled", "unrelated env");

// An empty string is not a claim. systemd and Actions set these to
// real values; a stray `GITHUB_ACTIONS=` in an EnvironmentFile must not
// promote a box run to an Actions one.
eq(recorderSource({ GITHUB_ACTIONS: "" }, "WX_SOURCE"), "unlabelled", "empty GITHUB_ACTIONS");
eq(recorderSource({ INVOCATION_ID: "" }, "WX_SOURCE"), "unlabelled", "empty INVOCATION_ID");

// Actions wins over systemd if both somehow appear, because a
// self-hosted runner IS an Actions run whatever launched it.
eq(recorderSource({ GITHUB_ACTIONS: "true", INVOCATION_ID: "ab12" }, "WX_SOURCE"),
   "actions", "both set");

// The override names any of the three, and beats both.
eq(recorderSource({ WX_SOURCE: "laptop", GITHUB_ACTIONS: "true" }, "WX_SOURCE"),
   "laptop", "override beats Actions");
eq(recorderSource({ M15_SOURCE: "box", INVOCATION_ID: "x" }, "M15_SOURCE"),
   "box", "override names box");

// EACH RECORDER READS ITS OWN VARIABLE. The two scripts run on the same
// machine from the same EnvironmentFile, so an override meant for one
// must not silently relabel the other's rows.
eq(recorderSource({ M15_SOURCE: "backfill", INVOCATION_ID: "x" }, "WX_SOURCE"),
   "box", "M15_SOURCE does not touch the weather recorder");
eq(recorderSource({ WX_SOURCE: "backfill", INVOCATION_ID: "x" }, "M15_SOURCE"),
   "box", "WX_SOURCE does not touch the 15-minute recorder");

// No override variable named at all: the caller gets the derivation and
// nothing from the environment can override it.
eq(recorderSource({ WX_SOURCE: "laptop", INVOCATION_ID: "x" }), "box", "no override var");

if (failed) { console.error(`\n${failed} failure(s)`); process.exit(1); }
console.log("recorder-source: all cases pass");
