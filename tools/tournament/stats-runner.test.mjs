// Tests for stats-runner.mjs: run with `node --test stats-runner.test.mjs` (about 40 s).
// The stats steps are replaced by a fake job (prints progress, sleeps), so this checks
// the runner's own job: when the box is free, which video belongs to which match,
// freezing a job when a court goes live, and the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { busyReasons, sessionsOf, concatFor, planJobs, fileStartMs } from './stats-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-runner-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const fakeStreamer = (host) => spawn('bash', ['-c',
  `exec -a ffmpeg ${JSON.stringify(process.execPath)} -e 'setTimeout(()=>{},1e6)' -- -i rtsp://u:p@${host}:554/cam -f flv rtmp://a.rtmp.youtube.com/live2/SECRETKEY`],
{ stdio: 'ignore' });
const until = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await wait(200); }
  assert.fail(`timed out waiting for: ${what}`);
};
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const procState = (pid) => { try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };

test('pure parts: busy reasons, recordings, the match video list, the job plan', () => {
  const hints = new Map([['court1', '@10.0.0.12'], ['court2', '@10.0.0.11']]);
  const now = Date.now();
  const ps = [
    '101 ffmpeg -i rtsp://u:p@10.0.0.12:554/cam -f flv rtmp://a.rtmp.youtube.com/live2/KEY',
    '102 ffmpeg -nostdin -i rtsp://u:p@10.0.0.11:554/Streaming/Channels/102 -f hls /home/x/hlscam/stream.m3u8',
    '103 node /usr/bin/streamer',
  ].join('\n');
  assert.deepEqual(busyReasons({ ps, hints, ignore: ['/hlscam/'], nowMs: now }), ['court1 live']);
  // the preview alone is not busy; our own ffmpeg is not busy
  assert.deepEqual(busyReasons({ ps: ps.split('\n').slice(1).join('\n'), hints, ignore: ['/hlscam/'] }), []);
  assert.deepEqual(busyReasons({ ps: '7 ffmpeg -f concat -i /r/stats-out/j/list.ffconcat -f rawvideo -', hints, ownMarks: ['/r/stats-out'] }), []);
  // reels and the recorder's grace time are busy
  assert.deepEqual(busyReasons({ ps: '8 python3 /x/scripts/reframe_ball.py in.mp4', hints }), ['a reel is being made']);
  assert.deepEqual(busyReasons({ ps: '9 ffmpeg -i list.txt -c:v libx264 /home/x/hl-out/c/reel.mp4', hints }), ['another ffmpeg is running (reel or stream work)']);
  assert.deepEqual(busyReasons({ ps: '9 ffmpeg -i rtsp://x -f segment /home/x/dropshot-tournament/recordings/court1/c.mkv', hints }), ['the recorder is still recording']);
  // a match being played counts only while the match log's status is fresh
  const ms = { updatedMs: now - 10_000, courts: { court2: { state: 'playing' } } };
  assert.deepEqual(busyReasons({ ps: '', hints, matchStatus: ms, nowMs: now }), ['court2 match being played']);
  assert.deepEqual(busyReasons({ ps: '', hints, matchStatus: { ...ms, updatedMs: now - 10 * 60_000 }, nowMs: now }), []);
  assert.deepEqual(busyReasons({ ps: '', hints, tempC: 82 }), []);
  assert.deepEqual(busyReasons({ ps: '', hints, tempC: 91 }), ['box hot (90 °C or more)']);
  assert.deepEqual(busyReasons({ ps: '', hints, freeGB: 24 }), ['disk low (under 25 GB free)']);
  // a stream that reads from the preview is still busy (the preview exception never covers streaming out)
  assert.deepEqual(busyReasons({ ps: '5 ffmpeg -i /home/x/hlscam/stream.m3u8 -f flv rtmp://a/KEY', hints, ignore: ['/hlscam/'] }), ['another ffmpeg is running (reel or stream work)']);
  assert.deepEqual(busyReasons({ ps: '', hints, freeGB: 80 }), []);
  // the stream key never shows up in the reasons
  assert.ok(!busyReasons({ ps, hints }).join().includes('KEY'));

  const t0 = new Date(2026, 10, 22, 20, 0, 0).getTime();
  assert.equal(fileStartMs('court1-20261122-200000.mkv'), t0);
  const names = ['court1-20261122-200000.mkv', 'court1-20261122-201000.mkv', 'court1-20261122-213000.mkv', 'junk.mkv'];
  const durs = { 'court1-20261122-200000.mkv': 600, 'court1-20261122-201000.mkv': 300, 'court1-20261122-213000.mkv': 600 };
  const ss = sessionsOf(names, (n) => durs[n] ?? null);
  assert.equal(ss.length, 2, 'a 75-minute gap splits the recordings');
  assert.equal(ss[0].endMs, t0 + 900_000);

  // a match 20:05-20:12 -> the second half of file 1 and the first 2 minutes of file 2
  const c = concatFor('/r/court1', ss[0].files, t0 + 300_000, t0 + 720_000);
  assert.equal(c.body, "ffconcat version 1.0\nfile '/r/court1/court1-20261122-200000.mkv'\ninpoint 300.00\nduration 300.00\n" +
    "file '/r/court1/court1-20261122-201000.mkv'\noutpoint 120.00\nduration 120.00\n");
  assert.equal(c.heldS, 420);

  const sessionsByCourt = new Map([['court1', ss], ['court2', sessionsOf(['court2-20261122-200000.mkv'], () => 600)]]);
  const matches = [
    { court: 'court1', n: 1, startMs: t0 + 300_000, endMs: t0 + 720_000, red_team: 'A & B', blue_team: 'C & D', checks: [] },
    { court: 'court1', n: 2, startMs: t0 + 5_430_000, endMs: null, red_team: 'E & F', blue_team: null, checks: [] },
  ];
  const jobs = planJobs({ matches, sessionsByCourt, nowMs: t0 + 4 * 3600_000 });
  assert.deepEqual(jobs.map((j) => [j.id, j.kind, j.teams]), [
    ['court2-20261122-200000-rec', 'recording', 'no match found in the match log'],
    ['court1-20261122-200500', 'match', 'A & B vs C & D'],
    ['court1-20261122-213030', 'match', 'E & F vs ?'],
  ]);
  assert.equal(jobs[1].ws, t0 + 270_000, 'starts 30 s before the first point');
  assert.equal(jobs[2].we, ss[1].endMs, 'a match never closed ends with its recording');
  assert.match(jobs[2].checks.join(), /never closed/);
  // a 4-hour recording with no match in it becomes 3 pieces of 80 minutes (memory)
  const long = planJobs({ matches: [], sessionsByCourt: new Map([['court2', sessionsOf(['court2-20261122-200000.mkv'], () => 4 * 3600)]]), nowMs: t0 + 9 * 3600_000 });
  assert.deepEqual(long.map((j) => (j.we - j.ws) / 60_000), [80, 80, 80]);
  assert.equal(long[2].we, t0 + 4 * 3600_000);
  // a "match" that ran all day (names never changed) is cut into parts of 90 minutes or less
  const allDay = planJobs({ matches: [{ court: 'court2', n: 1, startMs: t0 + 30_000, endMs: t0 + 6 * 3600_000, red_team: 'X', blue_team: 'Y', checks: [] }],
    sessionsByCourt: new Map([['court2', sessionsOf(['court2-20261122-200000.mkv'], () => 6 * 3600)]]), nowMs: t0 + 9 * 3600_000 });
  assert.deepEqual(allDay.map((j) => [j.id.slice(-3), Math.round((j.we - j.ws) / 60_000)]), [['030', 90], ['-p2', 90], ['-p3', 90], ['-p4', 90]]);
  assert.match(allDay[3].title, /part 4 of 4/);
  // an open match whose recording ended minutes ago waits, and its recording is not done as "no match" meanwhile
  const waiting = planJobs({ matches: [matches[1]], sessionsByCourt, nowMs: ss[1].endMs + 5 * 60_000 });
  assert.ok(!waiting.some((j) => j.kind === 'recording' && j.court === 'court1' && j.ws === ss[1].startMs), JSON.stringify(waiting.map((j) => j.id)));
  // while that court is live, its open match and its current recording wait
  const live = planJobs({ matches, sessionsByCourt, live: new Set(['court1', 'court2']), nowMs: t0 + 4 * 3600_000 });
  assert.deepEqual(live.map((j) => j.id), ['court1-20261122-200500']);
});

