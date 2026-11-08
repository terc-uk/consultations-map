#!/usr/bin/env python3
"""
Fetch national consultations (UK, England, Scotland, Wales, Northern Ireland)
and write data/national.json for the "National" view of the map.

Sources:
  GOV.UK search API           UK Government consultations and calls for evidence
                              (England-only and UK-wide; nations from the content API)
  consult.gov.scot            Scottish Government (Citizen Space API)
  yourviews.parliament.scot   Scottish Parliament committees (Citizen Space API)
  gov.wales/consultations     Welsh Government (listing and consultation pages)
  northernireland.gov.uk      Northern Ireland Executive departments (listing and pages)
  committees-api.parliament.uk  UK Parliament committee calls for evidence

Each consultation gets an id: its web address without "https://" and "www."
(for example gov.uk/government/consultations/some-consultation). The tERC flags in
data/static/national-terc.csv refer to consultations by this id.

Consultations already in data/national.json are kept, so a closed consultation stays
listed for a year after it closes (longer if tERC has flagged it), and a source that
fails on one run does not empty the list.

Run:  python scripts/fetch_national.py
Env:  OUT_DIR (default data), FETCH_RETRIES (default 4)
"""

import csv
import html
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone

import requests

OUT_DIR = os.environ.get("OUT_DIR", "data")
OUT_FILE = os.path.join(OUT_DIR, "national.json")
FLAGS_FILE = os.path.join(OUT_DIR, "static", "national-terc.csv")
RETRIES = int(os.environ.get("FETCH_RETRIES", 3))

TODAY = datetime.now(timezone.utc).date()
FETCH_CLOSED_DAYS = 120   # how far back to look for recently closed consultations
KEEP_CLOSED_DAYS = 400    # how long to keep a closed consultation in the file
SUMMARY_LEN = 240
PAUSE = 0.3               # seconds between page fetches, to be polite

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; local-plan-consultation-map/1.0; +https://github.com/terc-uk/local-plan-map)",
})


def get(url, params=None, accept="application/json", timeout=30):
    last = None
    for attempt in range(RETRIES):
        try:
            t0 = time.time()
            r = session.get(url, params=params, timeout=timeout, headers={"Accept": accept})
            if time.time() - t0 > 8:
                print(f"    slow ({time.time() - t0:.0f} s): {r.url}")
            if r.status_code in (429, 500, 502, 503, 504):
                last = f"HTTP {r.status_code}"
            else:
                r.raise_for_status()
                return r
        except requests.HTTPError:
            raise
        except requests.RequestException as exc:
            last = str(exc)
        if attempt < RETRIES - 1:
            time.sleep(min(30, 3 * 2 ** attempt))
    raise RuntimeError(f"{last} from {url}")


def get_html(url, params=None):
    time.sleep(PAUSE)
    return get(url, params=params, accept="text/html").text


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def make_id(url):
    return re.sub(r"^https?://(www\.)?", "", url or "").rstrip("/")


def strip_tags(s):
    s = re.sub(r"<(script|style)\b.*?</\1>", " ", s or "", flags=re.S | re.I)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s).strip()


def short(s, n=SUMMARY_LEN):
    s = strip_tags(s)
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def iso_date(value):
    """Accept 2026-10-20..., 2026/10/20 or '20 October 2026[, 9.00 am]'. Return YYYY-MM-DD or None."""
    if not value:
        return None
    s = str(value).strip()
    m = re.match(r"(\d{4})[-/](\d{2})[-/](\d{2})", s)
    if m:
        return "-".join(m.groups())
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})", s)
    if m:
        for fmt in ("%d %B %Y", "%d %b %Y"):
            try:
                return datetime.strptime(" ".join(m.groups()), fmt).date().isoformat()
            except ValueError:
                pass
    return None


def kind_from(text):
    t = (text or "").lower()
    if "evidence" in t:
        return "Call for evidence"
    if "survey" in t:
        return "Survey"
    if "engagement" in t:
        return "Engagement"
    return "Consultation"


