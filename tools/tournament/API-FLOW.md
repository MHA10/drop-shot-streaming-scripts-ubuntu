# From the tournament box to players tagging themselves

What has to happen for a player to see their stats in the app, which backend routes each step uses, and what the Hello Padel box keeps so every step can be run (or re-run) later. Routes are from ds-backend `staging`, `src/modules/match-stats` and `src/modules/live-scoring`, read on 22 Nov 2026. **Since 23 Nov the match-stats routes are on production, switched on for Hello Padel only** (Farooq; production = `master` = `staging` = `c9a166e4`).

## The flow, step by step

| # | Step | Route (ds-backend) | Login | Who | Status |
|---|------|--------------------|-------|-----|--------|
| 1 | A match is started, scored and ended on Farooq's screen | `POST /padel-grounds/:groundId/courts/:courtId/live-match`, `PATCH …/live-match/:matchId/score`, `POST …/:matchId/end` | venue login | Farooq's screen | live tonight (production) |
| 2 | The box records the court, logs the match, works out stats | none (Supabase `score_board` realtime) | Supabase anon key | box: ds-recorder, ds-match-log, ds-stats | running tonight |
| 3 | The 4 player slots per match, in the route's exact shape | none (saved to disk) | none | box: `stats/make_payload.py` | built 22 Nov |
| 4 | Pictures and heatmaps uploaded | Cloudinary | Cloudinary login (on the box) | `send_stats.mjs` | built 23 Nov, tested against a fake Cloudinary |
| 5 | The match's stats sent | `POST /padel-grounds/:groundId/courts/:courtId/stats` | `x-streaming-api-key` (box) | `send_stats.mjs` | built 23 Nov; the route is on production for Hello Padel only since 23 Nov (Farooq) |
| 6 | Backend links the stats to the match | automatic: the live match on that court at `capturedAt` (or `matchId` if given) | none | backend | built (staging) |
| 7 | **Players are emailed "stats ready"** | automatic on the first save | none | backend | built (staging) |
| 8 | A player sees the match and says "that's me" | `GET /me/match-stats/to-annotate`, `POST /me/match-stats/:id/claim` (`{slot}`), `PUT /me/match-stats/:id/slots/:slot` | player login | app | API built (staging); app screen unknown |
| 9 | The venue fills or fixes slots | `GET /padel-grounds/:id/match-stats`, `PUT …/match-stats/:id/slots/:slot` | venue login + feature switch + tier | venue portal | API built (staging) |

Rules that matter for testing (read in `match-stats.service.ts` / `engines/slots.ts`):
- A claim only works on a **tournament** match (`tournamentMatchId` set on the live match) and only for someone on that match's team sheet; partners must be on the same side, opponents on the other.
- Tagging stays open **14 days** after `capturedAt`.
- Sending the same `matchId` again replaces the record. Without a `matchId`, the backend links by court and time; if it finds no match, a resend with the same `streamId` + `capturedAt` replaces instead of duplicating. The box sets `streamId` to `dropshot-box:<job id>` for that.
- **Step 7 emails real people.** The first production send of a match is the go-live moment for its players. Test on staging only.

## What the box keeps (never deleted by these programs)

All under `~/dropshot-tournament` on the Hello Padel box:

| Kept | Where | Needed for |
|------|-------|-----------|
| Camera video, 10-minute files | `recordings/<court>/*.mkv` | re-running any stats step |
| Every scoreboard change, as it arrived | `matches/events.jsonl` (append-only) | rebuilding the match list; recreating a match on staging |
| The match list | `matches/matches.json`, `matches.txt` | jobs |
| Per match: people found, pictures, stats, page | `stats-out/<job>/` (`people/`, `who/`, `whos-who.html`) | the slots; a person checking |
| Per match: the match as the log saw it + its scoreboard changes | `stats-out/<job>/match.json` | step 1 on staging (recreate the match score by score), step 6 |
| Per match: the exact request body, pictures, heatmaps, collage, slot notes | `stats-out/<job>/api/` (`payload.json`, `upload.json`, `player-*.jpg`, `heat-*.png`, `collage.jpg`, `slots.json`) | steps 4–5 |

Every step writes its own outputs and leaves the earlier ones alone, so any step can be re-run (better team split, fixed slots) without losing what came before. A copy of everything except the video is pulled to the Mac while no court is live (`~/dropshot-stats-work/hello-padel-2026-11-22/`).

## Testing the whole flow on staging (later)

1. Staging needs: a test venue and court ids, its streaming key, a tournament with two test teams of real test logins, and a live match started for them on that court (step 1, via the venue screen or the routes above).
2. Send one saved match: upload its `api/` pictures, fill the link fields, POST `payload.json` with the staging ground/court ids and that live match's `matchId` (the saved times are tonight's, so linking by time won't find a staging match).
3. Check: the record shows up, the test players get the email, each claims their slot, the partner/opponent rules hold, the venue view shows it.
4. Only then: production, without `matchId` (it links to tonight's matches by court and time), knowing it emails the tournament players.

## Sending (box side): `send_stats.mjs`

Run on the box (the Cloudinary login and the venue key are in the streamer's `.env`):

```
cd ~/dropshot-tournament
node send_stats.mjs stats-out/<job> --env-file ~/Documents/drop-shot-streaming-scripts-ubuntu/.env                       # dry run: shows the server, writes api/request-production.json
node send_stats.mjs stats-out/<job> --env-file …/.env --target production --send                                          # numbers + heatmaps
node send_stats.mjs stats-out/<job> --env-file …/.env --target production --send --with-photos                            # + player photo strips and collage
node send_stats.mjs stats-out/<job> --env-file …/.env --target staging --base-url https://<staging> --api-key-env <NAME> --match-id <uuid> --send
```

- Without `--send` nothing leaves the box. `--send` needs an explicit `--target`.
- Production goes only to the `.env`'s `BASE_URL` and refuses a staging host. Staging needs https, its own key (`--api-key-env`) and `--base-url`.
- Staging tests need staging ids: the saved payload carries production venue/court ids; give the staging match with `--match-id` (or an edited copy of the payload).
- Everything sent is written down in `api/sent-<target>.json` before and after it goes out (every attempt, the last good one, each uploaded picture). A resend reuses the uploads and replaces the record. After any send that may have been saved (good, 5xx, no answer), a different match, court or capturedAt is refused without `--new-record` (it would make a second record and email a second set of players). A job not ready to send needs `--force-not-ready`.
- Photos of people only with `--with-photos`; pictures no longer sent are taken down after the next good send; a record refused for good (400/413/422) takes down only the pictures it newly put up.
