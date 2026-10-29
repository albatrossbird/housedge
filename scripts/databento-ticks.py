#!/usr/bin/env python3
"""The second-by-second CME path, out of the raw bbo-1s files already
bought (scripts/databento-fetch.py), as CSV a Node script can read:
<dir>/ticks/<root>.bbo-1s.csv with one row per record, `ms,mid`.

Reads only what is held in <dir>/raw. Buys nothing and needs no key: the
Databento client opens a local .dbn.zst file without the network.

ms is ts_recv, the END of the one-second interval the record describes,
in ms. A record prints only when the book or a trade changed, so a mid
stands until the next row. Pieces can meet at a top-up boundary; a
timestamp held twice keeps the later piece's row.

  python3 scripts/databento-ticks.py --dir=databento --markets=GC[,CL]
"""

import argparse
import importlib.util
import os
import sys

import numpy as np

spec = importlib.util.spec_from_file_location("fetch", os.path.join(os.path.dirname(__file__), "databento-fetch.py"))
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

SCHEMA = "bbo-1s"


def merge(pieces):
    """[(end_ns, px_fixed)] per piece, in piece order -> (ms, mid) sorted
    by time, one row per timestamp (the later piece wins)."""
    if not pieces:
        return np.array([], dtype=np.int64), np.array([], dtype=np.float64)
    end = np.concatenate([p[0] for p in pieces]).astype(np.int64)
    px = np.concatenate([p[1] for p in pieces]).astype(np.float64)
    order = np.argsort(end, kind="stable")          # stable: a later piece stays later
    end, px = end[order], px[order]
    last = np.r_[end[1:] != end[:-1], True]
    return end[last] // 1_000_000, px[last] / 1e9


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="databento")
    ap.add_argument("--markets", required=True)
    a = ap.parse_args()
    import databento as db

    raw = os.path.join(a.dir, "raw")
    os.makedirs(os.path.join(a.dir, "ticks"), exist_ok=True)
    failed = 0
    for series, root in fetch.pick_markets(a.markets).items():
        spans = fetch.spans_in(raw, root, SCHEMA, ".dbn.zst")
        if not spans:
            print(f"::error::{series} ({root}): no raw {SCHEMA} file held — buy it first (Databento vs Pyth)")
            failed += 1
            continue
        pieces = []
        for s, e in spans:
            arr = db.DBNStore.from_file(fetch.raw_path(a.dir, root, SCHEMA, s, e)).to_ndarray()
            pieces.append(fetch.series_of(arr, SCHEMA))
        ms, mid = merge(pieces)
        out = os.path.join(a.dir, "ticks", f"{root}.{SCHEMA}.csv")
        with open(out + ".part", "w") as f:
            f.write("ms,mid\n")
            for t, p in zip(ms.tolist(), mid.tolist()):
                f.write(f"{t},{p:.9g}\n")
        os.replace(out + ".part", out)
        first, last = fetch.iso(int(ms[0])), fetch.iso(int(ms[-1]))
        print(f"  {series:15} {root}: {len(ms):,} rows from {len(spans)} raw files, {first} -> {last}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