def item(**kw):
    kw.setdefault("nations", [])
    kw.setdefault("org", "")
    kw.setdefault("summary", "")
    kw.setdefault("kind", "Consultation")
    kw.setdefault("state", None)  # open / forthcoming / closed, as the source reports it
    kw["id"] = kw.get("id") or make_id(kw["url"])
    return kw


# --------------------------------------------------------------------------
# GOV.UK
# --------------------------------------------------------------------------

GOVUK_SEARCH = "https://www.gov.uk/api/search.json"
GOVUK_FIELDS = "title,link,description,public_timestamp,organisations,start_date,end_date,content_store_document_type"
NATION_NAMES = {"england": "England", "wales": "Wales", "scotland": "Scotland", "northern_ireland": "Northern Ireland"}


def govuk_search(doc_type, since=None):
    rows, start = [], 0
    while True:
        params = {"filter_content_store_document_type": doc_type, "count": 500, "start": start,
                  "fields": GOVUK_FIELDS, "order": "-public_timestamp"}
        if since:
            params["filter_end_date"] = f"from:{since}"
        try:
            batch = get(GOVUK_SEARCH, params=params).json().get("results", [])
        except requests.HTTPError:
            if not since:
                raise
            # date filter not accepted: fall back to newest first and filter here
            params.pop("filter_end_date")
            batch = [r for r in get(GOVUK_SEARCH, params=params).json().get("results", [])
                     if (r.get("end_date") or "")[:10] >= since]
            rows.extend(batch)
            return rows
        rows.extend(batch)
        if len(batch) < 500:
            return rows
        start += 500
        time.sleep(PAUSE)


def govuk_nations(link, previous):
    """Nations a GOV.UK consultation applies to. Cached in previous records."""
    old = previous.get(make_id("https://www.gov.uk" + link))
    if old and old.get("nations"):
        return old["nations"]
    try:
        time.sleep(0.15)
        det = get("https://www.gov.uk/api/content" + link).json().get("details", {})
    except Exception:
        return ["UK"]
    na = det.get("national_applicability") or {}
    applies = [NATION_NAMES[k] for k in NATION_NAMES if na.get(k, {}).get("applicable")]
    return ["UK"] if not na or len(applies) == 4 else applies


def fetch_govuk(previous, since):
    out = []
    plan = [("open_consultation", None, "open"), ("open_call_for_evidence", None, "open"),
            ("closed_consultation", since, "closed"), ("closed_call_for_evidence", since, "closed"),
            ("consultation_outcome", since, "closed"), ("call_for_evidence_outcome", since, "closed")]
    for doc_type, s, state in plan:
        rows = govuk_search(doc_type, s)
        print(f"    {doc_type}: {len(rows)}")
        for r in rows:
            link = r.get("link") or ""
            if not link.startswith("/"):
                continue
            orgs = [o.get("title") for o in r.get("organisations") or [] if isinstance(o, dict) and o.get("title")]
            out.append(item(
                url="https://www.gov.uk" + link,
                title=strip_tags(r.get("title")),
                org=", ".join(orgs[:3]),
                summary=short(r.get("description")),
                kind="Call for evidence" if "call_for_evidence" in doc_type else "Consultation",
                start=iso_date(r.get("start_date")), end=iso_date(r.get("end_date")),
                state=state, source="govuk",
                nations=govuk_nations(link, previous),
            ))
    return out


# --------------------------------------------------------------------------
# Citizen Space (Scottish Government, Scottish Parliament)
# --------------------------------------------------------------------------

def fetch_citizen_space(base, source, nations, since, org_prefix=""):
    out = []
    since_uk = datetime.strptime(since, "%Y-%m-%d").strftime("%d/%m/%Y")
    for st, extra in (("open", {}), ("forthcoming", {}), ("closed", {"dk": "cl", "fd": since_uk})):
        rows = get(f"{base}/api/2.4/json_search_results", params={"st": st, "fields": "extended", **extra}).json()
        print(f"    {st}: {len(rows)}")
        for r in rows:
            if r.get("visibility") not in (None, "public"):
                continue
            ws = r.get("workspace_title") or r.get("department") or ""
            out.append(item(
                url=r.get("url", "").replace("/consult_view", ""),
                title=strip_tags(r.get("title")),
                org=(org_prefix + ws) if org_prefix else ws,
                summary=short(r.get("overview")),
                kind=kind_from(r.get("type_string") or r.get("activity_type")),
                start=iso_date(r.get("startdate")), end=iso_date(r.get("enddate")),
                state=r.get("status") or st, source=source, nations=nations,
            ))
        time.sleep(PAUSE)
    return out


