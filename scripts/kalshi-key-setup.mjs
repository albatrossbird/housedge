// Put a READ-ONLY Kalshi key on the box. Run once, as root, on the box.
//
// WHY. The recorder only reads. A key that can place orders, sitting on
// an internet-facing machine that runs code pulled from a public repo
// every few minutes, is risk with no upside.
//
// A key made on kalshi.com that is ALREADY read-only is adopted as it
// is. (Kalshi's docs describe no scope picker; the first real run proved
// the page issues read-only keys anyway.) A full-access key is used
// exactly once, to mint a key with `scopes: ["read"]`, and then deleted.
//
// Steps, each verified before the next:
//   1. mint an ed25519 key with scopes ["read"], signed by the temp key
//   2. write it to /etc/marketslap/kalshi-read.pem, root-only
//   3. prove it: list the account's keys SIGNED BY THE NEW KEY, and
//      require its scopes to contain nothing that writes
//   4. record its id as KALSHI_KEY_ID in /etc/marketslap/env
//   5. delete the temp key at Kalshi, then shred the temp file
//
// Nothing secret is printed. Key ids are identifiers, not credentials.
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync, openSync, writeSync, closeSync, fsyncSync, renameSync, chmodSync } from "node:fs";
import { loadKalshiKey, kalshiAuthed } from "../lib/kalshiAuth.js";
import { createPrivateKey } from "node:crypto";

const TEMP_FILE = process.env.KALSHI_TEMP_KEY_FILE || "/etc/marketslap/kalshi-temp.pem";
const TEMP_ID   = (process.env.KALSHI_TEMP_KEY_ID || "").trim();
const OUT       = process.env.KALSHI_READ_KEY_FILE || "/etc/marketslap/kalshi-read.pem";
const ENV_FILE  = process.env.MARKETSLAP_ENV_FILE || "/etc/marketslap/env";

const die = (msg) => { console.error(`FAILED: ${msg}`); process.exit(1); };
const step = (msg) => console.log(`ok  ${msg}`);

