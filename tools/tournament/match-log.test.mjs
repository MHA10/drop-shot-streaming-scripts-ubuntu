// Tests for match-log.mjs. Run: node --test tools/tournament/match-log.test.mjs
// The last test runs the real program against a stand-in Supabase (HTTP + the
// realtime WebSocket) on 127.0.0.1, using the repo's `ws` package for the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { deriveMatches, matchesText, isoLocal } from './match-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const C1 = 'a7139753-436c-4a37-8b54-292606e1eba4';
const T0 = new Date(2026, 10, 22, 18, 0, 0).getTime(); // 18:00 box time
const at = (h, m, s = 0) => T0 + ((h - 18) * 3600 + m * 60 + s) * 1000;
const row = (ms, red, blue, rs = '0', bs = '0', rg = '0', bg = '0', mode = 'standard') =>
  ({ ms, kind: 'ROW', court: 'court1', court_id: C1, red_team: red, blue_team: blue,
     red_score: rs, blue_score: bs, red_games: rg, blue_games: bg, mode });
const hm = (iso) => iso && iso.slice(11, 19);

test('a normal evening: names, play, next match', () => {
  const ev = [
    { ms: at(17, 59), kind: 'START' },
    row(at(17, 59, 30), null, null),
    row(at(18, 0, 5), 'HASSAN & ALI', 'OMAR & BILAL'),
    row(at(18, 2, 40), 'HASSAN & ALI', 'OMAR & BILAL', '15', '00'),
    row(at(18, 30), 'HASSAN & ALI', 'OMAR & BILAL', '30', '15', '3', '2'),
    row(at(18, 51, 10), 'HASSAN & ALI', 'OMAR & BILAL', '00', '00', '6', '4'),
    row(at(18, 58, 30), 'ZAIN & SAAD', 'ALI & UMAR'),
    row(at(19, 0, 15), 'ZAIN & SAAD', 'ALI & UMAR', '15', '00'),
  ];
  const m = deriveMatches(ev, at(19, 5));
  assert.equal(m.length, 2);
  assert.equal(hm(m[0].start), '18:02:40');
  assert.equal(hm(m[0].end), '18:52:10');
  assert.equal(m[0].red_team, 'HASSAN & ALI');
  assert.equal(m[0].final.red_games, '6');
  assert.deepEqual(m[0].checks, []);
  assert.equal(hm(m[1].start), '19:00:15');
  assert.equal(m[1].playing, true);
  assert.equal(m[1].end, null);
});

test('a name typo fixed within 2 minutes is the same match', () => {
  const ev = [
    row(at(18, 0), null, null),
    row(at(18, 1), 'HASAN & ALI', 'OMAR & BILAL'),
    row(at(18, 1, 40), 'HASSAN & ALI', 'OMAR & BILAL'),
    row(at(18, 3), 'HASSAN & ALI', 'OMAR & BILAL', '15', '00'),
  ];
  const m = deriveMatches(ev, at(18, 4));
  assert.equal(m.length, 1);
  assert.equal(m[0].red_team, 'HASSAN & ALI');
  assert.ok(m[0].notes.some((n) => /corrected/.test(n)));
});

test('a new set after a short break stays in the same match', () => {
  const ev = [
    row(at(18, 0), 'A', 'B'),
    row(at(18, 1), 'A', 'B', '15', '00'),
    row(at(18, 40), 'A', 'B', '00', '00', '6', '4'),
    row(at(18, 41), 'A', 'B', '00', '00', '0', '0'),
    row(at(18, 42), 'A', 'B', '15', '00', '0', '0'),
  ];
  const m = deriveMatches(ev, at(18, 43));
  assert.equal(m.length, 1);
});

test('same teams again after a long pause = a new match, marked check', () => {
  const ev = [
    row(at(18, 0), 'A', 'B'),
    row(at(18, 1), 'A', 'B', '15', '00'),
    row(at(18, 40), 'A', 'B', '00', '00', '6', '4'),
    row(at(18, 48), 'A', 'B'),
    row(at(18, 50), 'A', 'B', '15', '00'),
  ];
  const m = deriveMatches(ev, at(18, 51));
  assert.equal(m.length, 2);
  assert.equal(hm(m[0].end), '18:41:00');
  assert.equal(hm(m[1].start), '18:50:00');
  assert.ok(m[1].checks.some((c) => /guessed/.test(c)));
});

test('no names at all: a match from the score, marked check', () => {
  const ev = [row(at(18, 0), null, null), row(at(18, 5), null, null, '15', '00')];
  const m = deriveMatches(ev, at(18, 6));
  assert.equal(m.length, 1);
  assert.ok(m[0].checks.includes('no team names'));
});

test('names set just after play started belong to that match', () => {
  const ev = [
    row(at(18, 0), null, null),
    row(at(18, 5), null, null, '15', '00'),
    row(at(18, 7), 'A', 'B', '15', '00'),
    row(at(18, 8), 'A', 'B', '30', '00'),
  ];
  const m = deriveMatches(ev, at(18, 9));
  assert.equal(m.length, 1);
  assert.equal(m[0].red_team, 'A');
  assert.ok(!m[0].checks.includes('no team names'));
});