# --------------------------------------------------------------------------
# Welsh Government
# --------------------------------------------------------------------------

WALES = "https://www.gov.wales"
WALES_ITEM_RE = re.compile(
    r'<li class="index-list__item">.*?<a href="(?P<href>[^"]+)".*?>(?P<title>.*?)</a>.*?'
    r'<time datetime="(?P<published>[^"]+)".*?<span class="index-list__type">(?P<type>[^<]*)</span>'
    r'(?P<rest>.*?)</li>', re.S)


def wales_listing(status, stop_before=None, max_pages=60):
    rows = []
    for page in range(max_pages):
        text = get_html(f"{WALES}/consultations", params={"field_consultation_status": status, "page": page})
        found = [m.groupdict() for m in WALES_ITEM_RE.finditer(text)]
        rows.extend(found)
        if not found or 'rel="next"' not in text:
            break
        if stop_before and min(f["published"][:10] for f in found) < stop_before:
            break
    return rows


def wales_details(url):
    text = get_html(url)
    start = end = None
    m = re.search(r"Consultation ends:</div>\s*<div[^>]*>(.*?)</div>", text, re.S)
    if m:
        end = iso_date(strip_tags(m.group(1)))
    m = re.search(r"Consultation launched:</div>.*?datetime=\"([^\"]+)\"", text, re.S)
    if m:
        start = iso_date(m.group(1))
    m = re.search(r"Consultation period:</div>\s*<div[^>]*>(.*?)</div>", text, re.S)
    if m:
        parts = re.findall(r"<strong>(.*?)</strong>", m.group(1), re.S)
        if len(parts) >= 2:
            start, end = iso_date(strip_tags(parts[0])) or start, iso_date(strip_tags(parts[1])) or end
    m = re.search(r'<meta name="description" content="([^"]*)"', text)
    return start, end, (html.unescape(m.group(1)) if m else "")


def fetch_wales(previous, since):
    rows = wales_listing("1")  # open
    print(f"    open: {len(rows)}")
    closed = wales_listing("2", stop_before=since)
    print(f"    closed (recent pages): {len(closed)}")
    out = []
    for row, state in [(r, "open") for r in rows] + [(r, "closed") for r in closed]:
        url = WALES + row["href"] if row["href"].startswith("/") else row["href"]
        old = previous.get(make_id(url))
        if old and state == "closed" and old.get("end"):
            start, end, summary = old.get("start"), old.get("end"), old.get("summary", "")
        else:
            try:
                start, end, summary = wales_details(url)
            except Exception as exc:
                print(f"    could not read {url}: {exc}")
                start, end, summary = (old or {}).get("start"), (old or {}).get("end"), (old or {}).get("summary", "")
        if state == "closed" and end and end < since:
            continue
        org = re.findall(r'class="from-area">(.*?)</span>', row["rest"])
        out.append(item(
            url=url, title=strip_tags(row["title"]),
            org=", ".join(strip_tags(o) for o in org[1:]) or "Welsh Government",
            summary=short(summary), kind=kind_from(row["type"]),
            start=start, end=end, state=state, source="wales", nations=["Wales"],
        ))
    return out


# --------------------------------------------------------------------------
# Northern Ireland Executive
# --------------------------------------------------------------------------

NI = "https://www.northernireland.gov.uk"
NI_DETAIL_LIMIT = 60   # consultation pages read per run; the rest are read on later runs
NI_PAUSE = 1.5         # the departmental sites rate-limit quickly
NI_CARD_RE = re.compile(
    r'<a class="card[^"]*" href="(?P<href>[^"]+)">\s*<h3 class="card__title">(?P<title>.*?)</h3>'
    r'(?P<body>.*?)</a>', re.S)


class RateLimited(Exception):
    pass


