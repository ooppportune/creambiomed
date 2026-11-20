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
import json, os, re, sys, time, unicodedata, urllib.parse, urllib.request, urllib.error
from html import unescape
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



# ---------------------------------------------------------------- Manufacturer catalogues
# Reads manufacturers' public sitemaps and product pages (respecting robots.txt) and keeps,
# per product page: URL, title, the page's own preview image URL (not copied; displayed from
# the manufacturer's server with attribution), and a short description excerpt.
CATALOG_DOMAINS = ["abbott.com", "agfa.com", "ambu.com", "baxter.com", "bbraun.com", "bd.com", "beckmancoulter.com", "belimed.com", "bionetus.com", "blt.com.cn", "cardinalhealth.com", "carestream.com", "chison.com", "comen.com", "contecmed.com", "dentsplysirona.com", "diagnostics.roche.com", "draeger.com", "edan.com", "esaote.com", "fphcare.com", "freseniusmedicalcare.com", "fujifilm.com", "gehealthcare.com", "getinge.com", "global.medical.canon", "haag-streit.com", "hamilton-medical.com", "healthcare.nikon.com", "heine.com", "hillrom.com", "hologic.com", "icumedical.com", "intersurgical.com", "invacare.com", "karlstorz.com", "keelerglobal.com", "laerdal.com", "leica-microsystems.com", "masimo.com", "medtronic.com", "midmark.com", "mindray.com", "natus.com", "nihonkohden.com", "nipro-group.com", "olympus-global.com", "penlon.com", "philips.com", "planmeca.com", "resmed.com", "samsunghealthcare.com", "schiller.ch", "siemens-healthineers.com", "siui.com", "sonoscape.com", "spacelabshealthcare.com", "steris.com", "stryker.com", "sysmex.com", "topconhealthcare.com", "tuttnauer.com", "vyaire.com", "wdm.com.cn", "yuwell.com", "zeiss.com", "zoll.com"]
BOT_UA = "CreamBiomedBot/1.0 (+https://creambiomedscientific.com/#/about)"
PER_RUN = 250          # new or refreshed pages per domain per run
REFRESH_DAYS = 30
NOT_PRODUCT = re.compile(r"(^|/|-)(news|blogs?|press|events?|careers?|jobs?|investors?|privacy|cookies?|terms|contact|login|search|tags?|category|webinars?|videos?|case-stud\w*|story|stories|about|esg|legal)(-|/|$)", re.I)


def fetch_text(url, timeout=30, limit=3_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": BOT_UA, "Accept": "text/html,application/xml,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit)
        enc = r.headers.get_content_charset() or "utf-8"
    if url.endswith(".gz") or data[:2] == b"\x1f\x8b":
        import gzip
        data = gzip.decompress(data)
    return data.decode(enc, "replace")


def meta(html, *names):
    for n in names:
        for pat in (r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']+)' % re.escape(n),
                    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']%s["\']' % re.escape(n)):
            m = re.search(pat, html, re.I)
            if m:
                return unescape(m.group(1)).strip()
    return ""


def crawl_domain(dom, old):
    import urllib.robotparser
    base = "https://www." + dom if dom.count(".") == 1 else "https://" + dom
    rp = urllib.robotparser.RobotFileParser()
    sitemaps = []
    try:
        txt = fetch_text(base + "/robots.txt", timeout=20)
        rp.parse(txt.splitlines())
        sitemaps = [l.split(":", 1)[1].strip() for l in txt.splitlines() if l.lower().startswith("sitemap:")]
    except Exception:
        rp.parse([])
    sitemaps += [base + "/sitemap.xml", base + "/sitemap_index.xml", base + "/en/sitemap.xml", base + "/sitemap-index.xml"]
    urls, seen_sm, queue = [], set(), list(dict.fromkeys(sitemaps))
    while queue and len(seen_sm) < 40 and len(urls) < 20000:
        sm = queue.pop(0)
        if sm in seen_sm:
            continue
        seen_sm.add(sm)
        try:
            x = fetch_text(sm)
        except Exception:
            continue
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", x)
        if "<sitemapindex" in x:
            subs = [l for l in locs if re.search(r"product|en|page|post-type|default|sitemap", l, re.I)] or locs
            queue += subs[:30]
        else:
            urls += [unescape(l) for l in locs]
    urls = [u for u in dict.fromkeys(urls) if "product" in u.lower() and not NOT_PRODUCT.search(urllib.parse.urlparse(u).path)]
    en = [u for u in urls if re.search(r"/(en|en-us|en-gb|en-int|us|global|int|ww)(/|$)", urllib.parse.urlparse(u).path, re.I)]
    if len(en) >= 10:
        urls = en
    urls.sort(key=lambda u: -urllib.parse.urlparse(u).path.count("/"))
    have = {i[0]: i for i in old}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    todo = [u for u in urls if u not in have][:PER_RUN]
    stale = sorted((i for i in old if i[4] < (datetime.now(timezone.utc).replace(tzinfo=None) - __import__("datetime").timedelta(days=REFRESH_DAYS)).strftime("%Y-%m-%d")), key=lambda i: i[4])
    todo += [i[0] for i in stale][: max(0, PER_RUN - len(todo))]
    out = dict(have)
    for u in todo:
        if not rp.can_fetch(BOT_UA, u):
            continue
        try:
            h = fetch_text(u, timeout=25)
        except Exception:
            continue
        title = meta(h, "og:title", "twitter:title") or unescape((re.search(r"<title[^>]*>([^<]+)", h, re.I) or [None, ""])[1]).strip()
        img = meta(h, "og:image", "og:image:url", "twitter:image")
        desc = meta(h, "og:description", "description", "twitter:description")
        if img and not img.startswith("http"):
            img = urllib.parse.urljoin(u, img)
        if title and img:
            out[u] = [u, re.sub(r"\s+", " ", title)[:140], img, re.sub(r"\s+", " ", desc)[:220], today]
        time.sleep(0.6)
    keep = set(urls) | set(have)
    items = [i for i in out.values() if i[0] in keep]
    return items, len(urls)


def sync_catalogs():
    from concurrent.futures import ThreadPoolExecutor
    idx = {}
    def one(dom):
        path = f"{OUT}/catalog/{dom}.json"
        try:
            old = json.load(open(path)).get("items", [])
        except Exception:
            old = []
        try:
            items, found = crawl_domain(dom, old)
        except Exception as e:
            print(f"catalog {dom} failed: {e}")
            return dom, len(old)
        if items:
            write(path, {"domain": dom, "items": items})
        print(f"catalog {dom}: {len(items)} products ({found} product URLs in sitemap)", flush=True)
        return dom, len(items)
    with ThreadPoolExecutor(max_workers=12) as ex:
        for dom, n in ex.map(one, CATALOG_DOMAINS):
            if n:
                idx[dom] = n
    write(f"{OUT}/catalog/index.json", {"domains": idx})
    return {"catalog_domains": len(idx), "catalog_products": sum(idx.values())}


def main():
    partners = defaultdict(list)
    meta = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "sources": {}}
    for fn in (sync_eudamed, sync_rwanda, sync_catalogs):
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
