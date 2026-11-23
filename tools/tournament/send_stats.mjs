#!/usr/bin/env node
/**
 * Sends one match's saved stats (a stats job's api/ folder) to the backend: pictures to Cloudinary, then the record.
 *
 * ── IN SIMPLE WORDS ──
 * Each finished match on the box has an api/ folder with the exact request the backend's
 * stats route takes (payload.json) and its pictures. This program uploads the pictures,
 * puts their links into the request and sends it, to staging (to test) or production (for
 * real). Without --send it only shows what it would do (server included) and writes the
 * request it would send (api/request-<target>.json); nothing leaves the box. Everything it
 * sends is written down in api/sent-<target>.json as it happens, so a second run reuses the
 * uploaded links and the backend replaces its record instead of keeping two.
 *
 * ── BUSINESS RULES ──
 * - Route: POST <base>/api/v1/padel-grounds/:groundId/courts/:courtId/stats with the
 *   venue's x-streaming-api-key (ds-backend match-stats; on production for Hello Padel
 *   only since 2026-11-23, Farooq).
 * - The first save of a match linked to a tournament match EMAILS its 4 players ("stats
 *   ready"); a casual match emails whoever started the stream; a record linked to no match
 *   emails nobody (match-stats.service.ts notifyReady, read 2026-11-22). The backend replaces
 *   a record only for the same linked match, or (unlinked) the same streamId + capturedAt
 *   (ingest(), production, read 2026-11-23). So --send needs an explicit --target, and after
 *   any send that may have been saved (good, 5xx, no answer, killed), a different match,
 *   court or capturedAt is refused without --new-record: it would make a second record and
 *   email a second set of players.
 * - Photos of people (player strips, the collage) go out only with --with-photos: a
 *   picture of a real person on a public link is a decision, not a default (rule from
 *   MatchStatsOutbox, Hamza 2026-10-23). Heatmaps and numbers always go. Pictures no longer
 *   sent (photos switched off, a slot gone) are taken down after the next good send.
 * - A job not marked ready_to_send (slots.json) is refused unless --force-not-ready.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Picture names carry the target (folder dropshot/match-stats/<ground>/<court>, id
 *   <job>-<target>-<key>, overwrite on): a staging test can never overwrite or delete a
 *   picture a production record shows (review 2026-11-23).
 * - On a final refusal (400/413/422) only pictures this run CREATED are deleted, never
 *   ones it overwrote: those may be shown by a record already saved. Other errors keep
 *   everything for a retry. Deletes clear Cloudinary's cache too (invalidate).
 * - Each upload is written to sent-<target>.json the moment it succeeds, and each send is
 *   written down as "pending" BEFORE it goes out: a run that dies halfway must not leave a
 *   public picture (a face) nothing on the box knows about, nor a saved record it forgot.
 *   The file is written whole (temp file + rename) and only one run per job at a time (lock).
 * - Pictures no longer sent come down only after a good send that REPLACED the previous
 *   record (the backend then clears those links); if it made a new record, the old one may
 *   still show them, so nothing is deleted and the operator is warned (review 2026-11-23).
 * - Redirects are refused: a followed redirect turns the POST into a GET (a fake "saved")
 *   or re-sends the venue key to another host. "Saved" needs a record id in the answer.
 * - Production's server comes only from the box's own .env and must not be a staging
 *   host; staging needs https and its own key named with --api-key-env, so a typo can't
 *   send the venue's production key to some other server.
 *
 * ── DO NOT ──
 * - Don't print the API key or the Cloudinary secret, or write them to any file.
 * - Don't send a whole folder of matches in one burst during play: the venue's upload
 *   line is the streams' first.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_FIELDS = new Set(['playerImageUrls', 'collageUrl']);
const FINAL_REFUSAL = new Set([400, 413, 422]); // the record itself is wrong; anything else may work on a retry

export function readEnv(file) {
  const out = {};
  if (!file) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Cloudinary's signature: the parameters sorted by name, joined, plus the secret, sha1. */
export function cloudinarySign(params, secret) {
  const s = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(s + secret).digest('hex');
}

