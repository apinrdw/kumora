import json, re, sys, zipfile, xml.etree.ElementTree as ET
from collections import defaultdict

DL = sys.argv[1]
OUT = sys.argv[2]
MONTHS = ["2026-02-27", "2026-03-31", "2026-04-30", "2026-05-29", "2026-06-30",
          "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-30"]
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def col(ref):
    return re.match(r"[A-Z]+", ref).group(0)


def read(path):
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
            ss.append("".join(t.text or "" for t in si.iter(NS + "t")))
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for r in root.iter(NS + "row"):
        d = {}
        for c in r.findall(NS + "c"):
            v = c.find(NS + "v")
            t = c.get("t")
            if v is None:
                is_ = c.find(NS + "is")
                val = "".join(x.text or "" for x in is_.iter(NS + "t")) if is_ is not None else None
            elif t == "s":
                val = ss[int(v.text)]
            elif t == "b":
                val = "TRUE" if v.text == "1" else "FALSE"
            else:
                val = v.text
            d[col(c.get("r"))] = val
        rows.append(d)
    return rows


def key(name):
    s = name.upper()
    s = re.sub(r"[.,;:'\"()\-/&]", " ", s)
    words = [w for w in s.split() if w not in ("PT", "TBK", "TB", "PERSERO")]
    return " ".join(sorted(words))


def blank(v):
    return None if v is None or str(v).strip() == "" else str(v).strip()


data = {}
for m in MONTHS:
    rows = read(f"{DL}/one_{m}.xlsx")
    hi = next(i for i, r in enumerate(rows) if "SHARE_CODE" in r.values())
    hdr = {v: k for k, v in rows[hi].items() if v}
    out = defaultdict(list)
    for r in rows[hi + 1:]:
        code = blank(r.get(hdr["SHARE_CODE"]))
        if not code:
            continue
        g = lambda h: blank(r.get(hdr[h])) if h in hdr else None
        cls = g("INVESTOR_CLASSIFICATION") or g("INVESTOR_TYPE")
        lf = g("LOCAL_FOREIGN")
        lf = {"L": "local", "F": "foreign", "A": "foreign"}.get(lf) if lf else None
        ctl = g("CONTROLLER_OR_AFFILIATE")
        ctl = {"CONTROLLER": "controller", "AFFILIATE OF THE CONTROLLER": "affiliate"}.get(ctl) if ctl else None
        out[code].append({
            "name": g("INVESTOR_NAME"), "key": key(g("INVESTOR_NAME")),
            "cls": cls, "origin": lf, "dom": g("DOMICILE"), "ctl": ctl,
            "scripless": int(float(g("HOLDINGS_SCRIPLESS") or 0)),
            "scrip": int(float(g("HOLDINGS_SCRIP") or 0)),
            "total": int(float(g("TOTAL_HOLDING_SHARES") or 0)),
            "pct": round(float(g("PERCENTAGE") or 0), 2),
            "issuer": g("ISSUER_NAME"),
        })
    data[m] = out

# pick stocks: fixed list + the one with most rows in Oct + one with a false pair Sep->Oct
pick = ["BBCA", "TLKM", "GOTO", "AADI", "BREN", "ZYRX", "BBRI", "ANTM"]
oct_, sep = data["2026-10-30"], data["2026-09-30"]
most = max(oct_, key=lambda c: len(oct_[c]))
pick.append(most)
for c in sorted(oct_):
    a = {r["key"] for r in sep.get(c, [])}
    b = {r["key"] for r in oct_[c]}
    news = b - a
    exits = a - b
    if news and exits and c not in pick:
        tot_a = {r["total"] for r in sep[c] if r["key"] in exits}
        tot_b = {r["total"] for r in oct_[c] if r["key"] in news}
        if tot_a & tot_b:
            pick.append(c)
            break
result = {m: {c: data[m].get(c, []) for c in pick} for m in MONTHS}
json.dump({"months": MONTHS, "stocks": pick, "data": result}, open(OUT, "w"))
print(pick, most)
