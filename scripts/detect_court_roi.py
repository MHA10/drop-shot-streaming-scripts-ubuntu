"""
Detect a padel court's playing surface in a camera frame and emit the polygon
as HIGHLIGHT_COURT_ROI expects: normalized "x,y;x,y;..." fractions of the frame.

Why detect rather than eyeball: these cameras are wide-angle, so the court's
edges are curved and a hand-read corner is easily 3-5% out. The tracker uses
this boundary to reject people standing off-court, and a boundary that is too
generous silently re-admits the passers-by it exists to exclude.

Written for the terracotta surface at Hello Padel. The court's white lines cut
the colour mask into pieces, so the mask is closed before contours are taken.
"""
import sys, json
import cv2
import numpy as np

def detect(path, want_points=8):
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # Terracotta/clay: hue wraps through red, so two bands are needed.
    lo1 = np.array([0, 55, 50]);   hi1 = np.array([22, 255, 235])
    lo2 = np.array([165, 55, 50]); hi2 = np.array([179, 255, 235])
    mask = cv2.bitwise_or(cv2.inRange(hsv, lo1, hi1), cv2.inRange(hsv, lo2, hi2))

    # Close over the white court lines and the net shadow, then drop specks.
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))

    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        raise SystemExit(f"no court-coloured region found in {path}")

    # The court this camera is ON is the big one in the middle-bottom. A
    # neighbouring court is also terracotta but is small and near the top, so
    # score on area weighted by how central-and-low the region sits.
    def score(c):
        area = cv2.contourArea(c)
        m = cv2.moments(c)
        if m["m00"] == 0:
            return 0
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        centrality = 1.0 - abs(cx / w - 0.5) * 2      # 1 at centre, 0 at edges
        lowness = cy / h                               # prefer lower in frame
        return area * max(centrality, 0.05) * max(lowness, 0.05)

    court = max(cnts, key=score)

    # Simplify to a handful of vertices. Walk epsilon up until the polygon is
    # small enough to read and to paste into .env.
    peri = cv2.arcLength(court, True)
    poly = None
    for eps in [x / 1000 for x in range(2, 60)]:
        approx = cv2.approxPolyDP(court, eps * peri, True)
        if len(approx) <= want_points:
            poly = approx
            break
    if poly is None:
        poly = cv2.approxPolyDP(court, 0.02 * peri, True)

    pts = [(float(p[0][0]) / w, float(p[0][1]) / h) for p in poly]

    # Order counter-clockwise from the top-left so the string reads predictably.
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    pts.sort(key=lambda p: np.arctan2(p[1] - cy, p[0] - cx))

    roi = ";".join(f"{x:.3f},{y:.3f}" for x, y in pts)

    vis = img.copy()
    cv2.polylines(vis, [poly], True, (0, 255, 0), 4)
    for p in poly:
        cv2.circle(vis, tuple(p[0]), 10, (0, 0, 255), -1)
    out = path.replace(".png", "-roi.png")
    cv2.imwrite(out, vis)

    return {
        "file": path,
        "frame": [w, h],
        "points": len(pts),
        "area_pct": round(100 * cv2.contourArea(court) / (w * h), 1),
        "roi": roi,
        "overlay": out,
    }

if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(json.dumps(detect(p), indent=2))