test('the log starting mid-match says so', () => {
  const m = deriveMatches([row(at(18, 20), 'A', 'B', '30', '15', '2', '1')], at(18, 21));
  assert.equal(m.length, 1);
  assert.ok(m[0].checks.some((c) => /started during this match/.test(c)));
});

test('a connection gap during a match is flagged; a restart does not split the match', () => {
  const ev = [
    { ms: at(18, 0), kind: 'START' },
    row(at(18, 0, 1), 'A', 'B'),
    row(at(18, 1), 'A', 'B', '15', '00'),
    { ms: at(18, 10), kind: 'LOST' },
    { ms: at(18, 12), kind: 'LIVE' },
    row(at(18, 12, 1), 'A', 'B', '30', '00', '1', '0'),
    { ms: at(18, 20), kind: 'STOP' },
    { ms: at(18, 20, 30), kind: 'START' },
    row(at(18, 25), 'A', 'B', '40', '00', '2', '0'),
  ];
  const m = deriveMatches(ev, at(18, 26));
  assert.equal(m.length, 1);
  assert.ok(m[0].checks.some((c) => /not listening 18:10:00–18:12:00/.test(c)), m[0].checks.join(' | '));
});

test('the last match of the day ends by its last point', () => {
  const ev = [row(at(18, 0), 'A', 'B'), row(at(18, 1), 'A', 'B', '15', '00'), row(at(18, 50), 'A', 'B', '00', '00', '6', '2')];
  const m = deriveMatches(ev, at(19, 30));
  assert.equal(m[0].playing, false);
  assert.equal(hm(m[0].end), '18:51:00');
  assert.ok(m[0].checks.some((c) => /no next match/.test(c)));
});

test('no "ended" guess while the Supabase connection is down', () => {
  const ev = [row(at(18, 0), 'A', 'B'), row(at(18, 1), 'A', 'B', '15', '00'), { ms: at(18, 5), kind: 'LOST' }];
  const m = deriveMatches(ev, at(18, 40));
  assert.equal(m[0].playing, true);
  assert.ok(m[0].checks.some((c) => /not listening 18:05:00–now/.test(c)));
});

test('names cleared closes the match; matches.txt reads well', () => {
  const ev = [row(at(18, 0), 'A', 'B'), row(at(18, 1), 'A', 'B', '15', '00'), row(at(18, 30), null, null, '15', '00')];
  const m = deriveMatches(ev, at(18, 31));
  assert.equal(m.length, 1);
  assert.equal(hm(m[0].end), '18:02:00');
  const txt = matchesText(m, at(18, 31));
  assert.match(txt, /court1/);
  assert.match(txt, /"A" \(red\) vs "B" \(blue\)/);
});

test('Americano: the score going down after a long pause is a new match', () => {
  const ev = [
    row(at(18, 0), 'A', 'B', '0', '0', '|', '|', 'americano'),
    row(at(18, 1), 'A', 'B', '3', '1', '|', '|', 'americano'),
    row(at(18, 30), 'A', 'B', '21', '17', '|', '|', 'americano'),
    row(at(18, 40), 'A', 'B', '1', '0', '|', '|', 'americano'),
  ];
  const m = deriveMatches(ev, at(18, 41));
  assert.equal(m.length, 2);
});

// ---- the real program against a stand-in Supabase ----------------------------