NI_DEPT_SITES = [  # department name keyword -> website, for feed items whose link does not resolve
    ("infrastructure", "infrastructure-ni.gov.uk"), ("justice", "justice-ni.gov.uk"),
    ("health", "health-ni.gov.uk"), ("communities", "communities-ni.gov.uk"),
    ("finance", "finance-ni.gov.uk"), ("economy", "economy-ni.gov.uk"),
    ("education", "education-ni.gov.uk"), ("agriculture", "daera-ni.gov.uk"), ("daera", "daera-ni.gov.uk"),
    ("executive office", "executiveoffice-ni.gov.uk"),
]


def ni_dept_url(dept, slug):
    d = (dept or "").lower()
    for key, site in NI_DEPT_SITES:
        if key in d:
            return f"https://www.{site}/consultations/{slug}"
    return f"{NI}/consultations/{slug}"


def ni_slug(url):
    return url.rstrip("/").rsplit("/", 1)[-1]


def ni_rss():
    """The Executive's consultations feed: the latest 100 from all departments."""
    text = get(f"{NI}/consultations/feed/nigov", accept="application/rss+xml, application/xml").text
    rows = []
    for block in re.findall(r"<item>(.*?)</item>", text, re.S):
        def tag(name):
            m = re.search(rf"<{name}>(.*?)</{name}>", block, re.S)
            return html.unescape(m.group(1)).strip() if m else ""
        rows.append({"href": tag("link"), "title": tag("title"), "summary": tag("description"),
                     "dept": tag("dc:creator"), "published": iso_date(tag("pubDate")) or "", "status": ""})
    return rows


def ni_listing_page():
    """The first page of the listing: newest 20, with department web addresses and status."""
    text = get_html(f"{NI}/consultations")
    rows = []
    for m in NI_CARD_RE.finditer(text):
        body = m.group("body")
        pub = re.search(r'datetime="([^"]+)"', body)
        dept = re.search(r'dept-name">(.*?)</span>', body, re.S)
        status = re.search(r'consultation-status">(.*?)</span>', body, re.S)
        summ = re.search(r'card__content[^>]*>(.*?)</p>', body, re.S)
        rows.append({
            "href": m.group("href"), "title": m.group("title"),
            "published": pub.group(1)[:10] if pub else "",
            "dept": strip_tags(dept.group(1)) if dept else "",
            "status": strip_tags(status.group(1)).lower() if status else "",
            "summary": summ.group(1) if summ else "",
        })
    return rows


def ni_details(url):
    """Opening and closing dates, and status, from a consultation page."""
    time.sleep(NI_PAUSE)
    try:
        text = get(url, accept="text/html").text
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 429:
            raise RateLimited(url)
        raise
    except RuntimeError as exc:
        if "429" in str(exc):
            raise RateLimited(url)
        raise
    start = end = None
    block = re.search(r'class="consultation-dates">(.*?)</div>', text, re.S)
    for label, value in re.findall(r'<strong class="label">(.*?)</strong>([^<]*)', block.group(1) if block else ""):
        label, value = label.lower(), html.unescape(value)
        # closed pages: "Consultation opened 13 August 2026, 9.00 am and closed 21 September 2026, 5.00 pm"
        opened = re.search(r"opened\s+(?:on\s+)?(\d{1,2}\w*\s+\w+\s+\d{4})", value)
        closed = re.search(r"clos(?:ed|es|ing)\s+(?:on\s+)?(\d{1,2}\w*\s+\w+\s+\d{4})", value)
        if opened or closed:
            start = iso_date(opened.group(1)) if opened else start
            end = iso_date(closed.group(1)) if closed else end
        elif "open" in label:
            start = iso_date(value)
        elif "clos" in label:
            end = iso_date(value)
    if not end:  # older pages: "Consultation opened on 14 January 2019. Closing date 11 February 2019."
        m = re.search(r"Consultation opened on ([^.<]+)\.\s*Closing date ([^.<]+)", text)
        if m:
            start, end = iso_date(m.group(1)), iso_date(m.group(2))
    prefix = re.search(r'page-title__prefix">(.*?)<', text)
    return start, end, strip_tags(prefix.group(1)).lower() if prefix else ""


def ni_state(status):
    if "open" in status:
        return "open"
    if "pending" in status:
        return "forthcoming"
    if "clos" in status:
        return "closed"
    return None


