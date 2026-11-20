#!/usr/bin/env python3
"""Nightly regulatory-data sync for the Cream Biomed site.

Downloads public registers and writes small JSON files under data/ that the
static site reads:
  data/eu/mf/<shard>.json      EU-registered manufacturers (EUDAMED), sharded by name
  data/partners/<CC>.json      importers / distributors / authorised reps by country
  data/partners/index.json     countries with partner data
  data/meta.json               last update + counts + sources

Only organisation-level data is kept. Personal names (e.g. PRRC or technician
names), personal e-mails and phone numbers are never written.
"""
import json, os, re, sys, time, unicodedata, urllib.parse, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

OUT = "data"
EU = "https://api.datalake.sante.service.ec.europa.eu/eudamed/"
UA = {"User-Agent": "CreamBiomed-sync/1.0 (+https://ooppportune.github.io/creambiomed/)"}
LEGAL = set("co ltd limited inc incorporated llc gmbh ag sa sas srl spa bv nv plc corp corporation company kg ab oy as aps sl sarl pty pvt private kk se mbh the".split())
NOWEB = {"", "none", "n/a", "na", "no website", "nowebsite", "under construction", "-", "null"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower().replace("&", " and ")
    toks = [t for t in re.sub(r"[^a-z0-9]+", " ", s).split() if t not in LEGAL]
    return " ".join(toks)


def shard(k):
    return k[0] if k and k[0].isalpha() else "0"


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:  # network hiccup
            err = e
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"failed {url}: {err}")


def web(w):
    w = (w or "").strip()
    if w.lower() in NOWEB or " " in w or "." not in w:
        return ""
    return w if w.startswith("http") else "https://" + w


def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------- EUDAMED
def sync_eudamed(partners):
    url = EU + "actors?format=json&api-version=v1.0"
    seen, pages = {}, 0
    while url:
        j = get(url)
        if not j:
            break
        for a in j.get("value", []):
            aid = a.get("ACTOR_ID")
            if not aid or aid in seen or (a.get("STATUS") or "").lower() != "active":
                continue
            seen[aid] = {
                "id": aid, "name": (a.get("NAME") or "").strip(), "type": a.get("ACTOR_TYPE") or "",
                "cc": (a.get("ACT_ADDR_COUNTRY_CODE") or a.get("ACT_COUNTRY_ISO2_CODE") or "").upper(),
                "city": (a.get("ACT_ADDR_CITY_NAME") or "").strip(), "web": web(a.get("ACT_WEBSITE")),
            }
        nxt = j.get("nextLink")
        url = urllib.parse.urljoin(EU, nxt) if nxt else None
        pages += 1
        if pages % 10 == 0:
            print(f"  EUDAMED page {pages}, {len(seen)} active actors", flush=True)
        time.sleep(0.3)
    print(f"EUDAMED: {len(seen)} active actors from {pages} pages")
    if len(seen) < 1000:
        raise RuntimeError("EUDAMED returned too few actors; keeping previous data")

    shards = defaultdict(list)
    n_mf = 0
    for a in seen.values():
        if a["type"] == "Manufacturer":
            k = norm(a["name"])
            if k:
                shards[shard(k)].append([a["id"], a["name"], a["cc"], a["city"], a["web"]])
                n_mf += 1
        elif a["type"] in ("Importer", "Authorised Representative") and a["cc"]:
            role = "EU importer" if a["type"] == "Importer" else "EU authorised representative"
            partners[a["cc"]].append([a["name"], role, a["city"], a["web"], "EUDAMED", a["id"]])
    for s, rows in shards.items():
        rows.sort(key=lambda r: r[1].lower())
        write(f"{OUT}/eu/mf/{s}.json", {"rows": rows})
    return {"eu_manufacturers": n_mf}


# ---------------------------------------------------------------- Rwanda FDA
RW_URLS = [
    "https://rwandafda.gov.rw/monitoring-tool/documents-management/uploads/1/Licensed-Premises/1781787882_8.%20%20LIST%20OF%20LICENSED%20WHOLESALE%20OF%20MEDICAL%20DEVICES-MAY%2020261.pdf",
    "https://rwandafda.gov.rw/monitoring-tool/documents-management/uploads/1/Licensed-Premises/1772531515_8.%20%20eLIST%20OF%20LICENSED%20WHOLESALE%20OF%20MEDICAL%20DEVICES-JANUARY%202026.pdf",
]


