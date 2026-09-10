"""PadelTracker100 COCO ball annotations -> TrackNet per-frame Label.csv.
Columns: file_name, visibility, x-coordinate, y-coordinate, status
(x,y = ball centre in the source 1920x1080; visibility=1 if ball annotated else 0.)
Frames come from the source match video (full_data.zip); this only needs labels."""
import json, csv, os, sys
S=os.environ["S"]; LAB=f"{S}/padeltracker100/labels"; OUT=f"{S}/padeltracker100/prep"
os.makedirs(OUT, exist_ok=True)
BALL_CAT=1
for split, fn in [("train_FinalM","2022_BCN_FinalM_1_ball.json"),
                  ("val_FinalF","2022_BCN_FinalF_1_ball.json")]:
    d=json.load(open(f"{LAB}/{fn}"))
    imgs={im["id"]: im for im in d["images"]}
    ball={}   # image_id -> (cx, cy)
    for a in d["annotations"]:
        if a.get("category_id")==BALL_CAT and a.get("bbox"):
            x,y,w,h=a["bbox"]; ball[a["image_id"]]=(round(x+w/2,2), round(y+h/2,2))
    rows=[]
    for iid in sorted(imgs, key=lambda i: imgs[i]["file_name"]):
        im=imgs[iid]
        if iid in ball:
            cx,cy=ball[iid]; rows.append([im["file_name"],1,cx,cy,0])
        else:
            rows.append([im["file_name"],0,0,0,0])
    os.makedirs(f"{OUT}/{split}", exist_ok=True)
    with open(f"{OUT}/{split}/Label.csv","w",newline="") as f:
        wtr=csv.writer(f); wtr.writerow(["file_name","visibility","x-coordinate","y-coordinate","status"]); wtr.writerows(rows)
    vis=sum(1 for r in rows if r[1]==1)
    xs=[r[2] for r in rows if r[1]==1]; ys=[r[3] for r in rows if r[1]==1]
    print(f"{split}: {len(rows)} frames, {vis} with ball ({100*vis/len(rows):.0f}%)  "
          f"x[{min(xs):.0f}-{max(xs):.0f}] y[{min(ys):.0f}-{max(ys):.0f}]  -> {OUT}/{split}/Label.csv")