/** The pictures this send needs: [{field, slot|null, file, key}]. */
export function picturesFor(files, withPhotos) {
  const out = [];
  for (const [field, v] of Object.entries(files ?? {})) {
    if (PHOTO_FIELDS.has(field) && !withPhotos) continue;
    if (typeof v === 'string') out.push({ field, slot: null, file: v, key: field });
    else for (const [slot, f] of Object.entries(v ?? {})) out.push({ field, slot, file: f, key: `${field}-${slot}` });
  }
  return out;
}

/** The request body with the picture links filled in. */
export function fillLinks(payload, pictures, links, matchId) {
  const body = JSON.parse(JSON.stringify(payload));
  for (const p of pictures) {
    const url = links[p.key];
    if (!url) continue;
    if (p.slot === null) body[p.field] = url;
    else body[p.field] = { ...(body[p.field] ?? {}), [p.slot]: url };
  }
  if (matchId) body.matchId = matchId;
  return body;
}

/**
 * Where the record goes, or why not. Production: the .env's BASE_URL only, never a
 * staging host. Staging: an https --base-url that is not the .env's (production) one.
 */
export function resolveTarget({ target, baseUrl, envBase, keyName, keyNameGiven }) {
  const clean = (u) => (u ?? '').replace(/\/+$/, '');
  const origin = (u) => { try { return new URL(u).origin; } catch { return null; } };   // API.x.live:443/ = api.x.live
  let base;
  if (target === 'production') {
    if (!envBase) return { error: 'no BASE_URL in the .env' };
    if (baseUrl && origin(baseUrl) !== origin(envBase)) return { error: 'production only goes to the .env\'s BASE_URL; --base-url is for staging' };
    base = clean(envBase);
  } else {
    if (!baseUrl) return { error: 'staging needs --base-url' };
    if (!keyNameGiven) return { error: 'staging needs --api-key-env NAME (its own key, never the box\'s production key by default)' };
    if (envBase && origin(baseUrl) && origin(baseUrl) === origin(envBase)) return { error: '--base-url is the .env\'s production address, not staging' };
    if (keyName === 'STREAMING_API_KEY') return { error: 'staging needs its own key: STREAMING_API_KEY is the box\'s production key' };
    base = clean(baseUrl);
  }
  let host;
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && !(process.env.SEND_STATS_ALLOW_HTTP === '1' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
      return { error: `the server must be https (${u.protocol}//${u.host})` };
    }
    host = u.host;
  } catch { return { error: `not a web address: ${base}` }; }
  if (target === 'production' && /staging/i.test(host)) return { error: `production but the .env's BASE_URL is a staging server (${host})` };
  return { base, host, keyName };
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function parseArgs(argv) {
  const a = { target: null, send: false, forceNotReady: false, newRecord: false, withPhotos: false, keyName: 'STREAMING_API_KEY', keyNameGiven: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--env-file') a.envFile = v();
    else if (k === '--target') a.target = v();
    else if (k === '--base-url') a.baseUrl = v();
    else if (k === '--api-key-env') { a.keyName = v(); a.keyNameGiven = true; }
    else if (k === '--match-id') a.matchId = v();
    else if (k === '--cloudinary-base') a.cloudBase = v(); // tests only
    else if (k === '--with-photos') a.withPhotos = true;
    else if (k === '--send') a.send = true;
    else if (k === '--force-not-ready') a.forceNotReady = true;
    else if (k === '--new-record') a.newRecord = true;
    else if (!a.job && !k.startsWith('--')) a.job = k;
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.job) throw new Error('usage: send_stats.mjs <job_dir> --env-file .env --target production|staging [--base-url URL --api-key-env NAME] [--match-id UUID] [--with-photos] [--send] [--force-not-ready] [--new-record]');
  if (a.send && !a.target) throw new Error('--send needs --target production or --target staging (production emails real players)');
  a.target ??= 'production';
  if (!['production', 'staging'].includes(a.target)) throw new Error('--target must be production or staging');
  if (a.matchId && !UUID.test(a.matchId)) throw new Error('--match-id must be a UUID');
  return a;
}

