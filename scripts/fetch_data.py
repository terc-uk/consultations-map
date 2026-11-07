#!/usr/bin/env python3
"""
Fetch local plan consultation data from planning.data.gov.uk and write
the two files the map reads:

  data/lpas.geojson  Local planning authority boundaries (simplified),
                     each tagged with the plans that cover it.
  data/plans.json    Every local plan with its timetable events and
                     consultation windows.

Data sources (all Open Government Licence v3.0, Crown copyright):
  local-plan                 one row per local plan
  plan                       newer combined plan dataset (local, minerals, waste...)
  local-plan-timetable       older timetable dataset (retired Jan 2026, still read)
  plan-timetable             current timetable dataset
  local-planning-authority   LPA boundaries, joined on GSS code

Run:  python scripts/fetch_data.py
Env:  PLANNING_FILES (default https://files.planning.data.gov.uk), PLANNING_API
      (default https://www.planning.data.gov.uk), OUT_DIR (default data), FETCH_RETRIES (default 6)
"""

import csv
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests
from shapely import wkt
from shapely.geometry import mapping

API = os.environ.get("PLANNING_API", "https://www.planning.data.gov.uk").rstrip("/")
# Bulk downloads, served from a CDN. Same files as the "Download" links on each dataset page.
FILES = os.environ.get("PLANNING_FILES", "https://files.planning.data.gov.uk").rstrip("/")
OUT_DIR = os.environ.get("OUT_DIR", "data")
PAGE_SIZE = 100
SIMPLIFY_TOLERANCE = 0.0015  # degrees, roughly 100 to 150 m; keeps the file small
COORD_DP = 4
RETRIES = int(os.environ.get("FETCH_RETRIES", 6))  # waits of 5, 10, 20, 40, 60 s between attempts

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; local-plan-consultation-map/1.0; +https://github.com/terc-uk/local-plan-map)",
    "Accept": "application/json, text/csv;q=0.9, */*;q=0.8",
})
csv.field_size_limit(sys.maxsize)  # boundary geometries are long


class NotFound(Exception):
    pass


def get(url, params=None, timeout=180):
    """GET with retries on errors and 5xx/429. Raises NotFound on 404, RuntimeError when it gives up."""
    last = None
    for attempt in range(RETRIES):
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code == 404:
                raise NotFound(url)
            if r.status_code in (429, 500, 502, 503, 504):
                last = f"HTTP {r.status_code}"
            else:
                r.raise_for_status()
                return r
        except NotFound:
            raise
        except requests.RequestException as exc:
            last = str(exc)
        if attempt < RETRIES - 1:
            time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError(f"{last} from {url}")


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def fetch_bulk_csv(dataset):
    r = get(f"{FILES}/dataset/{dataset}.csv", timeout=300)
    text = r.content.decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


def fetch_api(dataset):
    rows, offset = [], 0
    while True:
        params = {"dataset": dataset, "limit": PAGE_SIZE, "offset": offset}
        payload = get(f"{API}/entity.json", params=params).json()
        batch = payload.get("entities", [])
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE
        time.sleep(1)  # be polite


def fetch_dataset(dataset, required=False):
    """Try the bulk CSV download first, then the paged API. Missing optional datasets return []."""
    errors = []
    for name, fn in (("bulk download", fetch_bulk_csv), ("API", fetch_api)):
        try:
            rows = fn(dataset)
            print(f"  {dataset}: {len(rows)} records via {name}")
            return rows
        except NotFound:
            errors.append(f"{name}: not found")
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    msg = f"  {dataset}: could not fetch ({'; '.join(errors)})"
    if required:
        raise SystemExit(msg + "\nStopping without changing the existing data files.")
    print(msg)
    return []


def split_list(value):
    if not value:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [v.strip() for v in str(value).split(";") if v.strip()]


def clean_date(value):
    """Accept YYYY, YYYY-MM or YYYY-MM-DD (with or without time). Return (iso, precision) or (None, None)."""
    if not value:
        return None, None
    s = str(value).strip()[:10]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s, "day"
    if re.fullmatch(r"\d{4}-\d{2}", s):
        return s + "-01", "month"
    if re.fullmatch(r"\d{4}", s):
        return s + "-01-01", "year"
    return None, None


# --------------------------------------------------------------------------
# Event labels
# --------------------------------------------------------------------------

