# -*- coding: utf-8 -*-
"""把策联杯 B 题问题三的最终提交方案编译成前端 3D 可视化用的 plan.json"""
import csv, os, json, sys, math, datetime, collections
sys.stdout.reconfigure(encoding='utf-8')

W = r"C:\Users\28205\Desktop\B题工作区"
D = r"C:\Users\28205\Desktop\2026策联杯B题\B题\2026年度“策联杯”数学建模精英联赛-B题-附件\2026年度“策联杯”数学建模精英联赛-B题-附件"
OUT = r"C:\Users\28205\Documents\codex_space\notebook\review-site\heli\data\plan.json"

FLEET = {
    "T1": dict(seat=12, v=250, burn=3.4, tank=1000, res=150),
    "T2": dict(seat=16, v=220, burn=2.5, tank=1150, res=150),
    "T3": dict(seat=19, v=190, burn=2.9, tank=1600, res=200),
}
for p in FLEET.values():
    p["range"] = round((p["tank"] - p["res"]) / p["burn"], 2)

FLEET_CNT = {("A01","T1"):3, ("A01","T2"):3, ("A01","T3"):2,
             ("A02","T1"):2, ("A02","T2"):4, ("A02","T3"):2,
             ("A03","T1"):2, ("A03","T2"):3, ("A03","T3"):3}
REFUEL = ["F006","F011","F018","F024","F031","F038","F044","F050"]

def rd(p, enc="utf-8-sig"):
    return list(csv.DictReader(open(p, encoding=enc)))

routes = rd(os.path.join(W, "submit", "q3-routes.csv"))
assign = rd(os.path.join(W, "submit", "q3-assignments.csv"))
people = rd(os.path.join(D, "peopleQ3.csv"))
coords = rd(os.path.join(W, "coords.csv"))

# ---------------------------------------------------------------- 距离矩阵
dist_rows = list(csv.reader(open(os.path.join(D, "distances.csv"), encoding="utf-8-sig")))
hdr = dist_rows[0][1:]
DM = {}
for row in dist_rows[1:]:
    a = row[0]
    for b, v in zip(hdr, row[1:]):
        DM[(a, b)] = float(v)
def dist(a, b): return DM[(a, b)]

# ---------------------------------------------------------------- 节点
XY = {}
for r in coords:
    XY[r[""] if "" in r else list(r.values())[0]] = (float(r["x"]), float(r["y"]))
# csv.DictReader 的首列列名为空串
XY = {}
for r in coords:
    key = r.get("") or r.get(None) or list(r.values())[0]
    XY[key] = (float(r["x"]), float(r["y"]))

DAYS = ["2026-08-03","2026-08-04","2026-08-05","2026-08-06","2026-08-07","2026-08-08","2026-08-09"]
DAY_IDX = {d: i for i, d in enumerate(DAYS)}
WEEK = ["周一","周二","周三","周四","周五","周六","周日"]

def tmin(s):
    """'2026-08-03 07:03' -> (dayIdx, minutes_of_day)"""
    d, t = s.split(" ")
    h, m = t.split(":")
    return DAY_IDX[d], int(h) * 60 + int(m)

# ---------------------------------------------------------------- 架次
flights = collections.OrderedDict()
for r in routes:
    key = (r["aircraft_id"], int(r["flight_no"]))
    flights.setdefault(key, []).append(r)
for k in flights:
    flights[k].sort(key=lambda r: int(r["stop_order"]))

# ---------------------------------------------------------------- 乘客挂到架次
pmeta = {p["person_id"]: p for p in people}
pax_of = collections.defaultdict(list)
passign = {}
for a in assign:
    pid = a["person_id"]
    if not a["aircraft_id"]:
        passign[pid] = None
        continue
    key = (a["aircraft_id"], int(a["flight_no"]))
    rec = (pid, int(a["pickup_stop_order"]), int(a["delivery_stop_order"]))
    pax_of[key].append(rec)
    passign[pid] = (key, rec[1], rec[2])

TASK = {"emergency": 0, "production": 1, "shift": 2, "temporary": 3}

out_flights = []
fkey_idx = {}
totalT = totalFuel = 0
num_pax_km = den_pax_km = 0.0
for key, rows in flights.items():
    ac, no = key
    base, typ, _ = ac.split("-")
    seq = [r["facility_id"] for r in rows]
    d0, dep0 = tmin(rows[0]["departure_time"])
    stops = []
    for i, r in enumerate(rows):
        a = tmin(r["arrival_time"])[1] if r["arrival_time"] else None
        dpt = tmin(r["departure_time"])[1] if r["departure_time"] else None
        stops.append({"n": r["facility_id"], "a": a, "d": dpt, "r": int(r["refuel"])})
    dur = stops[-1]["a"] - stops[0]["d"]
    # 逐航段载客数
    pl = sorted(pax_of.get(key, []), key=lambda x: x[1])
    nleg = len(seq) - 1
    legload = [0] * nleg
    for pid, b, o in pl:
        for j in range(b, o):
            legload[j] += 1
    legdist = [dist(seq[j], seq[j+1]) for j in range(nleg)]
    fdist = sum(legdist)
    fuel = fdist * FLEET[typ]["burn"]
    totalT += dur
    totalFuel += fuel
    for j in range(nleg):
        num_pax_km += legload[j] * legdist[j]
        den_pax_km += FLEET[typ]["seat"] * legdist[j]
    fkey_idx[key] = len(out_flights)
    out_flights.append({
        "i": len(out_flights), "ac": ac, "no": no, "day": d0, "t": typ, "base": base,
        "s": stops, "dur": dur, "km": round(fdist, 1), "fuel": round(fuel),
        "load": legload, "seat": FLEET[typ]["seat"],
        "pax": [[p, b, o] for p, b, o in pl],
        "maxload": max(legload) if legload else 0,
    })

