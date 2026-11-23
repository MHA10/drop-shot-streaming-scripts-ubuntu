// Tests for send_stats.mjs against a fake backend and a fake Cloudinary (node --test send_stats.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudinarySign, picturesFor, fillLinks, resolveTarget } from './send_stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'send-stats-'));
const SECRET = 'cloud-secret-xyz';
const BOX_KEY = 'box-key-123';
const GROUND = '11111111-2222-3333-4444-555555555555';
const COURT = 'a7139753-436c-4a37-8b54-292606e1eba4';
const M1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeJob(name, { ready = true } = {}) {
  const api = path.join(tmp, name, 'api');
  fs.mkdirSync(api, { recursive: true });
  const players = Object.fromEntries(['A', 'B', 'C', 'D'].map((s, i) => [s, { team: i < 2 ? 'far' : 'near', distance_m: 100 + i }]));
  fs.writeFileSync(path.join(api, 'payload.json'), JSON.stringify({
    schemaVersion: 1, groundId: GROUND, courtId: COURT, matchId: null, streamId: `dropshot-box:${name}`,
    capturedAt: '2026-11-22T15:33:45Z', heatmapUrl: null, heatmapUrls: null, collageUrl: null, playerImageUrls: null,
    stats: { source: 'dropshot-tournament-box', duration_s: 140, players, teams: { far: { players: ['A', 'B'] }, near: { players: ['C', 'D'] } } },
  }));
  const files = { playerImageUrls: {}, heatmapUrls: {}, collageUrl: 'collage.jpg' };
  for (const s of ['A', 'B', 'C', 'D']) {
    fs.writeFileSync(path.join(api, `player-${s}.jpg`), `photo ${s}`);
    fs.writeFileSync(path.join(api, `heat-${s}.png`), `heat ${s}`);
    files.playerImageUrls[s] = `player-${s}.jpg`;
    files.heatmapUrls[s] = `heat-${s}.png`;
  }
  fs.writeFileSync(path.join(api, 'collage.jpg'), 'collage');
  fs.writeFileSync(path.join(api, 'upload.json'), JSON.stringify(files));
  fs.writeFileSync(path.join(api, 'slots.json'), JSON.stringify({ title: name, checks: [], ready_to_send: ready, not_ready_because: ready ? [] : ['a whole recording'] }));
  return path.join(tmp, name);
}