async function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }
  const api = path.join(a.job, 'api');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(api, f), 'utf8'));
  let payload, files, slots;
  try { payload = read('payload.json'); files = read('upload.json'); slots = read('slots.json'); } catch (err) {
    console.error(`no saved payload in ${api} (${err.message}): run stats/make_payload.py on this job first`);
    process.exit(2);
  }
  if (!slots.ready_to_send && !a.forceNotReady) {
    console.error(`not ready to send: ${(slots.not_ready_because ?? []).join('; ')} (--force-not-ready only if you know why)`);
    process.exit(3);
  }
  const env = readEnv(a.envFile);
  const t = resolveTarget({ target: a.target, baseUrl: a.baseUrl, envBase: env.BASE_URL, keyName: a.keyName, keyNameGiven: a.keyNameGiven });
  if (t.error) { console.error(t.error); process.exit(2); }
  const url = `${t.base}/api/v1/padel-grounds/${payload.groundId}/courts/${payload.courtId}/stats`;
  const pictures = picturesFor(files, a.withPhotos);
  const sentFile = path.join(api, `sent-${a.target}.json`);
  const ledger = fs.existsSync(sentFile) ? JSON.parse(fs.readFileSync(sentFile, 'utf8')) : {};
  ledger.target = a.target;
  ledger.uploaded ??= {};
  ledger.attempts ??= [];
  const save = () => {
    const tmp = `${sentFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 1)}\n`);
    fs.renameSync(tmp, sentFile); // never half-written, even on a power cut
  };
  const cloud = { name: env.REACT_APP_CLOUDINARY_CLOUD_NAME, key: env.CLOUDINARY_API_KEY, secret: env.CLOUDINARY_API_SECRET };
  const testing = process.env.SEND_STATS_ALLOW_HTTP === '1';
  if (a.cloudBase && !(testing && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(a.cloudBase))) {
    console.error('--cloudinary-base is for the tests on this machine only'); process.exit(2);
  }
  const cloudBase = (a.cloudBase ?? 'https://api.cloudinary.com/v1_1').replace(/\/$/, '');
  const goodLink = (u) => typeof u === 'string' && (u.startsWith('https://res.cloudinary.com/') || (testing && u.startsWith('https://res.example/')));
  const folder = `dropshot/match-stats/${safe(payload.groundId)}/${safe(payload.courtId)}`;
  const jobName = safe(path.basename(path.resolve(a.job)));
  const idFor = (p) => `${jobName}-${a.target}-${p.key}`;

  console.log(`${a.send ? 'SENDING' : 'DRY RUN (nothing leaves the box; add --send to send)'}: ${slots.title ?? jobName}`);
  console.log(`  to ${a.target} at ${t.host}: POST /api/v1/padel-grounds/${payload.groundId}/courts/${payload.courtId}/stats`);
  console.log(`  slots ${Object.entries(payload.stats.players).map(([s, v]) => `${s}=${v.team}`).join(' ')}; capturedAt ${payload.capturedAt}; matchId ${a.matchId ?? 'none (the backend picks the match on that court at capturedAt)'}`);
  console.log(`  pictures: ${pictures.map((p) => p.file).join(', ') || 'none'}${a.withPhotos ? '' : ' (no photos of people: add --with-photos)'}`);
  if (slots.checks?.length) console.log(`  checks: ${slots.checks.join(' | ')}`);
  if (ledger.last_ok) console.log(`  sent before: ${ledger.last_ok.at} -> record ${ledger.last_ok.reply?.id ?? '?'}, match ${ledger.last_ok.reply?.liveMatchId ?? 'none'}`);

  // Any send that may have been saved (good, 5xx, no answer, killed while pending) fixes which
  // record this job is: a different match, court or capturedAt makes a second record and
  // emails a second set of players.
  // only record sends count (a failed picture upload never reached the backend)
  const maybeSaved = ledger.attempts.filter((x) => !x.step && (x.http_status === null || x.http_status === undefined || x.http_status >= 500 || (x.http_status >= 200 && x.http_status < 300)));
  if (maybeSaved.length && !a.newRecord) {
    const mine = { matchId: a.matchId ?? null, courtId: payload.courtId, capturedAt: payload.capturedAt };
    for (const x of maybeSaved) {
      const sameMatch = (x.matchId ?? null) === mine.matchId || (mine.matchId && x.reply?.liveMatchId === mine.matchId);
      if (!sameMatch || (x.courtId && x.courtId !== mine.courtId) || (x.capturedAt && x.capturedAt !== mine.capturedAt)) {
        console.error(`  refused: a send at ${x.at} (${x.http_status ?? 'no answer'}) may have saved this job as matchId ${x.matchId ?? 'none'}, capturedAt ${x.capturedAt ?? '?'}; this one (matchId ${mine.matchId ?? 'none'}, capturedAt ${mine.capturedAt}) would make a second record and email a second set of players (--new-record only if that is really meant)`);
        process.exit(3);
      }
    }
  }

  if (!a.send) {
    const body = fillLinks(payload, pictures, Object.fromEntries(pictures.map((p) => [p.key, `https://res.cloudinary.com/${safe(cloud.name || 'cloud')}/image/upload/${folder}/${idFor(p)}.png`])), a.matchId);
    fs.writeFileSync(path.join(api, `request-${a.target}.json`), `${JSON.stringify(body, null, 1)}\n`);
    console.log(`  wrote ${path.join(api, `request-${a.target}.json`)} (the body it would send, links as placeholders)`);
    return;
  }
  const apiKey = env[a.keyName];
  if (!apiKey) { console.error(`no ${a.keyName} in the .env`); process.exit(2); }
  if (a.target === 'staging' && apiKey === env.STREAMING_API_KEY) { console.error('staging needs its own key: that value is the box\'s production key'); process.exit(2); }
  // one run per job and target at a time: two runs would each write back their own copy of the record
  const lock = path.join(api, `.send-${a.target}.lock`);
  try { fs.closeSync(fs.openSync(lock, 'wx')); } catch {
    console.error(`another send of this job is running (or died: remove ${lock} after checking ${sentFile})`); process.exit(6);
  }
  const unlock = () => { try { fs.unlinkSync(lock); } catch { /* gone */ } };
  process.on('exit', unlock);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  if (pictures.length && !(cloud.name && cloud.key && cloud.secret)) { console.error('Cloudinary login missing in the .env'); process.exit(2); }

  const destroy = async (publicId) => {
    const params = { invalidate: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append('api_key', cloud.key);
    form.append('signature', cloudinarySign(params, cloud.secret));
    try {
      const d = await fetch(`${cloudBase}/${cloud.name}/image/destroy`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
      const out = await d.json().catch(() => ({}));
      return d.ok && ['ok', 'not found'].includes(out.result);
    } catch { return false; }
  };

  // 1. pictures: reuse a link from an earlier send of the same file, upload the rest; note each one at once
  const links = {};
  const created = []; // keys this run uploaded that no earlier send had
  for (const p of pictures) {
    const full = path.join(api, p.file);
    const hash = sha256(full);
    const old = ledger.uploaded[p.key];
    if (old?.sha256 === hash && old.url && !old.delete_pending) { links[p.key] = old.url; continue; }
    const params = { folder, overwrite: 'true', public_id: idFor(p), timestamp: String(Math.floor(Date.now() / 1000)) };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append('api_key', cloud.key);
    form.append('signature', cloudinarySign(params, cloud.secret));
    form.append('file', new Blob([fs.readFileSync(full)]), p.file);
    let res, out;
    try {
      res = await fetch(`${cloudBase}/${cloud.name}/image/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      out = await res.json().catch(() => ({}));
    } catch (err) {
      ledger.attempts.push({ at: new Date().toISOString(), step: `upload ${p.file}`, error: err.message });
      save();
      console.error(`  picture ${p.file}: upload failed (${err.message}); what did upload is written down in ${sentFile}`);
      process.exit(4);
    }
    if (!res.ok || !goodLink(out.secure_url)) {
      ledger.attempts.push({ at: new Date().toISOString(), step: `upload ${p.file}`, http_status: res.status, error: out.error?.message ?? null });
      save();
      console.error(`  picture ${p.file}: upload failed (HTTP ${res.status} ${out.error?.message ?? ''}); what did upload is written down in ${sentFile}`);
      process.exit(4);
    }
    if (!old && !out.overwritten) created.push(p.key); // Cloudinary says when it replaced a picture someone may show
    links[p.key] = out.secure_url;
    ledger.uploaded[p.key] = { url: out.secure_url, public_id: out.public_id, sha256: hash, at: new Date().toISOString() };
    save();
    console.log(`  uploaded ${p.file}`);
  }

  // 2. the record
  const body = fillLinks(payload, pictures, links, a.matchId);
  fs.writeFileSync(path.join(api, `request-${a.target}.json`), `${JSON.stringify(body, null, 1)}\n`);
  // written down BEFORE it goes out: if the run dies now, the box still knows a record may exist
  const attempt = { at: new Date().toISOString(), host: t.host, http_status: null, reply: null, error: 'pending (no answer recorded)',
    matchId: a.matchId ?? null, courtId: payload.courtId, capturedAt: payload.capturedAt, streamId: payload.streamId, photos: a.withPhotos };
  ledger.attempts.push(attempt);
  save();
  const previous = ledger.last_ok ?? null;
  let res = null;
  let reply = null;
  try {
    res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-streaming-api-key': apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    const text = await res.text();
    try { reply = JSON.parse(text); } catch { reply = { raw: text.slice(0, 500) }; }
    attempt.error = null;
  } catch (err) { attempt.error = err.message; }
  attempt.http_status = res?.status ?? null;
  attempt.reply = reply;
  const saved = Boolean(res?.ok && reply?.id);
  if (saved) ledger.last_ok = attempt;
  save(); // the answer is on disk before anything is deleted

  if (saved) {
    // Pictures no longer part of the record come down only if the backend REPLACED the record
    // we sent before (it then cleared those links). A new record means the old one may still show them.
    const sameRecord = !previous || (reply.replaced === true && (!previous.reply?.id || previous.reply.id === reply.id));
    const keep = new Set(pictures.map((p) => p.key));
    const extra = Object.keys(ledger.uploaded).filter((k) => !keep.has(k));
    if (extra.length && !sameRecord) {
      console.error(`  WARNING: the backend made a NEW record (${reply.id}) instead of replacing ${previous.reply?.id ?? 'the earlier one'}; left up: ${extra.join(', ')}`);
    } else {
      for (const key of extra) {
        if (await destroy(ledger.uploaded[key].public_id)) { delete ledger.uploaded[key]; console.log(`  took down ${key} (no longer sent)`); }
        else { ledger.uploaded[key].delete_pending = true; console.error(`  could not take down ${key}; still listed in ${sentFile}`); }
        save();
      }
    }
    console.log(`  SAVED: record ${reply.id}, linked match ${reply.liveMatchId ?? 'none'}, ${reply.replaced ? 'replaced an earlier record' : 'new record'}`);
    console.log(`  written down in ${sentFile}`);
    return;
  }
  const res2xxNoId = res?.ok && !reply?.id;
  if (res && FINAL_REFUSAL.has(res.status)) {
    // the record itself is wrong: take down only what this run newly put up (an overwritten
    // picture may be shown by a record saved before, so it stays)
    for (const key of created) {
      if (await destroy(ledger.uploaded[key].public_id)) delete ledger.uploaded[key];
      else ledger.uploaded[key].delete_pending = true;
      save();
    }
  }
  const maybe = !res || res.status >= 500 || res2xxNoId;
  console.error(`  NOT SAVED${maybe ? ' (MAYBE SAVED: check the backend before resending)' : ''}: ${res ? `HTTP ${res.status} ${reply?.message ?? reply?.raw ?? ''}` : `no answer (${attempt.error})`}`);
  console.error(`  written down in ${sentFile}`);
  process.exit(5);
}

// a command-line tool: argv[1] only (a pm2-started parent's pm_exec_path must not hide it)
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && pathToFileURL(real(process.argv[1])).href === pathToFileURL(real(fileURLToPath(import.meta.url))).href) {
  main().catch((err) => { console.error(`failed: ${err.message}`); process.exit(1); });
}