def fetch_ni(previous, since):
    rows = {}
    for r in ni_rss():
        if r["href"]:
            rows[ni_slug(r["href"])] = r
    print(f"    feed: {len(rows)}")
    try:
        for r in ni_listing_page():  # adds department web addresses and status for the newest
            rows[ni_slug(r["href"])] = {**rows.get(ni_slug(r["href"]), {}), **{k: v for k, v in r.items() if v}}
    except Exception as exc:
        print(f"    listing page not read: {exc}")
    out, reads, limited = [], 0, False
    old_cut = (TODAY - timedelta(days=90)).isoformat()
    for slug, r in rows.items():
        cid = f"northernireland.gov.uk/consultations/{slug}"
        old = previous.get(cid) or {}
        if "northernireland.gov.uk" not in r["href"]:
            url = r["href"]
        elif old.get("url") and "northernireland.gov.uk" not in old["url"]:
            url = old["url"]
        else:
            url = ni_dept_url(r.get("dept"), slug)
        start, end, state = old.get("start"), old.get("end"), ni_state(r.get("status", "")) or old.get("state")
        need = not old or (not old.get("end") and old.get("state") != "closed") or state == "forthcoming"
        if need and not limited and reads < NI_DETAIL_LIMIT:
            try:
                reads += 1
                s2, e2, prefix = ni_details(url)
                start, end = s2 or start, e2 or end
                state = ni_state(r.get("status", "")) or ni_state(prefix) or state
            except RateLimited:
                limited = True
                print(f"    rate limited after {reads} pages; the rest will be read on a later run")
            except Exception as exc:
                print(f"    could not read {url}: {exc}")
        if not state:
            state = "closed" if (end and end < TODAY.isoformat()) or r["published"] < old_cut else None
        if state == "closed" and (end or r["published"]) < since:
            continue
        out.append(item(
            id=cid, url=url, title=strip_tags(r["title"]), org=r["dept"], summary=short(r["summary"]),
            kind=kind_from(r["title"]), start=start or (r["published"] if state != "forthcoming" else None),
            end=end, published=r["published"], state=state, source="ni", nations=["Northern Ireland"],
        ))
    print(f"    consultation pages read: {reads}")
    return out


# --------------------------------------------------------------------------
# UK Parliament committees
# --------------------------------------------------------------------------

UKPARL_API = "https://committees-api.parliament.uk/api"


def ukparl_committee(business_id, previous_by_business):
    if business_id in previous_by_business:
        return previous_by_business[business_id]
    try:
        time.sleep(0.15)
        rows = get(f"{UKPARL_API}/Committees", params={"CommitteeBusinessId": business_id, "Take": 10}).json().get("items", [])
    except Exception:
        return ""
    names = []
    for c in rows:
        if c.get("name"):
            house = c.get("house")
            names.append(f"{c['name']} ({house})" if house and house != "Joint" else c["name"])
    return ", ".join(names)


def fetch_ukparl(previous, since):
    prev_by_business = {}
    for p in previous.values():
        if p.get("source") == "ukparl" and p.get("org") and p["org"] != "UK Parliament committee":
            prev_by_business[p.get("business_id")] = p["org"]
    out, skip = [], 0
    while True:
        payload = get(f"{UKPARL_API}/CommitteeBusiness",
                      params={"CurrentlyAcceptingEvidence": "true", "Take": 100, "Skip": skip}).json()
        batch = payload.get("items", [])
        for b in batch:
            periods = [p for p in b.get("openSubmissionPeriods") or [] if p.get("submissionType") == "WrittenEvidence"]
            org = ukparl_committee(b["id"], prev_by_business)
            for p in periods:
                url = f"https://committees.parliament.uk/work/{b['id']}/"
                if len(periods) > 1:
                    url += f"#{p['id']}"
                out.append(item(
                    url=url, title=strip_tags(b.get("title")), org=org or "UK Parliament committee",
                    summary=short(p.get("statusMessage")), kind="Call for evidence",
                    start=iso_date(p.get("startDate")), end=iso_date(p.get("endDate")),
                    state="open", source="ukparl", nations=["UK"], business_id=b["id"],
                ))
        skip += len(batch)
        if not batch or skip >= payload.get("totalResults", 0):
            break
        time.sleep(PAUSE)
    print(f"    open calls for evidence: {len(out)}")
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