// ---- fake backend + fake Cloudinary (one port) ----
const seen = { uploads: [], destroys: [], posts: [] };
let backendStatus = 200;
let backendReply = null; // e.g. a new record instead of a replacement
let backendRedirect = false;
let failUploadNo = 0; // the n-th upload from now fails (0 = none)
const fields = (body) => Object.fromEntries([...body.matchAll(/name="([^"]+)"(?:; filename="[^"]*")?\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([^\r]*)/g)].map((m) => [m[1], m[2]]));
const signedOk = (f) => {
  const params = Object.fromEntries(Object.entries(f).filter(([k]) => !['file', 'api_key', 'signature'].includes(k)));
  return f.api_key === 'ck-1' && f.signature === cloudinarySign(params, SECRET); // every field sent must be signed
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const f = fields(body);
    if (req.url.includes('/image/upload')) {
      seen.uploads.push(f);
      if (failUploadNo && --failUploadNo === 0) { res.writeHead(500); res.end('{"error":{"message":"boom"}}'); return; }
      const ok = signedOk(f);
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { secure_url: `https://res.example/${f.folder}/${f.public_id}.png`, public_id: `${f.folder}/${f.public_id}` } : { error: { message: 'Invalid Signature' } }));
    } else if (req.url.includes('/image/destroy')) {
      const ok = signedOk(f) && f.invalidate === 'true';
      seen.destroys.push({ id: f.public_id, ok });
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { result: 'ok' } : { error: { message: 'Invalid Signature' } }));
    } else {
      seen.posts.push({ url: req.url, key: req.headers['x-streaming-api-key'], body: body ? JSON.parse(body) : null });
      if (backendRedirect) { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
      res.writeHead(backendStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(backendReply ?? (backendStatus === 200 ? { id: 'rec-1', liveMatchId: null, replaced: seen.posts.length > 1 } : { message: 'refused' })));
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const mkEnv = (name, base) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, [`BASE_URL=${base}`, `STREAMING_API_KEY=${BOX_KEY}`, 'STAGING_KEY=staging-key-9', 'REACT_APP_CLOUDINARY_CLOUD_NAME=demo',
    'CLOUDINARY_API_KEY=ck-1', `CLOUDINARY_API_SECRET=${SECRET}`].join('\n'));
  return f;
};
const envFile = mkEnv('.env', `http://127.0.0.1:${PORT}`);
const deadEnv = mkEnv('dead.env', 'http://127.0.0.1:9'); // nothing listens: a dropped connection
const run = (args, env = envFile) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(HERE, 'send_stats.mjs'), ...args, '--env-file', env, '--cloudinary-base', `http://127.0.0.1:${PORT}`],
    { env: { ...process.env, SEND_STATS_ALLOW_HTTP: '1' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ code, out }));
});
const sentOf = (job, target = 'production') => JSON.parse(fs.readFileSync(path.join(job, 'api', `sent-${target}.json`), 'utf8'));
const noSecrets = (job, out = '') => {
  for (const f of fs.readdirSync(path.join(job, 'api')).filter((n) => /^(sent|request)-/.test(n))) {
    const t = fs.readFileSync(path.join(job, 'api', f), 'utf8');
    assert.ok(!t.includes(BOX_KEY) && !t.includes(SECRET) && !t.includes('staging-key-9'), `a secret in ${f}`);
  }
  assert.ok(!out.includes(BOX_KEY) && !out.includes(SECRET) && !out.includes('staging-key-9'), 'a secret was printed');
};
test.after(() => server.close());

