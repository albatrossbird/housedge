// A credential check that names WHICH thing is wrong.
//
// The bug: the 15-minute recorder printed "credential: service_role"
// and then wrote nothing for fourteen hours, warning `401 Invalid API
// key` every fifteen seconds under Restart=always. The banner reported
// which VARIABLE WAS SET, never whether the value worked — a diagnostic
// structurally incapable of being wrong, which is the exact class this
// repo has recorded twice before.
import { describeKey, refFromUrl, assertCredential } from "../lib/supabaseCredential.js";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = p => `eyJhbGciOiJIUzI1NiJ9.${b64(p)}.sig`;

const GOOD = jwt({ iss: "supabase", ref: "smoewpcbpjfcqpyswyli", role: "service_role", exp: 2060000000 });
const URL_ = "https://smoewpcbpjfcqpyswyli.supabase.co";

console.log("a key describes itself without being printed");
{
  const d = describeKey(GOOD);
  ok(d.ref === "smoewpcbpjfcqpyswyli" && d.role === "service_role", "ref and role read from the payload");
  ok(d.expired === false, "not expired");
  // The signature is the only secret part, and nothing here touches it.
  ok(!JSON.stringify(d).includes("sig"), "the signature never appears in the description");
  ok(describeKey("not-a-jwt").shape === "not-a-jwt", "a non-JWT is called what it is");
  ok(describeKey("").shape === "not-a-jwt", "an empty key too");
  ok(refFromUrl(URL_) === "smoewpcbpjfcqpyswyli", "the project ref is read off the URL");
}

const run = async (key, url, status) => {
  const lines = [];
  let code = null;
  await assertCredential(url, key, {
    fetchImpl: async () => ({ ok: status === 200, status, text: async () => "{}" }),
    exit: c => { code = c; },
    log: m => lines.push(String(m)),
  });
  return { code, out: lines.join("\n") };
};

console.log("\na working key is silent and does not exit");
{
  const r = await run(GOOD, URL_, 200);
  ok(r.code === null && r.out === "", "no output, no exit");
}

console.log("\na rejected key names the cause, not a checklist");
{
  const wrongProject = jwt({ ref: "otherprojectref000", role: "service_role", exp: 2060000000 });
  const r1 = await run(wrongProject, URL_, 401);
  ok(/WRONG PROJECT/.test(r1.out), "wrong project is identified by comparing ref to the URL");
  ok(r1.code === 2, "and it exits non-zero so systemd stops rather than loops");

  const expired = jwt({ ref: "smoewpcbpjfcqpyswyli", role: "service_role", exp: 1600000000 });
  ok(/EXPIRED/.test((await run(expired, URL_, 401)).out), "an expired key says so");

  const anon = jwt({ ref: "smoewpcbpjfcqpyswyli", role: "anon", exp: 2060000000 });
  ok(/ROLE IS 'anon'/.test((await run(anon, URL_, 401)).out), "an anon key in the write slot says so");

  // The case that actually happened: everything looks right, so the key
  // must have been rotated. Saying "check these four things" here would
  // send the reader to check three that are already fine.
  const r2 = await run(GOOD, URL_, 401);
  ok(/ROTATED or revoked/.test(r2.out), "a valid-looking key rejected anyway is called a rotation");
  ok(!/WRONG PROJECT|EXPIRED|ROLE IS/.test(r2.out), "and does NOT list causes that were ruled out");

  const truncated = await run("eyJhbGciOiJIUzI1NiJ9.onlytwo", URL_, 401);
  ok(/not a JWT/.test(truncated.out), "a truncated value is called truncated, not rotated");
}

console.log("\nan unreachable host is not a bad key");
{
  let code = null; const lines = [];
  await assertCredential(URL_, GOOD, {
    fetchImpl: async () => { throw new Error("ENOTFOUND"); },
    exit: c => { code = c; }, log: m => lines.push(String(m)),
  });
  ok(/cannot reach Supabase/.test(lines.join("\n")), "a network failure says so rather than blaming the key");
  ok(code === 2, "still fatal — recording nothing is not a working state");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
