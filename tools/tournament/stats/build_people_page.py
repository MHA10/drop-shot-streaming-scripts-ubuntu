#!/usr/bin/env python3
"""Build the one-file "who's who" page from group_people.py's people.json.

usage: build_people_page.py <people.json> <template.html> <out.html> --title "..." --key NAME [--short-min 2]

Every number gets a card: its tags (tags.json from tag_people.py, if there), a warning if
suggest_groups.py found it stayed on one half through a change of ends (flags.json: two people
or not a player, with pictures from either side of that moment),
cards suggested as the same player (suggest.json from suggest_groups.py) are boxed together,
pictures across its time on court, its stats for the whole stream, and buttons to merge numbers, flag a card holding two
people, or mark someone who isn't a player. Merging adds the pieces' stats up
in the page itself, so nothing has to be re-run to see the merged numbers.
"""
import argparse, base64, json, os

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("people_json")
ap.add_argument("template")
ap.add_argument("out")
ap.add_argument("--title", required=True)
ap.add_argument("--key", required=True, help="name the page saves its answers under in the browser")
ap.add_argument("--video", default="", help="YouTube video id: every time on the page becomes a link to that moment")
ap.add_argument("--short-min", type=float, default=2.0)
ap.add_argument("--tiny-s", type=float, default=20.0, help="numbers on court for less than this are left off")
a = ap.parse_args()

P = json.load(open(a.people_json))
sug_file = os.path.join(os.path.dirname(a.people_json), "suggest.json")
SUGGEST = json.load(open(sug_file)) if os.path.exists(sug_file) else []
tag_file = os.path.join(os.path.dirname(a.people_json), "tags.json")
TAGS = json.load(open(tag_file)) if os.path.exists(tag_file) else {}
flag_file = os.path.join(os.path.dirname(a.people_json), "flags.json")
FLAGS = json.load(open(flag_file)) if os.path.exists(flag_file) else {}
# a 10-minute piece with nobody on court has an empty picture file, which np.memmap can't open (box, 2026-11-24)
blobs = [np.memmap(os.path.join(p, "crops.bin"), np.uint8, "r") if os.path.getsize(os.path.join(p, "crops.bin")) > 0
         else np.zeros(0, np.uint8) for p in P["parts"]]
img = []
persons = []
# Scraps under 20 s (mostly the moment two people cross) are left off the
# page: on the 23 Oct final they were ~1,500 of the numbers for under a tenth
# of the time, and their pictures tripled the page size.
tiny = [q for q in P["persons"] if q["on_s"] < a.tiny_s]
for q in P["persons"]:
    if q["on_s"] < a.tiny_s:
        continue
    def embed(pics):
        out = []
        for s, o, n, f in pics:
            img.append("data:image/jpeg;base64," + base64.b64encode(bytes(blobs[s][o:o + n])).decode())
            out.append([len(img) - 1, f])
        return out
    pics = q["pictures"] if q["on_s"] >= a.short_min * 60 else q["pictures"][:2]
    flags = [{"t": x["t"], "half": x["half"], "before": embed(x["before"]), "after": embed(x["after"])}
             for x in FLAGS.get(str(q["id"]), [])]
    persons.append({"id": q["id"], "pieces": q["pieces"], "pictures": embed(pics),
                    "tags": TAGS.get(str(q["id"]), {}).get("tags", []), "flags": flags})

KEEP = ("start", "end", "on_s", "seen", "far", "dist_m", "lat_m", "sprints", "top_ms", "mean_ms", "net_s", "back_s",
        "n", "sx", "sy", "left", "cells")
used = {k for q in persons for k in q["pieces"]}
pieces = {str(p["id"]): {k: v for k, v in p.items() if k in KEEP} for p in P["pieces"] if p["id"] in used}
kept = {q["id"] for q in persons}
suggest = [g for g in ({"ids": [i for i in g["ids"] if i in kept], "links": g["links"]} for g in SUGGEST) if len(g["ids"]) > 1]
data = {"title": a.title, "key": a.key, "video": a.video, "suggest": suggest, "fps": P["fps"], "end": P["frames_done"] / P["fps"],
        "short_s": a.short_min * 60, "tiny_s": a.tiny_s, "tiny_n": len(tiny),
        "tiny_min": round(sum(q["on_s"] for q in tiny) / 60, 1), "total_min": round(sum(q["on_s"] for q in P["persons"]) / 60, 1),
        "all_n": len(P["persons"]), "persons": persons, "pieces": pieces, "img": img}
html = open(a.template).read().replace("/*DATA*/null", json.dumps(data, separators=(",", ":")))
open(a.out, "w").write(html)
print("wrote", a.out, round(os.path.getsize(a.out) / 1e6, 1), "MB,", len(persons), "numbers,", len(img), "pictures")