test('pure parts: pictures, links, signature, where it may send', () => {
  const files = { playerImageUrls: { A: 'p.jpg' }, heatmapUrls: { A: 'h.png' }, collageUrl: 'c.jpg' };
  assert.deepEqual(picturesFor(files, false).map((p) => p.key), ['heatmapUrls-A'], 'no photos of people unless asked');
  assert.deepEqual(picturesFor(files, true).map((p) => p.key).sort(), ['collageUrl', 'heatmapUrls-A', 'playerImageUrls-A']);
  const body = fillLinks({ heatmapUrls: null, collageUrl: null, matchId: null }, picturesFor(files, true), { 'heatmapUrls-A': 'https://x/h', collageUrl: 'https://x/c' }, 'm-1');
  assert.deepEqual(body, { heatmapUrls: { A: 'https://x/h' }, collageUrl: 'https://x/c', matchId: 'm-1' });
  // Cloudinary's documented example: sorted params + secret, sha1
  assert.equal(cloudinarySign({ timestamp: '1315060510', public_id: 'sample_image', eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' }, 'abcd'),
    'bfd09f95f331f558cbd1320e67aa8d488770583e');
  const prod = 'https://api.drop-shot.live';
  assert.equal(resolveTarget({ target: 'production', envBase: prod }).host, 'api.drop-shot.live');
  assert.match(resolveTarget({ target: 'production', envBase: 'https://api.staging.drop-shot.live' }).error, /staging server/);
  assert.match(resolveTarget({ target: 'production', envBase: prod, baseUrl: 'https://api.staging.drop-shot.live' }).error, /only goes to the .env/);
  assert.match(resolveTarget({ target: 'staging', envBase: prod, baseUrl: 'https://api.staging.drop-shot.live' }).error, /needs --api-key-env/);
  assert.match(resolveTarget({ target: 'staging', envBase: prod, baseUrl: prod, keyNameGiven: true }).error, /production address/);
  assert.match(resolveTarget({ target: 'staging', envBase: prod, baseUrl: 'http://api.staging.drop-shot.live', keyNameGiven: true }).error, /must be https/);
  assert.match(resolveTarget({ target: 'staging', envBase: prod, baseUrl: 'api.staging.drop-shot.live', keyNameGiven: true }).error, /not a web address/);
  assert.equal(resolveTarget({ target: 'staging', envBase: prod, baseUrl: 'https://api.staging.drop-shot.live/', keyNameGiven: true, keyName: 'STAGING_KEY' }).host, 'api.staging.drop-shot.live');
  // the same server written differently is still production
  assert.match(resolveTarget({ target: 'staging', envBase: prod, baseUrl: 'https://API.drop-shot.live:443/', keyNameGiven: true, keyName: 'STAGING_KEY' }).error, /production address/);
  assert.equal(resolveTarget({ target: 'production', envBase: prod, baseUrl: 'https://API.drop-shot.live:443' }).host, 'api.drop-shot.live');
  assert.match(resolveTarget({ target: 'staging', envBase: prod, baseUrl: 'https://api.staging.drop-shot.live', keyNameGiven: true, keyName: 'STREAMING_API_KEY' }).error, /own key/);
});

test('a dry run sends nothing, names the server, writes the body; --send needs a target', async () => {
  const job = makeJob('court1-20261122-203300');
  const { code, out } = await run([job]);
  assert.equal(code, 0, out);
  assert.match(out, /DRY RUN/);
  assert.match(out, /to production at 127\.0\.0\.1:\d+/);
  assert.equal(seen.uploads.length + seen.posts.length, 0, 'a dry run touched the network');
  const body = JSON.parse(fs.readFileSync(path.join(job, 'api', 'request-production.json'), 'utf8'));
  assert.ok(body.heatmapUrls.A && body.playerImageUrls === null && body.collageUrl === null, 'no photo links without --with-photos');
  noSecrets(job, out);
  const noTarget = await run([job, '--send']);
  assert.equal(noTarget.code, 2);
  assert.match(noTarget.out, /--send needs --target/);
  assert.equal(seen.uploads.length + seen.posts.length, 0);
});

test('sending, resending, photos on then off, and a changed match refused', async () => {
  const job = makeJob('court1-20261122-210000');
  const n0 = seen.uploads.length;
  const { code, out } = await run([job, '--target', 'production', '--send']);
  assert.equal(code, 0, out);
  const ups = seen.uploads.slice(n0);
  assert.equal(ups.length, 4, 'only the 4 heatmaps (no photos)');
  assert.ok(ups.every((u) => signedOk(u) && u.overwrite === 'true' && u.folder === `dropshot/match-stats/${GROUND}/${COURT}`));
  assert.deepEqual(ups.map((u) => u.public_id).sort(), ['A', 'B', 'C', 'D'].map((s) => `court1-20261122-210000-production-heatmapUrls-${s}`));
  const post = seen.posts.at(-1);
  assert.equal(post.url, `/api/v1/padel-grounds/${GROUND}/courts/${COURT}/stats`);
  assert.equal(post.key, BOX_KEY);
  assert.equal(post.body.playerImageUrls, null);
  assert.equal(sentOf(job).last_ok.reply.id, 'rec-1');
  // again: no new uploads, same links
  const again = await run([job, '--target', 'production', '--send']);
  assert.equal(again.code, 0, again.out);
  assert.equal(seen.uploads.length - n0, 4, 'a resend uploaded the same pictures again');
  assert.deepEqual(seen.posts.at(-1).body.heatmapUrls, post.body.heatmapUrls);
  // photos on: strips + collage go; photos off again: they come down
  const on = await run([job, '--target', 'production', '--send', '--with-photos']);
  assert.equal(on.code, 0, on.out);
  assert.equal(seen.uploads.length - n0, 9);
  assert.match(seen.posts.at(-1).body.playerImageUrls.A, /production-playerImageUrls-A/);
  const d0 = seen.destroys.length;
  const off = await run([job, '--target', 'production', '--send']);
  assert.equal(off.code, 0, off.out);
  assert.equal(seen.destroys.length - d0, 5, 'photos switched off were left up');
  assert.ok(seen.destroys.slice(d0).every((d) => d.ok), 'a delete was not signed right (invalidate included)');
  assert.deepEqual(Object.keys(sentOf(job).uploaded).sort(), ['A', 'B', 'C', 'D'].map((s) => `heatmapUrls-${s}`));
  // a different match than the last good send: refused before any network call
  const p0 = seen.posts.length;
  const changed = await run([job, '--target', 'production', '--send', '--match-id', M1]);
  assert.equal(changed.code, 3);
  assert.match(changed.out, /second record and email a second set of players/);
  assert.equal(seen.posts.length, p0);
  assert.equal(sentOf(job).attempts.filter((x) => x.http_status === 200).length, 4, 'earlier sends forgotten');
  noSecrets(job, changed.out);
});

test('a refused resend never deletes a picture a saved record shows; a refused first send takes its own down', async () => {
  // saved once, then a picture changes and the backend refuses the resend for good
  const job = makeJob('court2-20261122-220000');
  assert.equal((await run([job, '--target', 'production', '--send'])).code, 0);
  fs.writeFileSync(path.join(job, 'api', 'heat-A.png'), 'heat A, new');
  backendStatus = 400;
  const d0 = seen.destroys.length;
  const u0 = seen.uploads.length;
  const refused = await run([job, '--target', 'production', '--send']);
  backendStatus = 200;
  assert.equal(refused.code, 5, refused.out);
  assert.deepEqual(seen.uploads.slice(u0).map((u) => u.public_id), ['court2-20261122-220000-production-heatmapUrls-A'], 'the changed picture was not uploaded again');
  assert.equal(seen.destroys.length - d0, 0, 'deleted a picture the saved record shows');
  assert.ok(sentOf(job).uploaded['heatmapUrls-A'] && sentOf(job).last_ok, 'the saved record was forgotten');

  // never saved, refused for good: what it put up comes down, signed right
  const job2 = makeJob('court2-20261122-230000');
  backendStatus = 422;
  const d1 = seen.destroys.length;
  const first = await run([job2, '--target', 'production', '--send']);
  backendStatus = 200;
  assert.equal(first.code, 5, first.out);
  assert.equal(seen.destroys.length - d1, 4);
  assert.ok(seen.destroys.slice(d1).every((d) => d.ok));
  assert.deepEqual(sentOf(job2).uploaded, {});

  // a 404 may be a setting: kept for a retry, nothing deleted
  const job3 = makeJob('court2-20261122-231500');
  backendStatus = 404;
  const d2 = seen.destroys.length;
  assert.equal((await run([job3, '--target', 'production', '--send'])).code, 5);
  backendStatus = 200;
  assert.equal(seen.destroys.length - d2, 0);
  assert.equal(Object.keys(sentOf(job3).uploaded).length, 4);
});

test('a run that dies halfway still writes down what it put up', async () => {
  // the 3rd upload fails: the first 2 are listed
  const job = makeJob('court1-20261123-100000');
  failUploadNo = 3;
  const { code, out } = await run([job, '--target', 'production', '--send']);
  failUploadNo = 0;
  assert.equal(code, 4, out);
  assert.equal(Object.keys(sentOf(job).uploaded).length, 2);
  assert.match(sentOf(job).attempts.at(-1).step, /upload/);
  // the backend can't be reached: the pictures and the failed try are written down
  const job2 = makeJob('court1-20261123-110000');
  const dead = await run([job2, '--target', 'production', '--send'], deadEnv);
  assert.equal(dead.code, 5, dead.out);
  assert.match(dead.out, /MAYBE SAVED: check the backend before resending\): no answer/);
  assert.equal(Object.keys(sentOf(job2).uploaded).length, 4);
  assert.equal(sentOf(job2).attempts.at(-1).http_status, null);
  assert.ok(sentOf(job2).attempts.at(-1).error);
  noSecrets(job2, dead.out);
  // not ready: refused
  const rec = makeJob('court2-20261122-rec', { ready: false });
  const notReady = await run([rec, '--target', 'production', '--send']);
  assert.equal(notReady.code, 3);
  assert.match(notReady.out, /not ready to send: a whole recording/);
});

test('a send that may have been saved (no answer, 5xx) still blocks a second record; new records and redirects delete nothing', async () => {
  // no answer: the attempt is written down as maybe-saved, a different match is then refused
  const job = makeJob('court1-20261123-120000');
  const dead = await run([job, '--target', 'production', '--send'], deadEnv);
  assert.equal(dead.code, 5, dead.out);
  assert.match(dead.out, /MAYBE SAVED/);
  const changed = await run([job, '--target', 'production', '--send', '--match-id', M1]);
  assert.equal(changed.code, 3, changed.out);
  assert.match(changed.out, /may have saved this job/);
  // a 5xx answer counts as maybe-saved too
  const job2 = makeJob('court1-20261123-121000');
  backendStatus = 503;
  const five = await run([job2, '--target', 'production', '--send']);
  backendStatus = 200;
  assert.equal(five.code, 5);
  assert.match(five.out, /MAYBE SAVED/);
  assert.equal((await run([job2, '--target', 'production', '--send', '--match-id', M1])).code, 3);
  // --force-not-ready does not also allow a second record; --new-record does
  assert.equal((await run([job2, '--target', 'production', '--send', '--match-id', M1, '--force-not-ready'])).code, 3);
  assert.equal((await run([job2, '--target', 'production', '--send', '--match-id', M1, '--new-record'])).code, 0);

  // mixed: the first send got no answer (pictures listed, nothing saved for sure), the resend adds
  // photos and changes heat-A, and is refused for good: only the newly added photos come down
  const job3 = makeJob('court1-20261123-130000');
  assert.equal((await run([job3, '--target', 'production', '--send'], deadEnv)).code, 5);
  fs.writeFileSync(path.join(job3, 'api', 'heat-A.png'), 'heat A, changed');
  backendStatus = 400;
  const d0 = seen.destroys.length;
  const mixed = await run([job3, '--target', 'production', '--send', '--with-photos']);
  backendStatus = 200;
  assert.equal(mixed.code, 5, mixed.out);
  const gone = seen.destroys.slice(d0).map((d) => d.id);
  assert.equal(gone.length, 5, gone.join(' '));
  assert.ok(gone.every((id) => /playerImageUrls|collageUrl/.test(id)), 'a heatmap (maybe shown by a saved record) was deleted');

  // the backend made a NEW record instead of replacing: photos switched off are left up, with a warning
  const job4 = makeJob('court1-20261123-140000');
  assert.equal((await run([job4, '--target', 'production', '--send', '--with-photos'])).code, 0);
  backendReply = { id: 'rec-2', liveMatchId: null, replaced: false };
  const d1 = seen.destroys.length;
  const newRec = await run([job4, '--target', 'production', '--send']);
  backendReply = null;
  assert.equal(newRec.code, 0, newRec.out);
  assert.match(newRec.out, /made a NEW record/);
  assert.equal(seen.destroys.length - d1, 0, 'deleted photos the first record may still show');

  // a redirect is not followed: nothing saved, nothing deleted
  const job5 = makeJob('court1-20261123-150000');
  backendRedirect = true;
  const d2 = seen.destroys.length;
  const redir = await run([job5, '--target', 'production', '--send']);
  backendRedirect = false;
  assert.equal(redir.code, 5, redir.out);
  assert.equal(sentOf(job5).last_ok, undefined);
  assert.equal(seen.destroys.length - d2, 0);
  noSecrets(job5, redir.out);
});