SOURCES = [
    ("govuk", "UK Government (GOV.UK)", fetch_govuk),
    ("scotgov", "Scottish Government", lambda prev, since: fetch_citizen_space(
        "https://consult.gov.scot", "scotgov", ["Scotland"], since)),
    ("scotparl", "Scottish Parliament committees", lambda prev, since: fetch_citizen_space(
        "https://yourviews.parliament.scot", "scotparl", ["Scotland"], since, org_prefix="Scottish Parliament: ")),
    ("wales", "Welsh Government", fetch_wales),
    ("ni", "Northern Ireland Executive", fetch_ni),
    ("ukparl", "UK Parliament committees", fetch_ukparl),
]


def load_previous():
    try:
        with open(OUT_FILE) as f:
            return {c["id"]: c for c in json.load(f).get("consultations", [])}
    except (OSError, ValueError):
        return {}


def load_flagged():
    try:
        with open(FLAGS_FILE, newline="", encoding="utf-8-sig") as f:
            return {make_id(r.get("id", "")) for r in csv.DictReader(f) if r.get("id")}
    except OSError:
        return set()


def main():
    sys.stdout.reconfigure(line_buffering=True)
    previous = load_previous()
    flagged = load_flagged()
    since = (TODAY - timedelta(days=FETCH_CLOSED_DAYS)).isoformat()
    merged, status = {}, {}

    for key, label, fn in SOURCES:
        print(f"  {label}")
        t0 = time.time()
        try:
            rows = fn(previous, since)
            print(f"    {len(rows)} records in {time.time() - t0:.0f} s")
            status[key] = {"label": label, "ok": True, "count": len(rows)}
        except Exception as exc:
            print(f"    failed: {exc}")
            status[key] = {"label": label, "ok": False, "error": str(exc)[:200]}
            rows = []
        for r in rows:
            old = previous.get(r["id"]) or merged.get(r["id"]) or {}
            if old.get("first_seen"):
                r["first_seen"] = old["first_seen"]
            elif not previous:
                # first ever run: use the opening date, so only recent ones are tagged "new"
                r["first_seen"] = min(r.get("start") or r.get("published") or TODAY.isoformat(), TODAY.isoformat())
            else:
                r["first_seen"] = TODAY.isoformat()
            if not r.get("end") and old.get("end"):
                r["end"] = old["end"]
            if not r.get("start") and old.get("start"):
                r["start"] = old["start"]
            merged[r["id"]] = r

    if not any(s["ok"] for s in status.values()):
        raise SystemExit("No source could be fetched.\nStopping without changing the existing data file.")

    # keep earlier records that this run did not return (closed since, or source failed)
    keep_after = (TODAY - timedelta(days=KEEP_CLOSED_DAYS)).isoformat()
    for cid, old in previous.items():
        if cid in merged:
            continue
        last = old.get("end") or old.get("published") or old.get("first_seen") or ""
        if cid in flagged or last >= keep_after:
            if old.get("state") == "open" and old.get("end") and old["end"] < TODAY.isoformat():
                old["state"] = "closed"
            elif old.get("state") == "open" and not old.get("end") and status.get(old.get("source"), {}).get("ok"):
                # no longer listed as open by a source that worked, so it has closed
                old["state"] = "closed"
            merged[cid] = old

    items = sorted(merged.values(), key=lambda c: (c.get("end") or "9999", c["title"]))
    for c in items:
        for k in [k for k, v in c.items() if v in (None, "", [])]:
            del c[k]

    os.makedirs(OUT_DIR, exist_ok=True)
    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": status,
        "count": len(items),
        "consultations": items,
    }
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, OUT_FILE)
    print(f"Wrote {len(items)} national consultations to {OUT_FILE}")
    failed = [s["label"] for s in status.values() if not s["ok"]]
    if failed:
        print("Sources that failed this run (earlier records kept): " + ", ".join(failed))


if __name__ == "__main__":
    main()