def parse_rw_text(text):
    """Fallback parser for Rwanda FDA list PDFs when table extraction fails.
    Keeps only the company name, district/sector and licence expiry (no personal names)."""
    rows = []
    t = re.sub(r"[ \t]+", " ", text)
    pat = re.compile(r"(?:^|\n)\s*(\d{1,3})\.\s+(.+?)\s+MEDICAL\s*\n?\s*(?:DEVICES|PRODUCTS)(.*?)(\d{2}/\d{2}/\d{4})", re.S)
    for m in pat.finditer(t):
        name = re.sub(r"\s+", " ", m.group(2)).strip(" ,")
        mid = re.sub(r"\s+", " ", m.group(3))
        loc = re.search(r"(KIGALI CITY|NORTHERN|SOUTHERN|EASTERN|WESTERN)\s+([A-Z]+)\s+([A-Z]+)", mid)
        place = f"{loc.group(2)}, {loc.group(3)}".title() if loc else ""
        if 2 < len(name) < 120:
            rows.append([name.title(), "Licensed medical device wholesaler", place, "", "Rwanda FDA", "Licence valid to " + m.group(4)])
    return rows


def sync_rwanda(partners):
    try:
        import io, pdfplumber
    except ImportError:
        return {"rw_error": "pdfplumber missing"}
    errors = []
    for url in RW_URLS:
        try:
            req = urllib.request.Request(url, headers={**UA, "Accept": "application/pdf,*/*"})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            pdf = pdfplumber.open(io.BytesIO(data))
        except Exception as e:
            errors.append(f"fetch: {e}")
            continue
        rows, text = [], []
        for page in pdf.pages:
            text.append(page.extract_text() or "")
            for table in page.extract_tables() or []:
                for row in table:
                    cells = [re.sub(r"\s+", " ", (c or "")).strip() for c in row]
                    if not cells or not re.match(r"^\d+\.?$", cells[0] or ""):
                        continue
                    name = cells[1] if len(cells) > 1 else ""
                    expiry = next((c for c in reversed(cells) if re.match(r"\d{2}/\d{2}/\d{4}$", c)), "")
                    place = ", ".join(c for c in cells[6:8] if c and not re.match(r"\d{2}/\d{2}/\d{4}$", c)) if len(cells) > 7 else ""
                    if name:
                        rows.append([name.title(), "Licensed medical device wholesaler", place.title(), "", "Rwanda FDA", "Licence valid to " + expiry if expiry else ""])
        if not rows:
            rows = parse_rw_text("\n".join(text))
        if rows:
            seen, uniq = set(), []
            for r in rows:
                if r[0].lower() not in seen:
                    seen.add(r[0].lower()); uniq.append(r)
            partners["RW"].extend(uniq)
            print(f"Rwanda: {len(uniq)} licensed medical device wholesalers")
            return {"rw_wholesalers": len(uniq)}
        errors.append(f"parsed 0 rows from {len(data)} bytes")
    print("Rwanda failed:", errors)
    return {"rw_error": "; ".join(errors)[:300]}


def main():
    partners = defaultdict(list)
    meta = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "sources": {}}
    for fn in (sync_eudamed, sync_rwanda):
        try:
            meta["sources"].update(fn(partners) or {})
        except Exception as e:
            print(f"{fn.__name__} failed: {e}", file=sys.stderr)
    if partners:
        idx = {}
        for cc, rows in partners.items():
            rows.sort(key=lambda r: (r[1], r[0].lower()))
            write(f"{OUT}/partners/{cc}.json", {"cc": cc, "rows": rows})
            idx[cc] = len(rows)
        old = {}
        try:
            old = json.load(open(f"{OUT}/partners/index.json")).get("countries", {})
        except Exception:
            pass
        old.update(idx)
        write(f"{OUT}/partners/index.json", {"countries": old})
        meta["partner_countries"] = len(old)
    write(f"{OUT}/meta.json", meta)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