if (!TEMP_ID) die("set KALSHI_TEMP_KEY_ID to the Key ID Kalshi showed with the temporary key");
if (/[<>"'`\s]/.test(TEMP_ID)) die("KALSHI_TEMP_KEY_ID contains brackets, quotes or spaces — type the id alone");
if (existsSync(OUT)) die(`${OUT} already exists. If you are replacing it, delete it first: sudo rm ${OUT}`);

let temp;
try { temp = loadKalshiKey(TEMP_FILE); } catch (e) { die(e.message); }
step(`temporary key read from ${TEMP_FILE} (${temp.asymmetricKeyType})`);
const asTemp = { keyId: TEMP_ID, key: temp };

// The temp key must actually work before anything is minted with it.
const before = await kalshiAuthed("GET", "/api_keys", asTemp);
if (!before.ok) die(`Kalshi refused the temporary key: GET /api_keys -> ${before.status} ${JSON.stringify(before.body).slice(0, 200)}. Check the Key ID matches the key you pasted.`);
step(`temporary key accepted (${(before.body.api_keys || []).length} key(s) on the account)`);

// ALREADY READ-ONLY. Kalshi's web page CAN issue a read-only key — the
// first real run hit exactly that, and minting from it failed with
// `403 insufficient scope: write required` while telling the operator to
// delete a key that was the one we wanted. A read-only key is adopted as
// it is: moved into place, recorded, and NOT deleted.
{
  const mine = (before.body.api_keys || []).find(k => k.api_key_id === TEMP_ID);
  if (mine?.scopes?.length && !mine.scopes.some(s => s.startsWith("write"))) {
    step(`this key is already read-only (scopes [${mine.scopes.join(", ")}]) — using it as it is`);
    renameSync(TEMP_FILE, OUT);
    chmodSync(OUT, 0o600);
    step(`moved to ${OUT} (mode 600)`);
    recordKeyId(TEMP_ID);
    console.log("\nDONE — the box has a read-only Kalshi key and no key that can trade.");
    process.exit(0);
  }
}

// 1. Mint.
const gen = await kalshiAuthed("POST", "/api_keys/generate", {
  ...asTemp, body: { name: "marketslap-recorder-read", key_type: "ed25519", scopes: ["read"] },
});
if (!gen.ok || !gen.body?.private_key || !gen.body?.api_key_id)
  die(`minting the read-only key failed: ${gen.status} ${JSON.stringify(gen.body).slice(0, 300)}. The temporary key is still live — delete it on kalshi.com.`);
const newId = gen.body.api_key_id;
step(`read-only key minted: ${newId}`);

// 2. Store, root-only from the first byte (never world-readable, even briefly).
const fd = openSync(OUT, "wx", 0o600);
writeSync(fd, gen.body.private_key); fsyncSync(fd); closeSync(fd);
const readKey = createPrivateKey(readFileSync(OUT, "utf8"));
step(`written to ${OUT} (mode ${(statSync(OUT).mode & 0o777).toString(8)})`);

// 3. Prove the scope, signed by the NEW key — which also proves it signs.
const after = await kalshiAuthed("GET", "/api_keys", { keyId: newId, key: readKey });
if (!after.ok) die(`the new key does not authenticate: ${after.status}. The temporary key is still live — delete it on kalshi.com.`);
const mine = (after.body.api_keys || []).find(k => k.api_key_id === newId);
const writes = (mine?.scopes || ["(missing)"]).filter(s => s.startsWith("write") || s === "(missing)");
if (writes.length) {
  // Undo rather than leave a trading key lying about: remove it at Kalshi
  // (the temp key can) and on disk.
  const undo = await kalshiAuthed("DELETE", `/api_keys/${encodeURIComponent(newId)}`, asTemp);
  unlinkSync(OUT);
  die(`the new key has scopes [${(mine?.scopes || []).join(", ")}] — not read-only. ` +
    (undo.ok ? "It has been deleted again." : `Deleting it failed (${undo.status}) — delete ${newId} on kalshi.com.`) +
    " Delete the temporary key on kalshi.com too, and stop here.");
}
step(`verified by Kalshi: scopes [${mine.scopes.join(", ")}]`);

// 4. Record the id where the services read it.
recordKeyId(newId);

// 5. Retire the temp key: at Kalshi first, then on disk.
const del = await kalshiAuthed("DELETE", `/api_keys/${encodeURIComponent(TEMP_ID)}`, asTemp);
const left = await kalshiAuthed("GET", "/api_keys", { keyId: newId, key: readKey });
const stillThere = !left.ok || (left.body.api_keys || []).some(k => k.api_key_id === TEMP_ID);
const size = statSync(TEMP_FILE).size;
writeFileSync(TEMP_FILE, Buffer.alloc(size, 0)); unlinkSync(TEMP_FILE);
step(`temporary key file overwritten and removed`);
if (!del.ok || stillThere) {
  console.log(`\nACTION NEEDED: Kalshi did not confirm deleting the temporary key (${del.status}). Delete it on kalshi.com -> Account -> API Keys. The read-only key is set up and working.`);
  process.exit(2);
}
step(`temporary key deleted at Kalshi`);
const others = (left.body.api_keys || []).filter(k => k.api_key_id !== newId);
if (others.length) console.log(`note: ${others.length} other key(s) remain on the account: ${others.map(k => `${k.name} [${(k.scopes || []).join(",")}]`).join("; ")}`);
console.log("\nDONE — the box has a read-only Kalshi key and no key that can trade.");

function recordKeyId(id) {
  const env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const lines = env.split("\n").filter(l => !/^KALSHI_KEY_ID=/.test(l));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`KALSHI_KEY_ID=${id}`, "");
  writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
  step(`KALSHI_KEY_ID recorded in ${ENV_FILE}`);
}
