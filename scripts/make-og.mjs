// Regenerates public/og.png, the 1200x630 card every share of the site
// renders.
//
// It used to be a one-off file with no source, so when the hero copy
// changed the card kept the OLD wording — and a share card is the only
// part of a site people read WITHOUT visiting it. This script is the
// source, so the two cannot drift again.
//
//   node scripts/make-og.mjs
//
// Inter is pulled from Google Fonts and embedded, because the card must
// render identically on any machine rather than in whatever the runner
// calls system-ui.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(root, "node_modules", ".cache-inter-og.woff2");

// Kept in sync with pages/index.js by hand — a card that disagrees with
// the page is worse than no card.
const HEADLINE = "Same event, different prices";
const SUB = "Kalshi and Polymarket, side by side — with each venue's fees already in the price.";

async function inter() {
  if (existsSync(CACHE)) return readFileSync(CACHE);
  const css = await (await fetch(
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;800&display=swap",
    { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" } }
  )).text();
  const url = css.match(/\/\*\s*latin\s*\*\/[\s\S]*?url\((https:\/\/[^)]+)\)/)[1];
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(CACHE, buf);
  return buf;
}

const font = (await inter()).toString("base64");
// The mark's own artwork, not a copy of it.
const markSvg = readFileSync(join(root, "public", "logo-mark-dark.svg"), "utf8")
  .replace("<svg", '<svg width="86" height="88"');

const html = `<style>
@font-face{font-family:'I';font-weight:100 900;src:url(data:font/woff2;base64,${font}) format('woff2')}
*{margin:0;padding:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#0A1329;font-family:'I',system-ui,sans-serif;
     position:relative;overflow:hidden}
/* The oversized mark bled off the right edge, at low contrast — it reads
   as texture at thumbnail size rather than as a second logo. */
.bleed{position:absolute;right:-190px;top:-120px;width:900px;opacity:.055;transform:rotate(-4deg)}
.pad{position:absolute;left:94px;top:150px;width:720px}
.wm{font-size:74px;font-weight:800;letter-spacing:.085em;line-height:1;margin:28px 0 30px}
.wm .a{color:#FFFFFF}
.wm .b{background:linear-gradient(100deg,#9B80FF 0%,#7C6BF0 45%,#4FC3DA 95%);
       -webkit-background-clip:text;background-clip:text;color:transparent}
.h{font-size:36px;font-weight:800;color:#FFFFFF;letter-spacing:-0.015em;line-height:1.15;margin-bottom:18px}
.s{font-size:23px;font-weight:400;color:#96A6C8;line-height:1.45;max-width:660px}
.u{position:absolute;left:94px;bottom:66px;font-size:19px;font-weight:800;
   letter-spacing:.02em;color:#6B7FA8}
</style>
<div class="bleed">${markSvg.replace('width="86" height="88"','width="900"')}</div>
<div class="pad">
  ${markSvg}
  <div class="wm"><span class="a">MARKET</span><span class="b">SLAP</span></div>
  <div class="h">${HEADLINE}</div>
  <div class="s">${SUB}</div>
</div>
<div class="u">marketslap.com</div>`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await p.setContent(html);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(300);
await p.screenshot({ path: join(root, "public", "og.png") });
await b.close();
console.log("wrote public/og.png (1200x630)");
