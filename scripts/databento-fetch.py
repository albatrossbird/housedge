#!/usr/bin/env python3
"""CME futures from Databento's historical API, bought once and KEPT, for
the commodity and FX 15-minute markets that settle on Pyth.
scripts/databento-compare.mjs scores the prices at each 15-minute boundary
against m15_settlements; the raw files are the second-by-second path for
anything after that (does CME move before Pyth, before Kalshi's book).

WHY DATABENTO. Pyth's own API needs a paid key since 2026-08-26 and
Kalshi's Pyth channel is $1,000 a month. Dukascopy is free but refused
the box after ~100 files (HTTP 429 for hours). Databento's HISTORICAL
data is usage-based and needs no subscription ("No subscription
required", databento.com/pricing); new accounts get $125 of credit.
Only LIVE CME data needs a plan ($199/month), and nothing here is live.

WHAT IT BUYS, for the volume-front contract (`GC.v.0`) of ten CME roots:
  ohlcv-1s / ohlcv-1m  trade bars. ts_event is the bar's START ("The
                       inclusive start time of the bar aggregation
                       period") and no bar prints without a trade, so the
                       boundary price is the LAST TRADE before it, within
                       60s. One-second and one-minute bars give the SAME
                       boundary price (the same last trade); only the path
                       between boundaries differs.
  bbo-1s               best bid and offer each second. ts_recv is the
                       interval END, and a record prints only when the
                       book or a trade changed ("If no trade or BBO update
                       occurs within the interval, no record is printed"),
                       so the book stands until the next record: the
                       boundary price is the MID, looked back up to 15
                       minutes.

THE RAW FILE IS THE PURCHASE, AND IT IS KEPT. Each week-sized piece is
saved as <dir>/raw/<root>.<schema>.<startMs>-<endMs>.dbn.zst, and the
workflow copies it to the private Storage bucket (databento/), which is
what decides "already bought" on a later run. The boundary CSV beside it
is derived and can be rebuilt from the raw file for nothing. A first
version deleted each raw file after taking the boundary prices out of it,
so a $25.62 one-second purchase (2026-10-29) left only the prices a $2.35
one-minute purchase had already given, and none of the path it was bought
for. Never again: a piece without its raw file counts as NOT held.

MONEY GUARDS.
  - Databento's own metadata.get_cost quotes everything not already held
    BEFORE any download; over --max-usd, nothing is bought.
  - --dry prints the quote and buys nothing. The workflow defaults to it.
  - One schema per run, named explicitly. There is no automatic fallback
    to a cheaper schema, which once meant a run could buy something
    nobody had looked at the price of.

The key comes from DATABENTO_API_KEY (a repository secret) and is never
printed.

  python3 scripts/databento-fetch.py --dir=databento --schema=bbo-1s [--markets=GC,SI] [--from=2026-08-18] [--max-usd=25] [--dry]
"""
import argparse
import csv
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import numpy as np

DATASET = "GLBX.MDP3"
# Kalshi series -> CME root. 6J is quoted in USD per yen; the compare
# step inverts it to USD/JPY, which is what KXUSDJPY15M settles on.
ROOTS = {
    "KXGOLD15M": "GC", "KXSILVER15M": "SI", "KXWTI15M": "CL", "KXNATGAS15M": "NG",
    "KXCOPPER15M": "HG", "KXPLATINUM15M": "PL", "KXPALLADIUM15M": "PA",
    "KXEURUSD15M": "6E", "KXGBPUSD15M": "6B", "KXUSDJPY15M": "6J",
}
SCHEMAS = ["bbo-1s", "ohlcv-1s", "ohlcv-1m"]
INTERVAL_NS = {"ohlcv-1s": 1_000_000_000, "ohlcv-1m": 60_000_000_000}
# How far back a boundary may look: a trade bar is the last TRADE, stale
# after a minute; a BBO record stands until the book changes.
MAX_AGE_NS = {"ohlcv-1s": 60 * 10**9, "ohlcv-1m": 60 * 10**9, "bbo-1s": 900 * 10**9}
BOUNDARY_NS = 900 * 1_000_000_000
UNDEF_PRICE = 2**63 - 1
WEEK_MS = 7 * 86400000
MONDAY_MS = 4 * 86400000   # 1970-01-05 was a Monday


def series_of(arr, schema):
    """(end_ns, price_fixed) for each record: when its price was current
    up to, and the price, at Databento's 1e-9 fixed point."""
    if len(arr) == 0:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
    if schema == "bbo-1s":
        bid, ask = arr["bid_px_00"].astype(np.int64), arr["ask_px_00"].astype(np.int64)
        ok = (bid > 0) & (ask > 0) & (bid != UNDEF_PRICE) & (ask != UNDEF_PRICE) & (ask >= bid)
        return arr["ts_recv"].astype(np.int64)[ok], (bid[ok].astype(np.float64) + ask[ok]) / 2
    return arr["ts_event"].astype(np.int64) + INTERVAL_NS[schema], arr["close"].astype(np.float64)


