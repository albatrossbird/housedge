// scripts/kalshi-key-setup.mjs against the fake Kalshi. The script runs
// once, as root, on the box, and its whole job is to leave no key that
// can trade — so the test pins that, and that it stops safely.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync, statSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;

function run({ tempId = "temp-1", registeredId = "temp-1", preexisting = false, genScopes = null, tempScopes = ["read", "write"], envBefore = "SUPABASE_URL=https://x.supabase.co\nKALSHI_KEY_ID=old\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keysetup-"));
  // What kalshi.com's web page issues: RSA, PKCS#1.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const temp = join(dir, "temp.pem"), out = join(dir, "read.pem"), env = join(dir, "env"), res = join(dir, "log.json");
  writeFileSync(temp, privateKey.export({ type: "pkcs1", format: "pem" }));
  writeFileSync(env, envBefore);
  if (preexisting) writeFileSync(out, "existing");
  const h = join(dir, "h.mjs");
  writeFileSync(h, `
    import { writeFileSync } from "node:fs";
    import { installFakeKalshi, FAKE_REST } from ${JSON.stringify(join(HERE, "fake-kalshi.mjs"))};
    process.env.KALSHI_REST_BASE = FAKE_REST;
    process.env.KALSHI_TEMP_KEY_FILE = ${JSON.stringify(temp)};
    process.env.KALSHI_TEMP_KEY_ID = ${JSON.stringify(tempId)};
    process.env.KALSHI_READ_KEY_FILE = ${JSON.stringify(out)};
    process.env.MARKETSLAP_ENV_FILE = ${JSON.stringify(env)};
    const fake = installFakeKalshi({ publicKeyPem: ${JSON.stringify(publicKey.export({ type: "spki", format: "pem" }))},
      keyId: ${JSON.stringify(registeredId)}, scopes: ${JSON.stringify(tempScopes)} });
    ${genScopes ? `const f = globalThis.fetch; globalThis.fetch = (u, i = {}) => {
      if (String(u).endsWith("/api_keys/generate")) i = { ...i, body: JSON.stringify({ ...JSON.parse(i.body), scopes: ${JSON.stringify(genScopes)} }) };
      return f(u, i); };` : ""}
    process.on("exit", () => writeFileSync(${JSON.stringify(res)}, JSON.stringify(fake.log)));
    await import(${JSON.stringify(join(HERE, "kalshi-key-setup.mjs"))});
  `);
  let code = 0, text = "";
  try { text = execFileSync(process.execPath, [h], { stdio: "pipe" }).toString(); }
  catch (e) { code = e.status; text = String(e.stdout) + String(e.stderr); }
  return { code, text, log: JSON.parse(readFileSync(res, "utf8")), temp, out, env: readFileSync(env, "utf8") };
}

let failed = 0;
const ok = (c, w, r) => { if (c) console.log(`  ok  ${w}`); else { failed++; console.error(`FAIL ${w}\n${r?.text || ""}`); } };

console.log("the normal path");
{
  const r = run();
  ok(r.code === 0 && /DONE/.test(r.text), "completes", r);
  ok(r.log.generated.length === 1 && JSON.stringify(r.log.generated[0].scopes) === '["read"]', "mints exactly one key, asking for read only", r);
  ok(existsSync(r.out) && (statSync(r.out).mode & 0o777) === 0o600, "stores it root-only", r);
  ok(/^KALSHI_KEY_ID=gen-2$/m.test(r.env) && !/KALSHI_KEY_ID=old/.test(r.env) && /SUPABASE_URL=/.test(r.env), "replaces KALSHI_KEY_ID, keeps the rest of the env file", r);
  ok(r.log.deleted.includes("temp-1"), "deletes the temporary key at Kalshi", r);
  ok(!existsSync(r.temp), "and removes it from disk", r);
  ok(!/BEGIN/.test(r.text), "prints no key material", r);
}

console.log("\nthe web page already issued a read-only key (the first real run)");
{
  const r = run({ tempScopes: ["read"] });
  ok(r.code === 0 && /already read-only/.test(r.text), "adopts it instead of failing", r);
  ok(r.log.generated.length === 0 && r.log.deleted.length === 0, "mints nothing and deletes nothing", r);
  ok(existsSync(r.out) && (statSync(r.out).mode & 0o777) === 0o600 && !existsSync(r.temp), "moves it into place, root-only", r);
  ok(/^KALSHI_KEY_ID=temp-1$/m.test(r.env) && !/KALSHI_KEY_ID=old/.test(r.env), "and records its id", r);
}

console.log("\nthe Key ID typed wrong");
{
  const r = run({ tempId: "temp-typo" });
  ok(r.code === 1 && r.log.generated.length === 0, "stops before minting anything", r);
  ok(existsSync(r.temp), "and leaves the temp file for a retry", r);
}

console.log("\nthe Key ID typed with brackets");
{
  const r = run({ tempId: "<temp-1>" });
  ok(r.code === 1 && /brackets/.test(r.text) && r.log.generated.length === 0, "refuses, and says why", r);
}

console.log("\na read key already on the box");
{
  const r = run({ preexisting: true });
  ok(r.code === 1 && r.log.generated.length === 0 && readFileSync(r.out, "utf8") === "existing", "refuses to overwrite it", r);
}

console.log("\nCONTROL: Kalshi mints a key that can trade");
{
  const r = run({ genScopes: ["read", "write"] });
  ok(r.code === 1 && /not read-only/.test(r.text), "detects it from Kalshi's own key list and stops", r);
  ok(!/KALSHI_KEY_ID=gen/.test(r.env), "and does NOT record it for the services", r);
  ok(r.log.deleted.includes("gen-2") && !existsSync(r.out), "and deletes the trading key again, at Kalshi and on disk", r);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
