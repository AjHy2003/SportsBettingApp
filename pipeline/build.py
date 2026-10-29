"""Build every league's data files. One league failing keeps its last good output.

Usage: python pipeline/build.py --out _site/data --cache cache [--only nfl,nba,nhl,nascar]
"""
import argparse
import datetime as dt
import os
import shutil
import sys
import traceback

sys.path.insert(0, os.path.dirname(__file__))

import nascar  # noqa: E402
import nba  # noqa: E402
import nfl  # noqa: E402
import nhl  # noqa: E402
from common import write_json  # noqa: E402

BUILDERS = {"nfl": nfl.build, "nba": nba.build, "nhl": nhl.build, "nascar": nascar.build}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="_site/data")
    ap.add_argument("--cache", default="cache")
    ap.add_argument("--only", default=",".join(BUILDERS))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    last_good = os.path.join(args.cache, "last_good")
    status = {}
    for name in args.only.split(","):
        started = dt.datetime.utcnow()
        try:
            BUILDERS[name](args.out, args.cache)
            # Keep a copy so a later failed run can still publish this data.
            shutil.rmtree(os.path.join(last_good, name), ignore_errors=True)
            shutil.copytree(os.path.join(args.out, name), os.path.join(last_good, name))
            status[name] = {"ok": True, "built": started.isoformat() + "Z"}
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            prev = os.path.join(last_good, name)
            if os.path.isdir(prev):
                shutil.copytree(prev, os.path.join(args.out, name), dirs_exist_ok=True)
            status[name] = {"ok": False, "error": repr(e)[:300], "attempted": started.isoformat() + "Z", "stale": os.path.isdir(prev)}
    write_json(os.path.join(args.out, "status.json"), status)
    print(status)


if __name__ == "__main__":
    main()
