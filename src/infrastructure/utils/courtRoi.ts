/**
 * Court boundary ("ROI") for the highlight reel tracker.
 *
 * ── IN SIMPLE WORDS ──
 * A box's camera usually also sees paths, terraces and neighbouring courts.
 * The court boundary is an invisible outline of the court in front of the
 * camera; the tracker ignores anyone standing outside it, so a passer-by can't
 * pull the reel's crop off the court.
 *
 * ── FORMAT ──
 * Normalized polygon points "x,y;x,y;..." — each value is a fraction of the
 * frame width/height (0..1), so one value works at any camera resolution.
 * At least 3 points. Validated (and ignored with a warning if bad) by
 * scripts/reframe_ball.py, so a typo can never cost a reel.
 *
 *   HIGHLIGHT_COURT_ROI           default for every court on this box
 *   HIGHLIGHT_COURT_ROI_BY_COURT  JSON {"<courtId>": "x,y;..."} per-court override
 *
 * Neither set → no boundary (the original behaviour).
 */

/**
 * Parse HIGHLIGHT_COURT_ROI_BY_COURT. Returns {} for empty input; bad JSON or
 * non-string values are dropped with a warning instead of failing startup.
 */
export function parseCourtRoiMap(
  raw: string,
  warn: (msg: string) => void = (m) => console.warn(m)
): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(
      `[CONFIG] HIGHLIGHT_COURT_ROI_BY_COURT is not valid JSON; ignoring it (${
        error instanceof Error ? error.message : String(error)
      })`
    );
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn('[CONFIG] HIGHLIGHT_COURT_ROI_BY_COURT must be a JSON object {"<courtId>": "x,y;..."}; ignoring it');
    return {};
  }
  const out: Record<string, string> = {};
  for (const [courtId, roi] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof roi === "string" && roi.trim()) {
      out[courtId] = roi.trim();
    } else {
      warn(`[CONFIG] HIGHLIGHT_COURT_ROI_BY_COURT: court ${courtId} has no usable boundary; ignoring it`);
    }
  }
  return out;
}

/** The boundary for a court: its own override, else the box default, else "". */
export function pickCourtRoi(
  defaultRoi: string,
  byCourt: Record<string, string>,
  courtId: string
): string {
  return (byCourt[courtId] ?? defaultRoi ?? "").trim();
}
