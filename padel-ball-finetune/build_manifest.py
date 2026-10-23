"""Build TrackNet fine-tune manifests (labels_train.csv / labels_val.csv) from the
per-frame Label.csv files. Each row = a 3-consecutive-frame window + the ball
target of the current frame. Columns match yastrebksv datasets.py:
  path, path_prev, path_preprev, path_gt, x-coordinate, y-coordinate, status, visibility
GT is generated on-the-fly from (x,y) at train time, so path_gt is a nominal path.
Frames (images/<split>/frame_XXXXXX.PNG) arrive from full_data.zip; this needs only labels."""
import csv, os, re
S=os.environ["S"]; PREP=f"{S}/padeltracker100/prep"
def fnum(name): return int(re.search(r"(\d+)", name).group(1))
for split, out in [("train_FinalM","labels_train.csv"),("val_FinalF","labels_val.csv")]:
    rows=list(csv.DictReader(open(f"{PREP}/{split}/Label.csv")))
    man=[]; kept_ball=0
    for i in range(2,len(rows)):
        r,p1,p2=rows[i],rows[i-1],rows[i-2]
        if not (fnum(r["file_name"])==fnum(p1["file_name"])+1==fnum(p2["file_name"])+2):
            continue  # require 3 truly-consecutive frames
        f=r["file_name"]
        man.append([f"images/{split}/{f}",
                    f"images/{split}/{p1['file_name']}",
                    f"images/{split}/{p2['file_name']}",
                    f"gts/{split}/{f}",
                    r["x-coordinate"], r["y-coordinate"], r["status"], r["visibility"]])
        kept_ball += r["visibility"]=="1"
    with open(f"{PREP}/{out}","w",newline="") as fh:
        w=csv.writer(fh); w.writerow(["path","path_prev","path_preprev","path_gt","x-coordinate","y-coordinate","status","visibility"]); w.writerows(man)
    print(f"{out}: {len(man)} training windows ({kept_ball} with a ball target, {100*kept_ball/len(man):.0f}%) -> {PREP}/{out}")