EVENT_LABELS = {
    # 2012 regulations (local-plan-timetable)
    "timetable-published": "Timetable published",
    "reg-18-draft-local-plan-published": "Reg 18 draft plan published",
    "reg-18-public-consultation-start": "Reg 18 consultation opens",
    "reg-18-public-consultation-end": "Reg 18 consultation closes",
    "reg-19-publication-local-plan-published": "Reg 19 publication plan published",
    "reg-19-public-consultation-start": "Reg 19 consultation opens",
    "reg-19-public-consultation-end": "Reg 19 consultation closes",
    "submit-plan-for-examination": "Submitted for examination",
    "estimated-submit-plan-for-examination": "Submission for examination (estimate)",
    "planning-inspectorate-examination-start": "Examination starts",
    "planning-inspectorate-examination-end": "Examination ends",
    "planning-inspectorate-found-sound": "Found sound",
    "inspector-report-published": "Inspector's report published",
    "plan-adopted": "Plan adopted",
    "plan-withdrawn": "Plan withdrawn",
    "plan-revoked": "Plan revoked",
    # new system (plan-timetable)
    "publish-notice-intention-commence": "Notice of intention to commence",
    "scoping-consultation-start": "Scoping consultation opens",
    "scoping-consultation-end": "Scoping consultation closes",
    "gateway-1-self-assessment": "Gateway 1 self-assessment",
    "plan-content-evidence-consultation-start": "Plan content and evidence consultation opens",
    "plan-content-evidence-consultation-end": "Plan content and evidence consultation closes",
    "gateway-2-advice-sought": "Gateway 2 advice sought",
    "gateway-2-advice-published": "Gateway 2 advice published",
    "proposed-plan-consultation-start": "Proposed plan consultation opens",
    "proposed-plan-consultation-end": "Proposed plan consultation closes",
    "gateway-3-advice-sought": "Gateway 3 advice sought",
    "gateway-3-advice-published": "Gateway 3 advice published",
    "gateway-3-further-advice-sought": "Gateway 3 further advice sought",
    "gateway-3-further-advice-published": "Gateway 3 further advice published",
    "examination-submitted": "Submitted for examination",
    "examination-recommendations-published": "Examination recommendations published",
    "main-modification-consultation-start": "Main modifications consultation opens",
    "main-modification-consultation-end": "Main modifications consultation closes",
    "examination-pause-start": "Examination paused",
    "examination-pause-end": "Examination resumed",
    "additional-consultation-start": "Additional consultation opens",
    "additional-consultation-end": "Additional consultation closes",
    "adopted": "Plan adopted",
    "withdrawn": "Plan withdrawn",
    "revoked": "Plan revoked",
}

STAGE_LABELS = {
    "reg-18-public-consultation": "Reg 18 consultation",
    "reg-19-public-consultation": "Reg 19 consultation",
    "scoping-consultation": "Scoping consultation",
    "plan-content-evidence-consultation": "Plan content and evidence consultation",
    "proposed-plan-consultation": "Proposed plan consultation",
    "main-modification-consultation": "Main modifications consultation",
    "additional-consultation": "Additional consultation",
}


def label_for(code):
    return EVENT_LABELS.get(code) or code.replace("-", " ").capitalize()


CONSULT_RE = re.compile(r"^(?P<stage>.*consultation)-(?P<edge>start|end)$")


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def build_events(timetable_rows):
    """Group timetable rows by plan reference into normalised events."""
    by_plan = {}
    for row in timetable_rows:
        plan_ref = row.get("plan") or row.get("local-plan")
        code = row.get("plan-event") or row.get("local-plan-event")
        if not plan_ref or not code:
            continue
        if row.get("end-date"):  # removed from timetable
            continue

        actual, aprec = clean_date(row.get("actual-date") or row.get("start-date"))
        if actual:
            date, precision, kind = actual, aprec, "actual"
        else:
            predicted, pprec = clean_date(
                row.get("predicted-date")
                or row.get("predicted-earliest-date")
                or row.get("event-date")
            )
            if not predicted:
                continue
            # Older local-plan-timetable rows put the only date in event-date; treat past
            # dates as having happened and future ones as predictions.
            today = datetime.now(timezone.utc).date().isoformat()
            if row.get("event-date") and not row.get("predicted-date") and not row.get("predicted-earliest-date") \
                    and not code.startswith("estimated-") and predicted <= today:
                kind = "actual"
            else:
                kind = "predicted"
            date, precision = predicted, pprec

        latest, _ = clean_date(row.get("predicted-latest-date"))
        ev = {
            "code": code,
            "label": label_for(code),
            "date": date,
            "precision": precision,
            "kind": kind,
        }
        if latest and kind == "predicted":
            ev["latest"] = latest
        notes = (row.get("notes") or "").strip()
        if notes:
            ev["notes"] = notes[:200]
        url = row.get("documentation-url") or row.get("document-url")
        if url:
            ev["url"] = url
        by_plan.setdefault(plan_ref, {})
        # de-duplicate the same event code + date from both datasets
        by_plan[plan_ref][(code, date)] = ev
    return {k: sorted(v.values(), key=lambda e: e["date"]) for k, v in by_plan.items()}


