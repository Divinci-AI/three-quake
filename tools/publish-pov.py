#!/usr/bin/env python3
"""Per-match pipeline: render mp4 (crf 27) -> webm -> ffprobe verify -> upload to R2 -> verify public URL -> manifest -> delete local.
Resumable: matches already in bench/pov-mp4/manifest.json are skipped. Never overwrites a remote object (HEAD first)."""
import json, os, subprocess, sys, hashlib, shutil, time, urllib.request, urllib.error
ROOT = os.path.expanduser("~/Documents/three-quake-npc"); os.chdir(ROOT)
BUCKET = "divinci-quake-media"; BASE = "https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev"; PREFIX = "quake-tournament/2026-10-15/"
WORK = "bench/pov-mp4/_work"; MAN = "bench/pov-mp4/manifest.json"; FLOOR_GB = 2.5
os.makedirs(WORK, exist_ok=True)
man = json.load(open(MAN)) if os.path.exists(MAN) else {"bucket": BUCKET, "base": BASE, "prefix": PREFIX, "clips": {}}
def save(): json.dump(man, open(MAN + ".tmp", "w"), indent=1); os.replace(MAN + ".tmp", MAN)
def free_gb(): s = os.statvfs("/"); return s.f_bavail * s.f_frsize / 1e9
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
def probe(p):
    d = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", p]))
    return float(d["format"]["duration"]), d["streams"][0]["width"], d["streams"][0]["height"]
def demo_end(p):
    import struct
    d = open(p, "rb").read(); i = d.index(b"\n") + 1; last = 0
    while i + 16 <= len(d):
        L = struct.unpack_from("<i", d, i)[0]; i += 16
        if L < 0 or i + L > len(d): break
        if L >= 5 and d[i] == 7: last = struct.unpack_from("<f", d, i + 1)[0]
        i += L
    return last
def run(cmd, **k): subprocess.run(["nice", "-n", "15"] + cmd, check=True, **k)
def head(url):
    # curl, not urllib: Cloudflare answers the default Python-urllib agent with 403 (error 1010)
    return int(subprocess.check_output(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-I", "--max-time", "30", f"{url}?cb={time.time()}"]).decode())
def fetch(url, dest): subprocess.run(["curl", "-s", "-f", "--max-time", "600", "-o", dest, f"{url}?cb={time.time()}"], check=True)
rows = [json.loads(l) for l in open("bench/results/r2-all.jsonl")]
valid = {r["match"]: r for r in rows if r.get("valid")}
only = [int(x) for x in sys.argv[1:]]
for m in sorted(valid):
    if only and m not in only: continue
    r = valid[m]; arm = r["followArm"].replace("arm:", ""); stem = f"r2-m{m:02d}-{r['persona']}-{arm}-pov"
    if stem in man["clips"]: continue
    if free_gb() < FLOOR_GB: print(f"PAUSE: free disk {free_gb():.2f} GB below {FLOOR_GB}", flush=True); sys.exit(3)
    bot = next(b for b in r["stats"]["bots"] if b["isBot"] and b["slot"] == r["followSlot"])
    mp4, webm = f"{WORK}/{stem}.mp4", f"{WORK}/{stem}.webm"
    print(f"[{time.strftime('%H:%M:%S')}] {stem} render", flush=True)
    if not (os.path.exists(mp4) and os.path.exists(webm) and os.path.getsize(webm) > 0): run(["node", "tools/render-pov.mjs", r["demo"], mp4, "--seconds", str(int(demo_end(r["demo"])) + 8), "--fps", "30", "--size", "1280x720", "--crf", "33", "--end-time", str(demo_end(r["demo"]))])
    if not (os.path.exists(webm) and os.path.getsize(webm) > 0): run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp4, "-an", "-c:v", "libvpx-vp9", "-crf", "38", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p", webm])
    want = r["stats"]["time"]; entry = {"match": m, "persona": r["persona"], "followedArm": arm, "botName": bot["name"], "frags": bot["frags"], "deaths": bot["deaths"], "matchSeconds": round(want, 1), "files": {}}
    for kind, p, ct in (("mp4", mp4, "video/mp4"), ("webm", webm, "video/webm")):
        dur, w, h = probe(p)
        assert abs(dur - want) <= 2 and (w, h) == (1280, 720), f"{p}: dur {dur} want {want} size {w}x{h}"
        key = PREFIX + os.path.basename(p); url = f"{BASE}/{key}"
        st = head(url)
        if st == 404:
            for attempt in range(4):
                try:
                    run(["wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--file", p, "--content-type", ct, "--cache-control", "public, max-age=31536000, immutable", "--remote"], env={k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"}, stdout=subprocess.DEVNULL); break
                except subprocess.CalledProcessError:
                    if attempt == 3: raise
                    time.sleep(30)
        else:
            assert st == 200, f"unexpected status {st} for {key}"  # an earlier run of THIS script may have uploaded it; the hash check below proves it is the same file
        chk = p + ".chk"
        fetch(url, chk)
        assert os.path.getsize(chk) == os.path.getsize(p) and sha(chk) == sha(p), f"remote mismatch {key}"
        os.remove(chk)
        entry["files"][kind] = {"name": os.path.basename(p), "bytes": os.path.getsize(p), "durationSeconds": round(dur, 2), "width": w, "height": h, "sha256": sha(p), "url": url}
    man["clips"][stem] = entry; save()
    os.remove(mp4); os.remove(webm)
    print(f"[{time.strftime('%H:%M:%S')}] {stem} DONE mp4={entry['files']['mp4']['bytes']} webm={entry['files']['webm']['bytes']} free={free_gb():.1f}GB", flush=True)
print("ALL DONE", flush=True)
