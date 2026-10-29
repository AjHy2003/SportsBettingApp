"""Shared ESPN box-score fetching: completed events for the current season + cached summaries."""
import datetime as dt
import json
import os
from concurrent.futures import ThreadPoolExecutor

from common import get

SITE = "https://site.api.espn.com/apis/site/v2/sports"


def season_events(path, cache_dir, key):
    """Completed regular/post-season event ids for the current season, via daily scoreboards."""
    sb = get(f"{SITE}/{path}/scoreboard")
    lg = sb["leagues"][0]
    start = dt.date.fromisoformat(lg["season"]["startDate"][:10])
    today = dt.date.today()
    sb_dir = os.path.join(cache_dir, f"espn_{key}", "scoreboards")
    os.makedirs(sb_dir, exist_ok=True)
    events = []
    d = start
    while d < today:
        ymd = d.strftime("%Y%m%d")
        cache = os.path.join(sb_dir, f"{ymd}.json")
        if os.path.exists(cache):
            with open(cache) as f:
                day = json.load(f)
        else:
            try:
                js = get(f"{SITE}/{path}/scoreboard?dates={ymd}") or {}
            except Exception as e:  # noqa: BLE001 - one bad day shouldn't sink the season; retried next run
                print(f"  skip scoreboard {ymd}: {e!r}", flush=True)
                d += dt.timedelta(days=1)
                continue
            day = [{"id": e["id"], "type": e.get("season", {}).get("type"), "done": e["status"]["type"]["completed"]} for e in js.get("events", [])]
            # Only cache days that are fully final (late games may still be running).
            if all(e["done"] for e in day) and d < today - dt.timedelta(days=1):
                with open(cache, "w") as f:
                    json.dump(day, f)
        events += [e["id"] for e in day if e["done"] and e["type"] in (2, 3)]
        d += dt.timedelta(days=1)
    return lg["season"]["year"], events


def load_boxes(path, cache_dir, key, events, parse, workers=6):
    """[(event_id, compact_box)] for completed games; parsed boxes are cached forever."""
    box_dir = os.path.join(cache_dir, f"espn_{key}", "box")
    os.makedirs(box_dir, exist_ok=True)

    def one(ev):
        f = os.path.join(box_dir, f"{ev}.json")
        if os.path.exists(f):
            with open(f) as fh:
                return ev, json.load(fh)
        try:
            js = get(f"{SITE}/{path}/summary?event={ev}")
            box = parse(js) if js else None
        except Exception as e:  # noqa: BLE001 - skip and retry on the next run
            print(f"  skip summary {ev}: {e!r}", flush=True)
            return ev, None
        if box:
            with open(f, "w") as fh:
                json.dump(box, fh)
        return ev, box

    with ThreadPoolExecutor(workers) as pool:
        return [(ev, b) for ev, b in pool.map(one, events) if b]
