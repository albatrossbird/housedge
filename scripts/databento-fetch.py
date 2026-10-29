#!/usr/bin/env python3
"""CME futures prices at every 15-minute boundary, from Databento's
historical API, as a stand-in for the Pyth prices Kalshi's commodity and
FX 15-minute markets settle on. scripts/databento-compare.mjs reads what
this writes and scores it against m15_settlements.

WHY DATABENTO. Pyth's own API needs a paid key since 2026-08-26 and
Kalshi's Pyth channel is $1,000 a month. Dukascopy is free but refused
the box after ~100 files (HTTP 429 for hours). Databento's HISTORICAL
data is usage-based and needs no subscription ("No subscription
required", databento.com/pricing); new accounts get $125 of credit.
Only LIVE CME data needs a plan ($199/month), and nothing here is live.

WHAT IT BUYS. One-second (or one-minute) OHLCV bars of the volume-front
contract (`GC.v.0`) for ten CME roots, and keeps only the last bar
ending at or before each 15-minute boundary, within 60 seconds. A bar's
ts_event is the START of its interval ("The inclusive start time of the
bar aggregation period"), and no bar is printed for an interval with no
trade, so the bar is the last TRADE before the boundary, not a mid.

MONEY GUARDS.
  - The cost of everything not already held is asked of Databento's own
    metadata.get_cost BEFORE any download, and the run stops if it is
    over --max-usd. `auto` takes one-second bars if they fit and
    one-minute bars otherwise.
  - Results are kept per symbol and week in --dir, which the workflow
    keeps in the Actions cache, so a re-run or a later run buys only
    the hours it does not have. A failed compare step costs nothing to
    re-run.
  - --dry prints the quote and buys nothing.

The key comes from DATABENTO_API_KEY (a repository secret) and is never
printed.

  python3 scripts/databento-fetch.py --dir=databento --from=2026-08-18 [--max-usd=25] [--schema=auto] [--dry]
"""
import argparse
import csv
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import numpy as np

DATASET = "GLBX.MDP3"
# Kalshi series -> CME root. 6J is quoted in USD per yen; the compare
# step inverts it to USD/JPY, which is what KXUSDJPY15M settles on.
ROOTS = {
    "KXGOLD15M": "GC", "KXSILVER15M": "SI", "KXWTI15M": "CL", "KXNATGAS15M": "NG",
    "KXCOPPER15M": "HG", "KXPLATINUM15M": "PL", "KXPALLADIUM15M": "PA",
    "KXEURUSD15M": "6E", "KXGBPUSD15M": "6B", "KXUSDJPY15M": "6J",
}
INTERVAL_NS = {"ohlcv-1s": 1_000_000_000, "ohlcv-1m": 60_000_000_000}
BOUNDARY_NS = 900 * 1_000_000_000
MAX_AGE_NS = 60 * 1_000_000_000
WEEK_MS = 7 * 86400000
MONDAY_MS = 4 * 86400000   # 1970-01-05 was a Monday


