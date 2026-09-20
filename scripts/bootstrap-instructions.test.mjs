// The closing instructions in deploy/bootstrap.sh must PRINT, not run.
//
// That block is prose about shell, so it is dense in exactly the
// characters shell acts on. It was an unquoted heredoc, so bash treated
// the backticks in it as command substitution and died:
//
//   bash: command substitution: line 92: syntax error near unexpected
//   token `newline'
//
// on the paragraph `<the service_role key>` — the warning about pasting
// angle brackets, eaten by angle brackets. Every unit was already
// installed by then, so nothing broke; the reader simply got a bash
// error where the instructions should have been, at the one step the
// script cannot do for them.
//
// `bash -n` DOES NOT CATCH THIS, and believing it did is how the fix
// was nearly shipped broken: with the heredoc opener accidentally
// deleted, the prose parsed as a list of commands and `bash -n` passed
// clean. A syntax check cannot tell text from instructions. Only
// running the block can.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

let bad = 0;
const ok = (c, w) => { if (c) console.log(`  ok  ${w}`); else { bad++; console.error(`FAIL ${w}`); } };

const src = readFileSync("deploy/bootstrap.sh", "utf8");
const lines = src.split("\n");

console.log("the heredoc is quoted, which is what makes the block inert");
{
  ok(/\ncat <<'EOF'\n/.test(src), "opener is cat <<'EOF', not cat <<EOF");
  ok(!/\ncat <<EOF\n/.test(src), "no unquoted heredoc anywhere in the script");
}

// Find whatever opener is actually there — quoted or not — and keep it
// VERBATIM, so the run below is the run the box does. Matching only the
// quoted form would make the runtime check pass vacuously against a
// broken script: the slice would come back wrong, the block would be
// re-emitted under an opener this test supplied, and the one defect it
// exists to catch would print clean. That is the shape of bug this
// repo keeps finding — a check that cannot fail.
const open = lines.findIndex(l => /^cat <<'?EOF'?$/.test(l));
const close = lines.findIndex((l, i) => i > open && l === "EOF");
if (open < 0 || close <= open) {
  console.error("FAIL could not find the instructions heredoc in deploy/bootstrap.sh");
  process.exit(1);
}
const opener = lines[open];
const body = lines.slice(open + 1, close);

console.log("\nand nothing inside it is waiting to be expanded");
{
  // A leftover $VAR would print empty on a box where the script is read
  // rather than sourced, which is worse than printing wrong: a reader
  // copies `sudo nano ` and edits nothing.
  const vars = body.filter(l => /\$[A-Za-z_][A-Za-z0-9_]*/.test(l));
  ok(vars.length === 0, `no bare $VAR left in the prose${vars.length ? `: ${vars[0].trim()}` : ""}`);
  ok(body.some(l => l.includes("/etc/marketslap/env")), "the env path is written out in full");
  ok(body.some(l => l.includes("/opt/marketslap")), "so is the checkout path");
}

console.log("\nthe block RUNS and prints, which bash -n cannot tell you");
{
  // Run the extracted block exactly as the script would. Any expansion
  // or substitution left in it fails here, on stderr, with a non-zero
  // exit — the failure mode that actually reached the user.
  let out = "", err = "", code = 0;
  try {
    out = execFileSync("bash", ["-c", [opener, ...body, "EOF"].join("\n")],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { code = e.status ?? 1; err = String(e.stderr || ""); }
  ok(code === 0, "exits clean");
  ok(err === "", `writes nothing to stderr${err ? `: ${err.split("\n")[0]}` : ""}`);
  ok(out.split("\n").length === body.length + 1, "prints every line of the block");

  // The two things the reader must not get wrong, and the reason this
  // block exists at all. A placeholder you are meant to delete part of
  // is a placeholder that gets pasted over in part — that cost fourteen
  // hours of a recorder restarting against `401 Invalid API key`.
  ok(/NO ANGLE BRACKETS/.test(out), "still warns about the angle brackets");
  ok(/SUPABASE_SERVICE_ROLE_KEY=\n/.test(out),
     "and the placeholder is a bare '=', with nothing to delete");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