test('end to end: pushed changes, a dropped connection, the catch-up read', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'match-log-'));
  let rows = [{ court_id: C1, red_team: 'HASSAN & ALI', blue_team: 'OMAR & BILAL', red_score: '00', blue_score: '00', red_games: '0', blue_games: '0', mode: 'standard' }];
  const reads = [];
  const server = http.createServer((req, res) => {
    reads.push({ url: req.url, key: req.headers.apikey });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(rows));
  });
  const wss = new WebSocketServer({ server, path: '/realtime/v1/websocket' });
  const sockets = [];
  const joins = [];
  wss.on('connection', (ws, req) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'phx_join') {
        joins.push({ url: req.url, payload: msg.payload });
        ws.send(JSON.stringify({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: { postgres_changes: [] } } }));
        setTimeout(() => ws.send(JSON.stringify({ topic: msg.topic, event: 'system', ref: null,
          payload: { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: 'match-log' } })), 100);
      } else if (msg.event === 'heartbeat') {
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const push = (rec) => {
    for (const ws of sockets) if (ws.readyState === 1) {
      ws.send(JSON.stringify({ topic: 'realtime:match-log', event: 'postgres_changes', ref: null,
        payload: { ids: [1], data: { type: 'UPDATE', schema: 'public', table: 'score_board', commit_timestamp: 'x', record: rec } } }));
    }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const child = spawn(process.execPath, [path.join(HERE, 'match-log.mjs'), '--court', `court1=${C1}`, '--out', out, '--for', '7'],
    { env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_ANON_KEY: 'test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stdout += d; });

  await wait(1200);                                   // joined + first read
  rows = [{ ...rows[0], red_score: '15' }];
  push(rows[0]);                                      // a point, pushed
  await wait(400);
  push({ ...rows[0], court_id: 'ffffffff-0000-0000-0000-000000000000' }); // another court: ignored
  await wait(300);
  for (const ws of sockets) ws.terminate();          // the connection drops...
  rows = [{ ...rows[0], red_score: '30' }];          // ...and a point happens meanwhile
  await wait(2500);                                   // reconnect after 1 s, catch-up read
  rows = [{ ...rows[0], red_score: '40' }];
  push(rows[0]);
  const code = await new Promise((r) => child.on('exit', r));
  await new Promise((r) => { wss.close(); server.close(r); });

  assert.equal(code, 0, stdout);
  const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.kind + (e.how ? `:${e.how}` : '') + (e.red_score ? `:${e.red_score}` : ''));
  assert.deepEqual(kinds.filter((k) => k.startsWith('ROW')), ['ROW:read:00', 'ROW:push:15', 'ROW:read:30', 'ROW:push:40'], kinds.join(' '));
  assert.equal(kinds.filter((k) => k === 'LIVE').length, 2);
  assert.equal(kinds.filter((k) => k === 'LOST').length, 1);
  assert.equal(events.at(-1).kind, 'STOP');
  assert.ok(reads.every((r) => r.key === 'test-key'));
  assert.ok(reads.every((r) => r.url.includes(`court_id=in.(${C1})`)));
  assert.equal(joins[0].payload.config.postgres_changes[0].filter, `court_id=eq.${C1}`);
  assert.ok(joins[0].url.includes('vsn=1.0.0'));
  assert.ok(!stdout.includes('test-key'), 'the key must never be printed');
  const matches = JSON.parse(fs.readFileSync(path.join(out, 'matches.json'), 'utf8'));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].red_team, 'HASSAN & ALI');
  assert.equal(matches[0].final.red_score, '40');
  assert.ok(matches[0].checks.some((c) => /not listening/.test(c)));
  assert.match(fs.readFileSync(path.join(out, 'matches.txt'), 'utf8'), /HASSAN & ALI/);
  const hist = fs.readFileSync(path.join(out, 'history.txt'), 'utf8');
  assert.match(hist, /court1  next match set up: "HASSAN & ALI" \(red\) vs "OMAR & BILAL" \(blue\)/);
  assert.match(hist, /court1  MATCH 1 STARTED at \d\d:\d\d:\d\d: "HASSAN & ALI"/);
  assert.match(hist, /Supabase confirmed it will send changes/);
  assert.match(hist, /Supabase connection LOST/);
  assert.match(hist, /match-log stopped/);
  const status = JSON.parse(fs.readFileSync(path.join(out, 'status.json'), 'utf8'));
  assert.equal(status.supabase.state, 'stopped');
  assert.match(status.courts.court1.text, /match 1 playing since/);

  // A restart picks up where it left off: no repeated ROW for an unchanged row.
  const n = events.length;
  const again = spawn(process.execPath, [path.join(HERE, 'match-log.mjs'), '--court', `court1=${C1}`, '--out', out, '--for', '1'],
    { env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'test-key' }, stdio: 'ignore' });
  assert.equal(await new Promise((r) => again.on('exit', r)), 0);
  const after = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(after.slice(n).filter((e) => e.kind === 'ROW').length, 0);
  assert.equal(isoLocal(after[0].ms), after[0].t);
});

test('starts when loaded the way pm2 loads it (argv[1] is not this file)', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'match-log-pm2-'));
  const wrapper = path.join(out, 'pm2-like-wrapper.mjs');
  fs.writeFileSync(wrapper, `await import(${JSON.stringify(new URL('./match-log.mjs', import.meta.url).href)});\n`);
  const p = spawn(process.execPath, [wrapper, '--court', `court1=${C1}`, '--out', path.join(out, 'm'), '--for', '1'],
    { env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'k', pm_exec_path: path.join(HERE, 'match-log.mjs') } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  assert.equal(await new Promise((r) => p.on('exit', r)), 0, log);
  assert.match(log, /match-log started/);
});

test('a line cut off by a power cut does not swallow the next one', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'match-log-cut-'));
  fs.writeFileSync(path.join(out, 'events.jsonl'), JSON.stringify(row(at(18, 0), 'A', 'B')) + '\n{"ms":1,"kind":"RO');
  const p = spawn(process.execPath, [path.join(HERE, 'match-log.mjs'), '--court', `court1=${C1}`, '--out', out, '--for', '1'],
    { env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'k' }, stdio: 'ignore' });
  assert.equal(await new Promise((r) => p.on('exit', r)), 0);
  const lines = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(lines[2]).kind, 'START');
});