def boundary_rows(ts_event, close, interval_ns):
    """The last bar ending at or before each 15-minute boundary, within
    60s. Returns [(boundary_ms, price, bar_end_ms)]. close is Databento's
    fixed-point price (1e-9)."""
    if len(ts_event) == 0:
        return []
    end = ts_event.astype(np.int64) + interval_ns
    b = -(-end // BOUNDARY_NS) * BOUNDARY_NS          # ceil to the boundary
    keep = (b - end) < MAX_AGE_NS
    end, b, px = end[keep], b[keep], close[keep]
    if len(end) == 0:
        return []
    order = np.lexsort((end, b))                       # by boundary, then bar end
    end, b, px = end[order], b[order], px[order]
    last = np.r_[b[1:] != b[:-1], True]                # last bar per boundary
    return [(int(bb // 1_000_000), float(p) / 1e9, int(e // 1_000_000))
            for bb, p, e in zip(b[last], px[last], end[last])]


def held_spans(directory, root, schema):
    spans = []
    if not os.path.isdir(directory):
        return spans
    prefix = f"{root}.{schema}."
    for f in os.listdir(directory):
        if f.startswith(prefix) and f.endswith(".csv"):
            s, e = f[len(prefix):-4].split("-")
            spans.append((int(s), int(e)))
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


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="databento")
    ap.add_argument("--from", dest="start", default="2026-08-18")
    ap.add_argument("--max-usd", type=float, default=25.0)
    ap.add_argument("--schema", default="auto", choices=["auto", "ohlcv-1s", "ohlcv-1m"])
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    key = os.environ.get("DATABENTO_API_KEY", "").strip()
    if not key:
        print("::error::DATABENTO_API_KEY is not set — add it as a repository secret (Settings -> Secrets and variables -> Actions)")
        return 2

    import databento as db
    client = db.Historical(key)

    try:
        rng = client.metadata.get_dataset_range(DATASET)
    except db.BentoError as e:
        print(f"::error::Databento refused the dataset-range request: {e}")
        return 1
    import pandas as pd                                 # a databento dependency
    avail_end = rng["end"] if isinstance(rng, dict) else rng.end
    end_ms = int(pd.Timestamp(avail_end).timestamp() * 1000)
    end_ms = end_ms // 3600000 * 3600000               # whole hours only
    start_ms = int(datetime.fromisoformat(a.start).replace(tzinfo=timezone.utc).timestamp() * 1000)
    print(f"{DATASET}: {iso(start_ms)} -> {iso(end_ms)} (Databento's latest available, to the hour)")

    os.makedirs(a.dir, exist_ok=True)

    def quote(schema):
        total, rows = 0.0, []
        for series, root in ROOTS.items():
            gaps = missing_chunks(held_spans(a.dir, root, schema), start_ms, end_ms)
            cost = 0.0
            # One quote per contiguous run of missing weeks.
            runs = []
            for s, e in gaps:
                if runs and runs[-1][1] == s:
                    runs[-1] = (runs[-1][0], e)
                else:
                    runs.append((s, e))
            for s, e in runs:
                cost += client.metadata.get_cost(dataset=DATASET, start=iso(s), end=iso(e),
                                                 symbols=[f"{root}.v.0"], schema=schema, stype_in="continuous")
            total += cost
            rows.append((series, root, len(gaps), cost))
        return total, rows

    order = ["ohlcv-1s", "ohlcv-1m"] if a.schema == "auto" else [a.schema]
    chosen = None
    for schema in order:
        try:
            total, rows = quote(schema)
        except db.BentoError as e:
            print(f"::error::Databento refused the cost quote for {schema}: {e}")
            return 1
        print(f"\nQUOTE {schema} (Databento's metadata.get_cost, before any download):")
        for series, root, n, cost in rows:
            print(f"  {series:15s} {root + '.v.0':7s} {n:3d} weeks to buy  ${cost:8.4f}")
        print(f"  total ${total:.4f}  (cap ${a.max_usd:.2f})")
        if total <= a.max_usd:
            chosen = (schema, total)
            break
    if chosen is None:
        print(f"::error::Every schema tried costs more than the ${a.max_usd:.2f} cap. Nothing was bought. Raise max_usd or move 'from' later.")
        return 1
    schema, total = chosen
    print(f"\nusing {schema}, quoted ${total:.4f}")
    with open(os.path.join(a.dir, "run.json"), "w") as f:
        json.dump({"schema": schema, "from": start_ms, "to": end_ms, "quotedUsd": total, "dry": a.dry}, f)
    if a.dry:
        print("dry run: nothing bought")
        return 0

    bought = 0
    for series, root in ROOTS.items():
        for s, e in missing_chunks(held_spans(a.dir, root, schema), start_ms, end_ms):
            with tempfile.NamedTemporaryFile(suffix=".dbn.zst") as tmp:
                try:
                    store = client.timeseries.get_range(dataset=DATASET, start=iso(s), end=iso(e),
                                                        symbols=[f"{root}.v.0"], schema=schema,
                                                        stype_in="continuous", path=tmp.name)
                except db.BentoError as err:
                    print(f"::error::{root} {iso(s)}..{iso(e)}: {err}")
                    if "licens" in str(err).lower() or "agreement" in str(err).lower():
                        print("::error::Databento wants a licence or agreement accepted in its portal for this dataset; accept it there and re-run.")
                    return 1
                bought += store.nbytes
                arr = store.to_ndarray()
                rows = boundary_rows(arr["ts_event"], arr["close"], INTERVAL_NS[schema])
            path = os.path.join(a.dir, f"{root}.{schema}.{s}-{e}.csv")
            with open(path + ".part", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(["boundary_ms", "px", "end_ms"])
                w.writerows(rows)
            os.replace(path + ".part", path)                # a killed run leaves no half file
            print(f"  {series:15s} {iso(s)[:10]}..{iso(e)[:10]}  {len(rows):5d} boundaries")
    print(f"\nbought {bought / 1e6:.1f} MB (quoted ${total:.4f}; Databento bills the bytes actually sent)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
