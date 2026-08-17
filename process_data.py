"""Convert FCC FM Query raw dump (fmq_raw.txt) into compact stations.json.

Raw format: pipe-delimited, one record per line. Field indices (0-based after
split('|'), index 0 is empty because lines start with '|'):
  1=callsign 2=freq 3=service 4=channel 5=dir 7=class 9=status 10=city 11=state
  12=country 14=ERP_h 15=ERP_v 16=HAAT_h 17=HAAT_v 18=facility_id
  19=N/S 20-22=lat DMS  23=E/W 24-26=lon DMS
"""
import json
import re

# Statuses that represent on-air or imminent transmitters (CP = construction
# permit: treat as occupied so we don't recommend a channel about to light up).
KEEP_STATUS = {"LIC", "MOD", "STA", "CP"}
# FM=full service, FX=translator, FB/FR=booster, FL=LPFM. FS=auxiliary backup
# facilities (duplicate sites, normally off-air) -> skip.
KEEP_SERVICE = {"FM", "FX", "FB", "FR", "FL"}
STATUS_RANK = {"LIC": 0, "MOD": 1, "STA": 2, "CP": 3}


def num(s):
    s = s.strip()
    m = re.match(r"^-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


def parse_line(line):
    f = line.split("|")
    if len(f) < 27:
        return None
    service = f[3].strip()
    status = f[9].strip()
    if service not in KEEP_SERVICE or status not in KEEP_STATUS:
        return None
    freq = num(f[2])
    if freq is None or freq < 87.8 or freq > 108.0:
        return None
    try:
        lat = float(f[20]) + float(f[21]) / 60 + float(f[22]) / 3600
        lon = float(f[24]) + float(f[25]) / 60 + float(f[26]) / 3600
    except ValueError:
        return None
    if f[19].strip() == "S":
        lat = -lat
    if f[23].strip() == "W":
        lon = -lon
    if lat == 0 and lon == 0:
        return None
    erp_h, erp_v = num(f[14]), num(f[15])
    erp = max(x for x in (erp_h, erp_v, 0.0) if x is not None)
    if erp <= 0:
        erp = 0.001  # unknown ERP: assume tiny rather than dropping
    haat_h, haat_v = num(f[16]), num(f[17])
    haat = max(x for x in (haat_h, haat_v, 0.0) if x is not None)
    if haat <= 0:
        # Missing HAAT (common for translators): assume a modest antenna height
        haat = 50.0 if service in ("FX", "FB", "FR", "FL") else 150.0
    facid = f[18].strip()
    return {
        "facid": facid,
        "status": status,
        "call": f[1].strip(),
        "freq": round(freq, 1),
        "svc": service,
        "cls": f[7].strip(),
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "erp": erp,
        "haat": haat,
        "city": f[10].strip().title(),
        "state": f[11].strip(),
    }


def main():
    records = []
    with open("fmq_raw.txt", encoding="latin-1") as fh:
        for line in fh:
            r = parse_line(line)
            if r:
                records.append(r)

    # Dedup: one record per facility id, preferring LIC > MOD > STA > CP.
    best = {}
    for r in records:
        key = r["facid"] or (r["call"], r["freq"])
        cur = best.get(key)
        if cur is None or STATUS_RANK[r["status"]] < STATUS_RANK[cur["status"]]:
            best[key] = r

    stations = sorted(best.values(), key=lambda r: (r["freq"], r["call"]))
    # Compact array form: [call, freq, lat, lon, erp_kw, haat_m, svc, class, city, state]
    rows = [
        [r["call"], r["freq"], r["lat"], r["lon"], round(r["erp"], 3),
         round(r["haat"], 1), r["svc"], r["cls"], r["city"], r["state"]]
        for r in stations
    ]
    out = {
        "generated": "2026-08-17",
        "source": "FCC FM Query (transition.fcc.gov/fcc-bin/fmq)",
        "fields": ["call", "freq", "lat", "lon", "erp_kw", "haat_m", "svc", "class", "city", "state"],
        "stations": rows,
    }
    with open("stations.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
    # JS version so the app works when opened without a web server (no fetch)
    with open("stations.js", "w", encoding="utf-8") as fh:
        fh.write("window.STATION_DATA=")
        json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
        fh.write(";")
    print(f"kept {len(rows)} stations from {len(records)} records")


if __name__ == "__main__":
    main()
