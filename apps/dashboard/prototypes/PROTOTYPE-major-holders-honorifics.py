import re, sys, importlib.util
from collections import defaultdict

spec = importlib.util.spec_from_file_location("ex", sys.argv[2])
DL = sys.argv[1]
src = open(sys.argv[2]).read().split("data = {}")[0]
ns = {}
exec(src.replace("DL = sys.argv[1]\nOUT = sys.argv[2]\n", ""), ns)
read, MONTHS = ns["read"], ns["MONTHS"]

LEGAL = {"PT", "TBK", "TB", "PERSERO"}
HON = {"IR", "DRS", "DRA", "H", "HJ", "HJH", "PROF", "SE", "SH", "ST", "MM", "MBA", "MSC", "SKOM", "SPD", "ME", "MSI", "SKED"}


def key(name, hon):
    s = re.sub(r"[.,;:'\"()\-/&]", " ", name.upper())
    drop = LEGAL | (HON if hon else set())
    return " ".join(sorted(w for w in s.split() if w not in drop))


months = []
for m in MONTHS:
    rows = read(f"{DL}/one_{m}.xlsx")
    hi = next(i for i, r in enumerate(rows) if "SHARE_CODE" in r.values())
    hdr = {v: k for k, v in rows[hi].items() if v}
    out = defaultdict(list)
    for r in rows[hi + 1:]:
        c = r.get(hdr["SHARE_CODE"])
        if c and str(c).strip():
            out[str(c).strip()].append(str(r.get(hdr["INVESTOR_NAME"])).strip())
    months.append(out)

for hon in (False, True):
    pairs = stocks = 0
    for a, b in zip(months, months[1:]):
        for c in a:
            if c not in b:
                continue
            ka = {key(n, hon) for n in a[c]}
            kb = {key(n, hon) for n in b[c]}
            ex, nw = ka - kb, kb - ka
            pairs += min(len(ex), len(nw))
            stocks += bool(ex and nw)
    print("honorifics dropped" if hon else "measured key", "false-pair upper bound", pairs, "stock-months with off+new", stocks)

# New within-month merges the honorific list causes: distinct names that only collide with HON.
merges = set()
for mi, mo in enumerate(months):
    for c, names in mo.items():
        by = defaultdict(set)
        for n in names:
            by[key(n, True)].add(key(n, False))
        for k, olds in by.items():
            if len(olds) > 1:
                merges.add((c, tuple(sorted(olds))))
print("within-month merges caused by honorifics:", len(merges))
for x in sorted(merges)[:25]:
    print(" ", x)