def pair_consultations(events):
    """Turn *-consultation-start / *-consultation-end events into windows."""
    starts, ends = {}, {}
    for ev in events:
        m = CONSULT_RE.match(ev["code"])
        if not m:
            continue
        (starts if m["edge"] == "start" else ends).setdefault(m["stage"], []).append(ev)

    windows = []
    for stage, s_list in starts.items():
        e_list = sorted(ends.get(stage, []), key=lambda e: e["date"])
        for s in sorted(s_list, key=lambda e: e["date"]):
            end = next((e for e in e_list if e["date"] >= s["date"]), None)
            if end:
                e_list.remove(end)
            windows.append({
                "stage": stage,
                "label": STAGE_LABELS.get(stage) or stage.replace("-", " ").capitalize(),
                "start": s["date"],
                "end": end["date"] if end else None,
                # an opened consultation with a future closing date is scheduled, not predicted
                "predicted": s["kind"] == "predicted",
                "precision": s["precision"],
                "url": s.get("url") or (end or {}).get("url"),
            })
    # an end with no start (rare): keep it so the date is not lost
    for stage, e_list in ends.items():
        for e in e_list:
            if stage not in starts:
                windows.append({
                    "stage": stage,
                    "label": STAGE_LABELS.get(stage) or stage.replace("-", " ").capitalize(),
                    "start": None, "end": e["date"],
                    "predicted": e["kind"] == "predicted", "precision": e["precision"],
                    "url": e.get("url"),
                })
    return sorted(windows, key=lambda w: w["start"] or w["end"])


def main():
    print(f"Fetching from {FILES} (bulk downloads), falling back to {API}")

    # Plans: merge the older local-plan dataset with the newer plan dataset
    plans = {}
    for row in fetch_dataset("local-plan", required=True) + [
        r for r in fetch_dataset("plan")
        if not r.get("datasets") or "local-plan" in split_list(r.get("datasets"))
    ]:
        ref = row.get("reference")
        if not ref:
            continue
        p = plans.setdefault(ref, {"reference": ref})
        for key, src in [
            ("name", "name"), ("description", "description"),
            ("documentation_url", "documentation-url"), ("document_url", "document-url"),
            ("adopted", "start-date"), ("ended", "end-date"),
            ("period_start", "period-start-date"), ("period_end", "period-end-date"),
            ("required_housing", "required-housing"), ("process", "local-plan-process"),
        ]:
            if row.get(src) and not p.get(key):
                p[key] = row[src]
        p.setdefault("lpas", [])
        for code in split_list(row.get("local-planning-authorities")):
            if code not in p["lpas"]:
                p["lpas"].append(code)
        if row.get("adopted-date") and not p.get("adopted"):
            p["adopted"] = row["adopted-date"]

    # Timetables: read both the retired and the current dataset
    timetable_rows = fetch_dataset("local-plan-timetable") + fetch_dataset("plan-timetable")
    if not timetable_rows:
        raise SystemExit("No timetable data could be fetched.\nStopping without changing the existing data files.")
    events_by_plan = build_events(timetable_rows)

    for ref, p in plans.items():
        evs = events_by_plan.get(ref, [])
        p["events"] = evs
        p["consultations"] = pair_consultations(evs)
        if not p.get("name"):
            p["name"] = ref.replace("-", " ").title()

    orphan_refs = sorted(set(events_by_plan) - set(plans))
    if orphan_refs:
        print(f"  note: {len(orphan_refs)} timetable plan references have no matching plan record")

    # Boundaries
    lpa_rows = fetch_dataset("local-planning-authority", required=True)
    plans_by_lpa = {}
    for ref, p in plans.items():
        if p.get("ended"):
            continue
        for code in p["lpas"]:
            plans_by_lpa.setdefault(code, []).append(ref)

    features = []
    for row in lpa_rows:
        code = row.get("reference")
        geom_wkt = row.get("geometry")
        if not code or not geom_wkt or row.get("end-date"):
            continue
        try:
            geom = wkt.loads(geom_wkt).simplify(SIMPLIFY_TOLERANCE, preserve_topology=True)
        except Exception as exc:  # malformed geometry
            print(f"  skipping {code}: {exc}")
            continue
        gj = mapping(geom)
        gj = json.loads(json.dumps(gj), parse_float=lambda x: round(float(x), COORD_DP))
        features.append({
            "type": "Feature",
            "properties": {
                "code": code,
                "name": row.get("name") or code,
                "plans": plans_by_lpa.get(code, []),
            },
            "geometry": gj,
        })

    if not plans or not features:
        raise SystemExit("No plans or no boundaries were built.\nStopping without changing the existing data files.")

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(OUT_DIR, exist_ok=True)
    outputs = {
        "lpas.geojson": {"type": "FeatureCollection", "features": features},
        "plans.json": {
            "generated": generated,
            "source": "planning.data.gov.uk",
            "counts": {
                "plans": len(plans),
                "plans_with_timetable": sum(1 for p in plans.values() if p["events"]),
                "consultation_windows": sum(len(p["consultations"]) for p in plans.values()),
                "lpas": len(features),
            },
            "plans": plans,
        },
    }
    # write to temporary files first so a crash never leaves half-written data
    for name, obj in outputs.items():
        tmp = os.path.join(OUT_DIR, name + ".tmp")
        with open(tmp, "w") as f:
            json.dump(obj, f, separators=(",", ":"))
    for name in outputs:
        os.replace(os.path.join(OUT_DIR, name + ".tmp"), os.path.join(OUT_DIR, name))

    print(f"Wrote {len(features)} boundaries and {len(plans)} plans to {OUT_DIR}/")

if __name__ == "__main__":
    main()
