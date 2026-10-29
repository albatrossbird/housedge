"""scripts/databento-fetch.py: which bar stands for each 15-minute
boundary, and which weeks are still to buy. Needs numpy only (the
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

print("the bar that stands for a boundary:")
ts = np.array([B - 70, B - 30, B - 2, B - 1, B, B + 839], dtype=np.uint64) * S
px = np.array([1, 2, 3, 4, 5, 6], dtype=np.int64) * S
rows = f.boundary_rows(ts, px, f.INTERVAL_NS["ohlcv-1s"])
ok(rows == [(B * 1000, 4.0, B * 1000)], "the last 1s bar ENDING at or before it (ts_event is the bar's start)", rows)
ok(all(r[0] != (B + 900) * 1000 for r in rows), "a bar ending 60s or more before a boundary does not stand for it")
rows = f.boundary_rows(ts[:1], px[:1], f.INTERVAL_NS["ohlcv-1m"])
ok(rows == [(B * 1000, 1.0, (B - 10) * 1000)], "a 1m bar starting 70s before ends 10s before, and counts", rows)
ok(f.boundary_rows(np.array([], dtype=np.uint64), np.array([], dtype=np.int64), S) == [], "no bars, no boundaries")
shuffled = f.boundary_rows(ts[::-1].copy(), px[::-1].copy(), f.INTERVAL_NS["ohlcv-1s"])
ok(shuffled == [(B * 1000, 4.0, B * 1000)], "order of arrival does not matter")

print("\nwhat is still to buy:")
g = lambda *a: [((s - MON) / H, (e - MON) / H) for s, e in f.missing_chunks(*a)]
ok(g([], MON + 10 * H, MON + W + 5 * H) == [(10, 168), (168, 173)], "cut at Monday 00:00 UTC")
ok(g([(MON + 10 * H, MON + W)], MON + 10 * H, MON + W + 20 * H) == [(168, 188)], "a held week is not bought again")
ok(g([(MON + 10 * H, MON + W), (MON + W, MON + W + 5 * H)], MON + 10 * H, MON + W + 20 * H) == [(173, 188)], "a partial week is topped up, not re-bought")
ok(g([(MON + 10 * H, MON + W + 20 * H)], MON + 10 * H, MON + W + 20 * H) == [], "everything held, nothing to buy")
ok(g([(MON + 20 * H, MON + 30 * H)], MON + 10 * H, MON + 40 * H) == [(10, 20), (30, 40)], "gaps on both sides of a held span")

print(f"\n{failed} FAILED" if failed else "\nall passed")
sys.exit(1 if failed else 0)
