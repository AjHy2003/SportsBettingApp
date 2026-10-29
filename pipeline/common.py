"""Shared helpers for the data pipeline."""
import json
import math
import os
import time

import requests

UA = "Mozilla/5.0 (compatible; PickLab data pipeline; +https://github.com/AjHy2003/sports-picks)"
session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept": "application/json, */*"})


def get(url, *, as_json=True, tries=4, timeout=40):
    for i in range(tries):
        try:
            r = session.get(url, timeout=timeout)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json() if as_json else r.content
        except Exception as e:  # noqa: BLE001 - retry anything transient
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} {url[:90]}: {e}", flush=True)
            time.sleep(2 ** i)


def download(url, path, max_age_hours=6):
    """Download to path unless a fresh copy is already cached."""
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_hours * 3600:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url, as_json=False, timeout=180)
    if data is None:
        raise FileNotFoundError(url)
    with open(path, "wb") as f:
        f.write(data)
    return path


def clean(v, nd=3):
    """JSON-safe rounding: NaN/inf -> None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    if math.isnan(f) or math.isinf(f):
        return None
    if f == int(f) and abs(f) < 1e12:
        return int(f)
    return round(f, nd)


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)


def ranks(values, ascending=True):
    """Rank dict values (1 = smallest when ascending). Returns {key: rank}."""
    items = sorted(((k, v) for k, v in values.items() if v is not None), key=lambda kv: kv[1], reverse=not ascending)
    return {k: i + 1 for i, (k, _) in enumerate(items)}