print("架次", len(out_flights), "总飞机使用时间", totalT, "燃油", round(totalFuel))
print("座位利用率 %.2f%%" % (100 * num_pax_km / den_pax_km))

# ---------------------------------------------------------------- 人员
out_people = {}
Ptotal = 0
nsat = collections.Counter()
for p in people:
    pid = p["person_id"]
    a = passign.get(pid)
    rec = {
        "o": p["origin_id"], "d": p["destination_id"],
        "ep": p["earliest_pickup_time"], "la": p["latest_arrival_time"],
        "tt": TASK[p["task_type"]],
    }
    if a:
        (ac, no), b, o = a
        fi = fkey_idx[(ac, no)]
        f = out_flights[fi]
        rec["f"] = fi
        rec["b"] = b
        rec["x"] = o
        t0 = f["s"][b]["d"]
        t1 = f["s"][o]["a"]
        rec["ride"] = t1 - t0
        Ptotal += t1 - t0
        nsat[p["task_type"]] += 1
    out_people[pid] = rec
print("人员总在途时间 P =", Ptotal, "人均 %.1f" % (Ptotal / sum(nsat.values())))
print("满足", dict(nsat))

# ---------------------------------------------------------------- 节点表
nodes = {}
for n, (x, y) in XY.items():
    isA = n.startswith("A")
    nodes[n] = {
        "x": round(x, 2), "y": round(y, 2),
        "k": "A" if isA else "F",
        "rf": 1 if n in REFUEL else 0,
        # 到三座机场的真实距离（直接取题目距离矩阵，不用 MDS 坐标反算）
        "dA": [round(dist(n, a)) for a in ("A01", "A02", "A03")],
    }
# 每个节点的到离港统计
for n in nodes:
    nodes[n]["arr"] = 0; nodes[n]["dep"] = 0; nodes[n]["visits"] = 0
for f in out_flights:
    for i, s in enumerate(f["s"]):
        nodes[s["n"]]["visits"] += 1
for pid, r in out_people.items():
    if "f" not in r: continue
    f = out_flights[r["f"]]
    nodes[f["s"][r["b"]]["n"]]["dep"] += 1
    nodes[f["s"][r["x"]]["n"]]["arr"] += 1

# 机队清单（含未使用的 3 架）
roster = []
for (ap, ty), cnt in sorted(FLEET_CNT.items()):
    for i in range(1, cnt + 1):
        roster.append({"id": f"{ap}-{ty}-H{i:02d}", "base": ap, "t": ty})
used = set(f["ac"] for f in out_flights)
for a in roster:
    a["used"] = 1 if a["id"] in used else 0

meta = {
    "days": DAYS, "week": WEEK,
    "open": 6 * 60, "lastDep": 18 * 60, "close": 20 * 60, "turn": 30,
    "fleet": FLEET, "fleetCnt": {f"{k[0]}|{k[1]}": v for k, v in FLEET_CNT.items()},
    "refuel": REFUEL,
    "stats": {
        "T": totalT, "Th": round(totalT / 60, 2), "N": len(out_flights),
        "P": Ptotal, "Pavg": round(Ptotal / 3996, 1),
        "fuel": round(totalFuel), "U": round(100 * num_pax_km / den_pax_km, 2),
        "LB": 24536, "gap": 21.56, "gapL": 27.49,
        "temp": nsat["temporary"], "tempAll": 160,
        "people": 4000, "served": sum(nsat.values()),
        "aircraft": 24, "acUsed": len(used),
    },
    "airportNames": {"A01": "澜港基地", "A02": "碧屿基地", "A03": "东岬基地"},
    "taskNames": ["应急抢险", "增储上产", "常规倒班", "临时任务"],
}

data = {"meta": meta, "nodes": nodes, "flights": out_flights,
        "people": out_people, "roster": roster}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
print("wrote", OUT, os.path.getsize(OUT), "bytes")

# 校验：MDS 坐标还原距离的误差
errs = []
for f in out_flights[:60]:
    for j in range(len(f["s"]) - 1):
        a, b = f["s"][j]["n"], f["s"][j+1]["n"]
        real = dist(a, b)
        ax, ay = XY[a]; bx, by = XY[b]
        emb = math.hypot(ax - bx, ay - by)
        if real > 1: errs.append(abs(emb - real) / real)
print("MDS 相对误差 mean %.3f max %.3f" % (sum(errs)/len(errs), max(errs)))