// ---- end to end with a fake job ------------------------------------------------
const root = path.join(tmp, 'root');
const rec = path.join(root, 'recordings', 'court1');
fs.mkdirSync(rec, { recursive: true });
fs.mkdirSync(path.join(root, 'matches'), { recursive: true });
fs.mkdirSync(path.join(root, 'stats'), { recursive: true });
const t1 = Math.floor(Date.now() / 1000) * 1000 - 40 * 60_000;
for (const k of [0, 1]) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '60', '-c:v', 'libx264',
    '-preset', 'ultrafast', path.join(rec, `court1-${stamp(t1 + k * 60_000)}.mkv`)]);
}
fs.writeFileSync(path.join(root, 'matches', 'matches.json'), JSON.stringify([
  { court: 'court1', n: 1, startMs: t1 + 40_000, endMs: t1 + 110_000, red_team: 'A & B', blue_team: 'C & D', checks: [] },
]));
fs.writeFileSync(path.join(root, 'stats', 'courts.json'), JSON.stringify({ court1: { size: '320x240', poly: '0,0;320,0;320,240;0,240', court: '0,0,0,320,0,240,120' } }));
// "python" that drops -I and runs node; the fake job prints progress for ~6 s
const fakePy = path.join(tmp, 'fakepy.sh');
fs.writeFileSync(fakePy, `#!/bin/bash\nshift\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
const fakeJob = path.join(tmp, 'fake_job.mjs');
fs.writeFileSync(fakeJob, `import fs from 'node:fs';
if (process.env.LEFTOVER) setInterval(() => {}, 1000); // stands in for a job left from a crash
const dir = process.argv[2];
if (process.env.LEFTOVER) await new Promise(() => {});
const j = JSON.parse(fs.readFileSync(dir + '/job.json', 'utf8'));
fs.writeFileSync(dir + '/seen.txt', fs.readFileSync(dir + '/list.ffconcat', 'utf8') + 'duration ' + j.duration_s + '\\n');
if (j.teams.includes('FAILME')) { console.error('boom'); process.exit(4); }
for (let p = 0; p <= 100; p += 10) { console.log('PROGRESS ' + p + ' people'); await new Promise((r) => setTimeout(r, 600)); }
fs.writeFileSync(dir + '/whos-who.html', 'page');
`);
const startRunner = (extra = []) => {
  const p = spawn(process.execPath, [path.join(HERE, 'stats-runner.mjs'), '--root', root, '--python', fakePy, '--job-script', fakeJob,
    '--camera', 'court1=CAM1', '--free-for-s', '1', '--check-ms', '300', ...extra],
  { env: { ...process.env, CAM1: 'rtsp://u:p@10.9.9.8:554/cam' }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.stderr.on('data', (d) => { p.out += d; });
  return p;
};
const hist = () => read(path.join(root, 'stats-out', 'history.txt'));
const jobId = `court1-${stamp(t1 + 40_000)}`;

test('works through a match while the box is free, freezes when a court goes live, then finishes', async () => {
  // a stats job left over from a crashed run (shows as "python3 <job script> <stats-out>/old") gets stopped at start;
  // a process that merely mentions the same paths (here a node one) is left alone
  const leftover = spawn('bash', ['-c', `exec -a python3 ${JSON.stringify(process.execPath)} ${fakeJob} ${path.join(root, 'stats-out', 'old')}`],
    { detached: true, stdio: 'ignore', env: { ...process.env, LEFTOVER: '1' } });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', fakeJob, path.join(root, 'stats-out', 'old')], { detached: true, stdio: 'ignore' });
  await wait(500);
  const r = startRunner();
  try {
    await until(() => /left over/.test(hist()), 5000, 'leftover stopped');
    await until(() => procState(leftover.pid) === '' || /Z/.test(procState(leftover.pid)), 5000, 'leftover gone');
    assert.ok(procState(bystander.pid) !== '' && !/Z/.test(procState(bystander.pid)), 'a process that only mentions the paths was killed');
    await until(() => hist().includes(`${jobId} STARTED`), 10_000, 'job started');
    await until(() => read(path.join(root, 'stats-out', jobId, 'seen.txt')).includes('duration'), 5000, 'job read its video list');
    const seen = read(path.join(root, 'stats-out', jobId, 'seen.txt'));
    assert.match(seen, /court1-\d{8}-\d{6}\.mkv'\ninpoint 10\.00\nduration 50\.00\nfile '.*court1-\d{8}-\d{6}\.mkv'\noutpoint 50\.00\nduration 50\.00\nduration 100/, seen);
    // the list as written must have a length ffprobe can read (ffmpeg 6 on the box needs the duration lines)
    const listDur = Number(execFileSync('ffprobe', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(root, 'stats-out', jobId, 'list.ffconcat'),
      '-show_entries', 'format=duration', '-of', 'csv=p=0'], { encoding: 'utf8' }).trim());
    assert.ok(Math.abs(listDur - 100) < 1, `list length ${listDur}`);
    await until(() => /WORKING [1-9]\d?%/.test(read(path.join(root, 'stats-out', 'ledger.txt'))), 5000, 'progress in the ledger');
    // a stream starts on court1: the job freezes
    const s = fakeStreamer('10.9.9.8');
    try {
      await until(() => hist().includes(`${jobId} PAUSED`), 5000, 'paused');
      assert.match(hist(), /box BUSY: court1 live/);
      const workerPid = Number(execFileSync('pgrep', ['-f', `fake_job.mjs ${path.join(root, 'stats-out', jobId)}`], { encoding: 'utf8' }).trim().split('\n')[0]);
      assert.match(procState(workerPid), /T/, 'the job is frozen, not killed');
      const pctBefore = read(path.join(root, 'stats-out', 'ledger.txt')).match(/PAUSED (\d+)%/)?.[1];
      await wait(1500);
      assert.equal(read(path.join(root, 'stats-out', 'ledger.txt')).match(/PAUSED (\d+)%/)?.[1], pctBefore, 'no progress while paused');
      assert.match(read(path.join(root, 'STATS.txt')), /BUSY since .*court1 live/);
      assert.ok(!hist().includes('SECRETKEY') && !hist().includes('u:p@'), 'no stream key or login in the history');
    } finally { s.kill('SIGKILL'); }
    await until(() => hist().includes(`${jobId} RESUMED`), 5000, 'resumed');
    await until(() => hist().includes(`${jobId} DONE`), 15_000, 'done');
    await until(() => new RegExp(`${jobId}\\s+DONE .*A & B vs C & D .*whos-who\\.html`).test(read(path.join(root, 'stats-out', 'ledger.txt'))), 3000, 'DONE in the ledger');
    await until(() => /done 1/.test(read(path.join(root, 'STATS.txt'))), 3000, 'done in STATS.txt');
    // resource use: a row per minute while the job exists (the first one at once), a summary when it ends
    const res = read(path.join(root, 'stats-out', 'resources.csv'));
    assert.match(res, /^time,job,state,step,pct,job_cpu_cores,job_mem_mb,job_processes,box_cpu_busy_pct,load1,temp_c,mem_available_gb,disk_free_gb\n/);
    assert.match(res, new RegExp(`\\n[^\\n]+,${jobId},WORKING,`));
    assert.match(hist(), new RegExp(`${jobId} DONE in .*working .*paused .*peak memory \\d+ MB`));
    assert.match(read(path.join(root, 'stats-out', jobId, 'resources.txt')), /peak memory \d+ MB/);
  } finally {
    r.kill('SIGTERM');
    await new Promise((res) => r.on('exit', res));
    try { process.kill(-leftover.pid, 'SIGKILL'); } catch { /* gone */ }
    try { process.kill(-bystander.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  assert.match(hist(), /stats runner stopped \(SIGTERM\)/);
  assert.ok(!fs.existsSync(path.join(root, 'stats-out', '.runner.pid')), 'lock left behind');
});

test('a failing job is marked FAILED with its reason, and stopping mid-job stops the job too', async () => {
  const ms = JSON.parse(read(path.join(root, 'matches', 'matches.json')));
  ms.push({ court: 'court1', n: 2, startMs: t1 + 115_000, endMs: t1 + 119_000 + 60_000, red_team: 'FAILME', blue_team: 'X', checks: [] });
  fs.writeFileSync(path.join(root, 'matches', 'matches.json'), JSON.stringify(ms));
  const r = startRunner();
  try {
    const failId = `court1-${stamp(t1 + 115_000)}`;
    // under 60 s of video for match 2 -> skipped as NO VIDEO, not FAILED
    await until(() => hist().includes(`${failId} skipped: only`), 10_000, 'short match skipped');
    assert.match(read(path.join(root, 'stats-out', 'ledger.txt')), new RegExp(`${failId}\\s+NO VIDEO`));
  } finally {
    r.kill('SIGTERM');
    await new Promise((res) => r.on('exit', res));
  }
  // now a long enough failing match
  ms[1].endMs = t1 + 119_000 + 0; ms[1].startMs = t1 + 30_000; ms[1].n = 3;
  ms[0].n = 9; ms[0].startMs = t1 + 100_000; ms[0].endMs = t1 + 101_000; // old match out of the way (kept DONE)
  fs.writeFileSync(path.join(root, 'matches', 'matches.json'), JSON.stringify([ms[1]]));
  const r2 = startRunner();
  try {
    const id = `court1-${stamp(t1 + 30_000)}`;
    await until(() => hist().includes(`${id} FAILED`), 10_000, 'failed');
    assert.match(hist(), new RegExp(`${id} FAILED \\(exit 4 in step`));
    // one more try, never more: the first failure is kept in FAILED-1
    await until(() => (hist().match(new RegExp(`${id} FAILED`, 'g')) ?? []).length === 2, 10_000, 'second failure');
    assert.match(hist(), new RegExp(`${id}: trying once more`));
    assert.match(read(path.join(root, 'stats-out', id, 'FAILED-1')), /boom/);
    assert.ok(fs.existsSync(path.join(root, 'stats-out', id, '.retried')));
    await wait(2000);
    assert.equal((hist().match(new RegExp(`${id} FAILED`, 'g')) ?? []).length, 2, 'retried more than once');
    assert.match(read(path.join(root, 'stats-out', id, 'FAILED')), /boom/);
  } finally {
    r2.kill('SIGTERM');
    await new Promise((res) => r2.on('exit', res));
  }
});
