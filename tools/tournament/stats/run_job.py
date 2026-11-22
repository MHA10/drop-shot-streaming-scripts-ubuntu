#!/usr/bin/env python3
"""Work out the players and their stats for one match (one "job"), step by step.

usage: run_job.py <job_dir>

── IN SIMPLE WORDS ──
The stats runner (stats-runner.mjs) puts a match's details in <job_dir>/job.json
and the list of video pieces in <job_dir>/list.ffconcat, then starts this. It runs
the steps one after another: empty-court picture, people finder, looks, grouping
into person numbers with stats, colour tags, "same player" suggestions, and the
who's-who page. Each finished step leaves a marker, so a stopped or crashed run
carries on from the step it was in, never from the start.

── BUSINESS RULES ──
- Stats are worked out after play, never during it (team meeting 2026-10-25: live
  stats heated the box to 86 °C).
- One page per match, titled with the team names from the scoreboard (tournament
  2026-11-22: players pick their own card afterwards).

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- Markers per step and per 10-minute part of the people finder: the runner can
  freeze this program at any moment (a court goes live) and may restart it; without
  markers a restart would redo an hour of work.
- "PROGRESS <pct> <step>" lines on stdout are how the runner shows % in its ledger.
- Every step's own output goes to <job_dir>/log.txt, so a failure can be read later.

── DO NOT ──
- Don't write outside <job_dir>.
- Don't remove a step's marker check: the runner relies on re-runs being cheap.
"""
import json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
job = sys.argv[1]
J = json.load(open(os.path.join(job, "job.json")))
PY = sys.executable
VIDEO = os.path.join(job, "list.ffconcat")
MED = os.path.join(job, "median.png")
PEOPLE = os.path.join(job, "people")
WHO = os.path.join(job, "who")
LOG = open(os.path.join(job, "log.txt"), "a", buffering=1)
total_min = max(0.1, J["duration_s"] / 60)
part_min = float(J.get("part_min", 10))

# share of the whole job each step takes (the people finder is most of it)
STEPS = [
    ("median", 2, [PY, "-I", f"{HERE}/make_median.py", VIDEO, MED, "--size", J["size"]]),
    ("people", 72, [PY, "-I", f"{HERE}/detect_people.py", VIDEO, MED, PEOPLE, f"--poly={J['poly']}",
                    f"--court={J['court']}", "--fps", str(J.get("fps", 5)), "--part-min", str(part_min),
                    "--device", J.get("device", "cpu")]),
    ("looks", 16, [PY, "-I", f"{HERE}/looks.py", PEOPLE, MED, f"--poly={J['poly']}", "--device", J.get("device", "cpu")]),
    ("group", 4, [PY, "-I", f"{HERE}/group_people.py", PEOPLE, WHO, f"--court={J['court']}",
                  "--fps", str(J.get("fps", 5))]),
    ("tags", 2, [PY, "-I", f"{HERE}/tag_people.py", WHO, VIDEO, MED, f"--poly={J['poly']}", "--no-text",
                 "--min-min", "0.33"]),
    ("suggest", 2, [PY, "-I", f"{HERE}/suggest_groups.py", WHO, f"--court={J['court']}", "--across=strict"]),
    ("page", 2, [PY, "-I", f"{HERE}/build_people_page.py", os.path.join(WHO, "people.json"),
                 f"{HERE}/people-template.html", os.path.join(job, "whos-who.html"), "--title", J["title"],
                 "--key", J["key"]]),
]


def say(msg):
    LOG.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}\n")


def progress(pct, step):
    print(f"PROGRESS {pct:.0f} {step}", flush=True)


before = 0.0
for name, share, cmd in STEPS:
    mark = os.path.join(job, f".done-{name}")
    if os.path.exists(mark):
        before += share
        continue
    progress(before, name)
    say(f"step {name} started: {' '.join(c if ' ' not in c else repr(c) for c in cmd)}")
    t0 = time.time()
    env = dict(os.environ, PYTHONUNBUFFERED="1", YOLO_OFFLINE="1")
    # errors="replace": one odd byte in a step's output must not kill this program mid-step
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", env=env)
    try:
        for line in proc.stdout:
            try:
                LOG.write(line)
            except OSError:
                pass  # disk full: keep the step going, the runner freezes everything below 25 GB anyway
            m = re.match(r"\s*part (\d+): ([\d.]+) of", line)
            if name == "people" and m:
                done_min = int(m.group(1)) * part_min + float(m.group(2))
                progress(before + share * min(1.0, done_min / total_min), name)
            m = re.match(r"part (\d+) (done|already done)", line)
            if name == "people" and m:
                progress(before + share * min(1.0, (int(m.group(1)) + 1) * part_min / total_min), name)
        rc = proc.wait()
    finally:
        # if this program dies mid-step, the step must not run on unmanaged (review 2026-11-22)
        if proc.poll() is None:
            proc.kill()
    if rc != 0:
        say(f"step {name} FAILED (exit {rc}) after {time.time() - t0:.0f} s")
        print(f"FAILED {name} exit {rc}", flush=True)
        sys.exit(1)
    open(mark, "w").write(f"{time.time() - t0:.0f} s\n")
    say(f"step {name} done in {time.time() - t0:.0f} s")
    before += share
progress(100, "done")
say("all steps done")
