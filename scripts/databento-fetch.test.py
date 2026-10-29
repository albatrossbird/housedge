"""scripts/databento-fetch.py: which price stands for each 15-minute
boundary (trade bars and best bid/offer), and which weeks are still to buy. Needs numpy only (the
databento client is imported inside main()).

  python3 scripts/databento-fetch.test.py
"""
import importlib.util
import os
import sys

import numpy as np

spec = importlib.util.spec_from_file_location("fetch", os.path.join(os.path.dirname(__file__), "databento-fetch.py"))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)

failed = 0


def ok(cond, what, extra=""):
    global failed
    if cond:
        print(f"  ok  {what}")
    else:
        failed += 1
        print(f"FAIL {what} {extra}")


S = 10**9
B = 1_793_000_000 // 900 * 900          # a boundary, in seconds
H, W = 3_600_000, 7 * 86_400_000
MON = 1_792_800_000_000 // W * W + 4 * 86_400_000

print("the price that stands for a boundary:")
ts = np.array([B - 70, B - 30, B - 2, B - 1, B, B + 839], dtype=np.uint64) * S
px = np.array([1, 2, 3, 4, 5, 6], dtype=np.int64) * S
bars = np.zeros(len(ts), dtype=[("ts_event", "u8"), ("close", "i8")])
bars["ts_event"], bars["close"] = ts, px
rows = f.boundary_rows(*f.series_of(bars, "ohlcv-1s"), f.MAX_AGE_NS["ohlcv-1s"])
ok(rows == [(B * 1000, 4.0, B * 1000)], "the last 1s bar ENDING at or before it (ts_event is the bar's start)", rows)
ok(all(r[0] != (B + 900) * 1000 for r in rows), "a trade bar ending 60s or more before a boundary does not stand for it")
rows = f.boundary_rows(*f.series_of(bars[:1], "ohlcv-1m"), f.MAX_AGE_NS["ohlcv-1m"])
ok(rows == [(B * 1000, 1.0, (B - 10) * 1000)], "a 1m bar starting 70s before ends 10s before, and counts", rows)
ok(f.boundary_rows(*f.series_of(bars[:0], "ohlcv-1s"), 60 * S) == [], "no bars, no boundaries")
shuffled = bars[::-1].copy()
ok(f.boundary_rows(*f.series_of(shuffled, "ohlcv-1s"), 60 * S) == [(B * 1000, 4.0, B * 1000)], "order of arrival does not matter")

# BBO: ts_recv is the interval END and a record stands until the next one.
U = f.UNDEF_PRICE
bbo = np.zeros(5, dtype=[("ts_recv", "u8"), ("bid_px_00", "i8"), ("ask_px_00", "i8")])
bbo["ts_recv"] = np.array([B - 600, B - 5, B + 1, B + 2, B + 3], dtype=np.uint64) * S
bbo["bid_px_00"] = np.array([100, 101, U, 0, 104], dtype=np.int64) * np.where(np.array([1, 1, 0, 0, 1]), S, 1)
bbo["ask_px_00"] = np.array([102, 103, 105, 106, 104], dtype=np.int64) * S
bbo["bid_px_00"][2] = U
rows = f.boundary_rows(*f.series_of(bbo, "bbo-1s"), f.MAX_AGE_NS["bbo-1s"])
ok(rows[0] == (B * 1000, 102.0, (B - 5) * 1000), "bbo: the MID of the last book at or before the boundary", rows)
ok(len(rows) == 2 and rows[1] == ((B + 900) * 1000, 104.0, (B + 3) * 1000), "an undefined or zero side is no book; a locked book still has a mid", rows)
quiet = f.boundary_rows(*f.series_of(bbo[:1], "bbo-1s"), f.MAX_AGE_NS["bbo-1s"])
ok(quiet == [(B * 1000, 101.0, (B - 600) * 1000)], "a book unchanged for 10 minutes still stands (records print only on change)", quiet)
ok(f.boundary_rows(*f.series_of(bbo[:1], "bbo-1s"), 60 * S) == [], "and a trade bar's 60s limit would have dropped it")

print("\nwhat is still to buy:")
g = lambda *a: [((s - MON) / H, (e - MON) / H) for s, e in f.missing_chunks(*a)]
d = __import__("tempfile").mkdtemp()
os.makedirs(os.path.join(d, "raw"))
for n in ["GC.bbo-1s.10-20.dbn.zst", "GC.bbo-1s.20-30.part.dbn.zst", "GC.ohlcv-1s.1-2.dbn.zst", "SI.bbo-1s.5-6.dbn.zst"]:
    open(os.path.join(d, "raw", n), "w").close()
open(os.path.join(d, "GC.bbo-1s.30-40.csv"), "w").close()
ok(f.spans_in(os.path.join(d, "raw"), "GC", "bbo-1s", ".dbn.zst") == [(10, 20)], "held = a finished RAW file of this root and schema; a .part is not")
ok(f.spans_in(d, "GC", "bbo-1s", ".csv") == [(30, 40)], "a boundary CSV is found separately (and alone does not count as bought)")
ok(g([], MON + 10 * H, MON + W + 5 * H) == [(10, 168), (168, 173)], "cut at Monday 00:00 UTC")
ok(g([(MON + 10 * H, MON + W)], MON + 10 * H, MON + W + 20 * H) == [(168, 188)], "a held week is not bought again")
ok(g([(MON + 10 * H, MON + W), (MON + W, MON + W + 5 * H)], MON + 10 * H, MON + W + 20 * H) == [(173, 188)], "a partial week is topped up, not re-bought")
ok(g([(MON + 10 * H, MON + W + 20 * H)], MON + 10 * H, MON + W + 20 * H) == [], "everything held, nothing to buy")
ok(g([(MON + 20 * H, MON + 30 * H)], MON + 10 * H, MON + 40 * H) == [(10, 20), (30, 40)], "gaps on both sides of a held span")

print("\nwhich markets:")
ok(f.pick_markets("all") == f.ROOTS, "all is every market")
ok(f.pick_markets("GC") == {"KXGOLD15M": "GC"} and f.pick_markets("kxgold15m") == {"KXGOLD15M": "GC"}, "a market by its CME root or its Kalshi series, any case")
ok(list(f.pick_markets("SI, 6j ,KXWTI15M")) == ["KXSILVER15M", "KXUSDJPY15M", "KXWTI15M"], "a comma list, spaces allowed")
for bad in ["GCX", "", " , "]:
    try:
        f.pick_markets(bad); ok(False, f"'{bad}' is refused")
    except ValueError:
        ok(True, f"'{bad}' is refused, not skipped")

print("\nthe per-second path (scripts/databento-ticks.py):")
tspec = importlib.util.spec_from_file_location("ticks", os.path.join(os.path.dirname(__file__), "databento-ticks.py"))
t = importlib.util.module_from_spec(tspec)
tspec.loader.exec_module(t)
a = (np.array([3, 1, 2], dtype=np.int64) * 10**9, np.array([30, 10, 20], dtype=np.float64) * 10**9)
b = (np.array([3, 4], dtype=np.int64) * 10**9, np.array([33, 40], dtype=np.float64) * 10**9)
ms, mid = t.merge([a, b])
ok(ms.tolist() == [1000, 2000, 3000, 4000] and mid.tolist() == [10, 20, 33, 40], "sorted, in ms and price units; a second held twice keeps the later piece", (ms.tolist(), mid.tolist()))
ms, mid = t.merge([])
ok(len(ms) == 0, "nothing held, nothing written")

print(f"\n{failed} FAILED" if failed else "\nall passed")
sys.exit(1 if failed else 0)