def boundary_rows(end, px, max_age_ns):
    """The last record current at or before each 15-minute boundary, no
    older than max_age_ns. Returns [(boundary_ms, price, record_end_ms)]."""
    if len(end) == 0:
        return []
    end = end.astype(np.int64)
    b = -(-end // BOUNDARY_NS) * BOUNDARY_NS          # ceil to the boundary
    keep = (b - end) < max_age_ns
    end, b, px = end[keep], b[keep], px[keep]
    if len(end) == 0:
        return []
    order = np.lexsort((end, b))                       # by boundary, then record end
    end, b, px = end[order], b[order], px[order]
    last = np.r_[b[1:] != b[:-1], True]                # last record per boundary
    return [(int(bb // 1_000_000), float(p) / 1e9, int(e // 1_000_000))
            for bb, p, e in zip(b[last], px[last], end[last])]


def spans_in(directory, root, schema, suffix):
    spans = []
    if not os.path.isdir(directory):
        return spans
    prefix = f"{root}.{schema}."
    for f in os.listdir(directory):
        if f.startswith(prefix) and f.endswith(suffix):
            try:
                s, e = f[len(prefix):-len(suffix)].split("-")
                spans.append((int(s), int(e)))
            except ValueError:
                pass                                   # a .part or foreign file
    return sorted(spans)


def missing_chunks(spans, start_ms, end_ms):
    """[start, end) minus what is held, cut at Monday 00:00 UTC so the
    files stay week-sized and a later run tops up the last one."""
    out, t = [], start_ms
    for s, e in sorted(spans) + [(end_ms, end_ms)]:
        if s > t:
            gap_end = min(s, end_ms)
            while t < gap_end:
                wk = ((t - MONDAY_MS) // WEEK_MS + 1) * WEEK_MS + MONDAY_MS
                out.append((t, min(wk, gap_end)))
                t = min(wk, gap_end)
        t = max(t, e)
        if t >= end_ms:
            break
    return out


def pick_markets(arg):
    """--markets: 'all', or a comma list naming each market by its Kalshi
    series or its CME root. An unknown name is refused rather than
    skipped: a typo must not quietly buy (or quote) less than was asked."""
    if arg.strip().lower() == "all":
        return dict(ROOTS)
    by_root = {r: s for s, r in ROOTS.items()}
    out = {}
    for name in (x.strip().upper() for x in arg.split(",") if x.strip()):
        if name in ROOTS:
            out[name] = ROOTS[name]
        elif name in by_root:
            out[by_root[name]] = name
        else:
            raise ValueError(f"unknown market '{name}': use a Kalshi series ({', '.join(ROOTS)}) or a CME root ({', '.join(by_root)})")
    if not out:
        raise ValueError("--markets named nothing")
    return out


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def raw_path(directory, root, schema, s, e):
    return os.path.join(directory, "raw", f"{root}.{schema}.{s}-{e}.dbn.zst")


def write_csv(directory, root, schema, s, e, rows):
    path = os.path.join(directory, f"{root}.{schema}.{s}-{e}.csv")
    with open(path + ".part", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["boundary_ms", "px", "end_ms"])
        w.writerows(rows)
    os.replace(path + ".part", path)                    # a killed run leaves no half file


def rows_from_raw(db, path, schema):
    arr = db.DBNStore.from_file(path).to_ndarray()
    end, px = series_of(arr, schema)
    return boundary_rows(end, px, MAX_AGE_NS[schema])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="databento")
    ap.add_argument("--from", dest="start", default="2026-08-18")
    ap.add_argument("--max-usd", type=float, default=25.0)
    ap.add_argument("--schema", required=True, choices=SCHEMAS)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--markets", default="all", help="comma list of Kalshi series or CME roots (KXGOLD15M or GC), or all")
    a = ap.parse_args()
    schema = a.schema
    try:
        markets = pick_markets(a.markets)
    except ValueError as e:
        print(f"::error::{e}")
        return 2

    key = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not key:
        print("::error::DATABENTO_API_KEY is not set — add it as a repository secret (Settings -> Secrets and variables -> Actions)")
        return 2

    import databento as db
    import pandas as pd                                 # a databento dependency
    client = db.Historical(key)
    raw_dir = os.path.join(a.dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)

    # Raw files already held (restored from Storage by the workflow) are
    # the purchase; their boundary CSVs are rebuilt here if missing, free.
    rebuilt = 0
    for root in markets.values():
        have_csv = set(spans_in(a.dir, root, schema, ".csv"))
        for s, e in spans_in(raw_dir, root, schema, ".dbn.zst"):
            if (s, e) not in have_csv:
                write_csv(a.dir, root, schema, s, e, rows_from_raw(db, raw_path(a.dir, root, schema, s, e), schema))
                rebuilt += 1
    if rebuilt:
        print(f"rebuilt {rebuilt} boundary files from raw files already held (no charge)")

    try:
        rng = client.metadata.get_dataset_range(DATASET)
    except db.BentoError as e:
        print(f"::error::Databento refused the dataset-range request: {e}")
        return 1
    avail_end = rng["end"] if isinstance(rng, dict) else rng.end
    end_ms = int(pd.Timestamp(avail_end).timestamp() * 1000) // 3600000 * 3600000   # whole hours only
    start_ms = int(datetime.fromisoformat(a.start).replace(tzinfo=timezone.utc).timestamp() * 1000)
    print(f"{DATASET} {schema}: {iso(start_ms)} -> {iso(end_ms)} (Databento's latest available, to the hour)")

    # Held means a RAW file exists. A boundary CSV alone (from before raw
    # files were kept) is not a purchase we can use again.
    jobs = [(series, root, s, e) for series, root in markets.items()
            for s, e in missing_chunks(spans_in(raw_dir, root, schema, ".dbn.zst"), start_ms, end_ms)]
    total = 0.0
    print(f"\nQUOTE {schema} (Databento's metadata.get_cost, before any download):")
    try:
        for series, root in markets.items():
            mine = [(s, e) for se, r, s, e in jobs if r == root]
            runs = []                                   # one quote per contiguous run of weeks
            for s, e in mine:
                if runs and runs[-1][1] == s:
                    runs[-1] = (runs[-1][0], e)
                else:
                    runs.append((s, e))
            cost = sum(client.metadata.get_cost(dataset=DATASET, start=iso(s), end=iso(e), symbols=[f"{root}.v.0"],
                                                schema=schema, stype_in="continuous") for s, e in runs)
            total += cost
            print(f"  {series:15s} {root + '.v.0':7s} {len(mine):3d} weeks to buy  ${cost:8.4f}")
    except db.BentoError as e:
        print(f"::error::Databento refused the cost quote: {e}")
        return 1
    print(f"  total ${total:.4f}  (cap ${a.max_usd:.2f})")
    with open(os.path.join(a.dir, "run.json"), "w") as f:
        json.dump({"schema": schema, "from": start_ms, "to": end_ms, "quotedUsd": total, "dry": a.dry, "markets": list(markets)}, f)
    if a.dry:
        print("\ndry run: nothing bought. Run again with dry unticked to buy at this price.")
        return 0
    if total > a.max_usd:
        print(f"::error::The quote is over the ${a.max_usd:.2f} cap. Nothing was bought.")
        return 1
    if not jobs:
        print("\nnothing to buy: every piece is already held")
        return 0

    # Several requests at once: each waits seconds on Databento, and 110
    # pieces one after another took over 25 minutes. One client per
    # thread; each piece's raw file is kept the moment it lands, so a
    # stopped run keeps everything it paid for.
    local = threading.local()

    def buy(root, s, e):
        if not hasattr(local, "client"):
            local.client = db.Historical(key)
        final = raw_path(a.dir, root, schema, s, e)
        part = final[:-len(".dbn.zst")] + ".part.dbn.zst"
        if os.path.exists(part):
            os.remove(part)                             # the client refuses to write over a file
        local.client.timeseries.get_range(dataset=DATASET, start=iso(s), end=iso(e), symbols=[f"{root}.v.0"],
                                          schema=schema, stype_in="continuous", path=part)
        os.replace(part, final)
        # Nothing from the returned store after the rename: it reads its
        # file lazily (store.nbytes stats `part`), and on 2026-10-29 that
        # turned 14 successful downloads into errors and stopped the run.
        return os.path.getsize(final), rows_from_raw(db, final, schema)

    print(f"\nbuying {len(jobs)} pieces, {a.workers} at a time; raw files kept in {raw_dir}")
    bought, failed = 0, None
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        futures = {pool.submit(buy, root, s, e): (series, root, s, e) for series, root, s, e in jobs}
        for fut in as_completed(futures):
            series, root, s, e = futures[fut]
            if fut.cancelled():
                continue                                # never started, nothing paid
            try:
                nbytes, rows = fut.result()
            except Exception as err:                    # BentoError, or a network failure
                print(f"::error::{root} {iso(s)}..{iso(e)}: {err}")
                if "licens" in str(err).lower() or "agreement" in str(err).lower():
                    print("::error::Databento wants a licence or agreement accepted in its portal for this dataset; accept it there and re-run.")
                if failed is None:
                    failed = err
                    for f in futures:
                        f.cancel()                      # nothing new starts; what is in flight finishes
                continue
            bought += nbytes
            write_csv(a.dir, root, schema, s, e, rows)
            print(f"  {series:15s} {iso(s)[:10]}..{iso(e)[:10]}  {nbytes / 1e6:6.1f} MB  {len(rows):5d} boundaries")
    print(f"\nbought {bought / 1e6:.1f} MB (quoted ${total:.4f}; Databento bills the bytes actually sent)")
    if failed is not None:
        print("stopped on the error above; a re-run buys only what is missing")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
