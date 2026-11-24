// Tests for recorder.mjs. Run: node --test tools/tournament/recorder.test.mjs
// Needs ffmpeg/ffprobe on PATH. Uses a generated test video as the "camera".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ffmpegArgs, mask, addSecret, loginsOf, liveHintFor, liveLabels, liveScan, readEnvFile } from './recorder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-'));
const SRC = path.join(tmp, 'camera.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20', '-t', '60',
  '-c:v', 'libx264', '-g', '20', '-pix_fmt', 'yuv420p', SRC]);

const run = (args, env = {}, script = path.join(HERE, 'recorder.mjs'), extraNode = []) => new Promise((resolve) => {
  const p = spawn(process.execPath, [...extraNode, script, ...args], { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ code, out }));
});
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const mkvs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mkv')).sort() : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A stand-in for the streamer's live ffmpeg: its command line holds "ffmpeg",
// the camera address and an rtmp output, which is all the live check looks for.
// `exec -a ffmpeg` makes the process list show it as an ffmpeg.
const fakeStreamer = (host) => spawn('bash', ['-c',
  `exec -a ffmpeg ${JSON.stringify(process.execPath)} -e 'setTimeout(()=>{},1e6)' -- -i rtsp://u:p@${host}:554/cam -f flv rtmp://a.rtmp.youtube.com/live2/SECRETKEY`],
{ stdio: 'ignore' });

test('pure parts: ffmpeg command, masking, live check, env file', () => {
  const a = ffmpegArgs('rtsp://u:p@10.0.0.1:554/x', '/r/court1', 'court1', 600);
  assert.ok(a.includes('copy') && a.includes('0:v') && a.includes('matroska') && !a.includes('-nostdin'));
  assert.equal(a[a.indexOf('-segment_atclocktime') + 1], '1');
  assert.equal(a[a.indexOf('-rtsp_transport') + 1], 'tcp');
  assert.equal(a.at(-1), '/r/court1/court1-%Y%m%d-%H%M%S.mkv');
  assert.equal(mask('rtsp://admin:s3cret@192.168.0.111:554/cam'), 'rtsp://***@192.168.0.111:554/cam');
  assert.equal(mask('rtsp://admin:Abc@123@192.168.0.112/cam?x=1'), 'rtsp://***@192.168.0.112/cam?x=1');
  assert.equal(liveHintFor('rtsp://admin:Abc@123@192.168.0.112:554/cam'), '@192.168.0.112');
  assert.deepEqual(loginsOf('rtsp://admin:pa/ss@192.168.0.112:554/cam'), ['admin:pa/ss', 'pa/ss']);
  addSecret('pa/ss');
  assert.ok(!mask('Error opening rtsp://admin:pa/ss@192.168.0.112/cam: refused (pa/ss)').includes('pa/ss'));
  const ps = [
    '101 ffmpeg -i rtsp://u:p@192.168.0.111:554/cam/realmonitor?channel=1&subtype=1 -f flv rtmp://a.rtmp.youtube.com/live2/KEY',
    '102 ffmpeg -i rtsp://u:p@192.168.0.112:554/Streaming/Channels/102 -c copy -f hls /home/x/hlscam/stream.m3u8',
    '103 ffmpeg -i rtsp://u:p@192.168.0.112:554/cam -c copy -f segment /rec/court1/court1-%Y.mkv',
    '104 /bin/zsh -c echo ffmpeg -i rtsp://u:p@192.168.0.112:554/cam -f flv rtmp://x/KEY',
  ].join('\n');
  const live = liveLabels(ps, [['court1', '@192.168.0.112'], ['court2', '@192.168.0.111']], '/rec');
  assert.deepEqual([...live], ['court2']); // the preview, our own recorder and a shell mentioning ffmpeg are not "live"
  assert.equal(liveScan(ps + '\n105 ffmpeg -i rtsp://u:p@192.168.0.150:554/x -f flv rtmp://x/K', [['court1', '@192.168.0.112'], ['court2', '@192.168.0.111']], '/rec').unmatched, 1);
  const envFile = path.join(tmp, 'cams.env');
  fs.writeFileSync(envFile, 'CAM_A="rtsp://u:p@h/x"\r\nCAM_B = rtsp://u:p#1@h/y   # court 2\nexport CAM_C=\'z\'\n');
  assert.deepEqual(readEnvFile(envFile, ['CAM_A', 'CAM_B', 'CAM_C']), { CAM_A: 'rtsp://u:p@h/x', CAM_B: 'rtsp://u:p#1@h/y', CAM_C: 'z' });
});

test('records 5-second files that play, stops cleanly, with ledger, history, health and STATUS', async () => {
  const out = path.join(tmp, 'rec1');
  const t0 = Date.now();
  const { code, out: log } = await run(['--camera', 'court1=CAM1', '--out', out, '--segment-s', '5', '--min-free-gb', '0',
    '--status', path.join(tmp, 'STATUS1.txt'), '--for', '17'], { CAM1: SRC });
  assert.equal(code, 0, log);
  assert.ok(Date.now() - t0 < 23_000, `took ${Date.now() - t0} ms to stop: ffmpeg did not stop on "q"`);
  const files = mkvs(path.join(out, 'court1'));
  assert.ok(files.length >= 3, `files: ${files.join(' ')}\n${log}`);
  assert.match(files[0], /^court1-\d{8}-\d{6}\.mkv$/);
  for (const f of files.slice(1, -1)) {
    assert.equal(Number(f.slice(-6, -4)) % 5, 0, f); // files start on the clock's 5-second marks
    const dur = duration(path.join(out, 'court1', f));
    assert.ok(dur > 3.5 && dur < 6.5, `${f} lasts ${dur}s`);
  }
  assert.ok(duration(path.join(out, 'court1', files.at(-1))) > 0, `${files.at(-1)} unreadable`);
  assert.match(fs.readFileSync(path.join(out, 'ledger.txt'), 'utf8'), /court1\s+STOPPED\s+\d+/);
  const hist = fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8');
  assert.match(hist, /court1 RECORDING started/);
  assert.match(hist, /court1 file done: court1-\S+ \(\d+ MB, 0m0[3-6]s\)/);
  // Every file reported exactly once, each with a readable length (the box's ffmpeg 6.1.1
  // once got brand-new files logged as "length unreadable" and never reported again).
  assert.doesNotMatch(hist, /length unreadable/, hist);
  const reported = [...hist.matchAll(/file done: (\S+\.mkv)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reported, files, hist);
  assert.match(hist, /recorder stopped/);
  assert.match(fs.readFileSync(path.join(out, 'health.csv'), 'utf8'), /^time,cpu_busy_pct,load1,temp_c,mem_free_gb,disk_free_gb,court1_live,court1_recording,court1_file_mb\n.+/);
  const status = fs.readFileSync(path.join(tmp, 'STATUS1.txt'), 'utf8');
  assert.match(status, /DropShot tournament recording/);
  assert.match(status, /court1\s+STOPPED/);
  assert.ok(!fs.existsSync(path.join(out, '.recorder.pid')), 'lock left behind');
});

test('only while live: waits, records while the stream runs, stops after the grace time', async () => {
  const out = path.join(tmp, 'rec2');
  const p = spawn(process.execPath, [path.join(HERE, 'recorder.mjs'), '--camera', 'court1=CAM1', '--out', out, '--segment-s', '5',
    '--min-free-gb', '0', '--only-while-live', '--live-hint', 'court1=@10.9.9.9', '--live-grace-s', '3', '--for', '22'],
  { env: { ...process.env, CAM1: SRC } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  await wait(4000);
  assert.equal(mkvs(path.join(out, 'court1')).length, 0, 'recorded before the stream was live');
  const streamer = fakeStreamer('10.9.9.9');
  await wait(8000);
  assert.ok(mkvs(path.join(out, 'court1')).length >= 1, `not recording while live\n${log}`);
  streamer.kill();
  await wait(7000);
  const n = mkvs(path.join(out, 'court1')).length;
  await wait(2500);
  assert.equal(mkvs(path.join(out, 'court1')).length, n, 'still recording after the stream ended');
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 0, log);
  const hist = fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8');
  assert.match(hist, /court1 is LIVE \(stream\)/);
  assert.match(hist, /court1 not live for 3 s: recording STOPPED/);
  assert.ok(!hist.includes('SECRETKEY') && !log.includes('SECRETKEY'), 'stream key leaked from the process list');
});

test('a camera that fails is retried, and its login (even with "@" in it) never printed', async () => {
  const out = path.join(tmp, 'rec3');
  const { code, out: log } = await run(['--camera', 'court1=CAM1', '--out', out, '--min-free-gb', '0', '--for', '8'],
    { CAM1: 'rtsp://admin:s3c@ret@127.0.0.1:9/cam' });
  assert.equal(code, 0, log);
  const hist = fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8');
  assert.match(hist, /recording INTERRUPTED after \d+s .*trying again in 5s/);
  for (const text of [log, hist, fs.readFileSync(path.join(out, 'court1', 'ffmpeg.log'), 'utf8')]) {
    assert.ok(!text.includes('s3c') && !text.includes('ret@'), 'login leaked');
  }
  assert.ok(hist.includes('rtsp://***@127.0.0.1'));
});

test('a frozen camera (connection open, no video) is restarted', async () => {
  const out = path.join(tmp, 'rec4');
  const fifo = path.join(tmp, 'frozen.ts');
  execFileSync('mkfifo', [fifo]);
  // Feed 2 s of video into the pipe, then keep it open and silent.
  const ts = path.join(tmp, 'two.ts');
  execFileSync('ffmpeg', ['-v', 'error', '-i', SRC, '-t', '2', '-c', 'copy', '-f', 'mpegts', ts]);
  const p = spawn(process.execPath, [path.join(HERE, 'recorder.mjs'), '--camera', 'court1=CAM1', '--out', out, '--segment-s', '600',
    '--min-free-gb', '0', '--stall-s', '4', '--for', '30'], { env: { ...process.env, CAM1: fifo } });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  // A separate "camera" that sends 2 s of video, then keeps the pipe open and silent.
  const camera = spawn('bash', ['-c', `exec 3>${JSON.stringify(fifo)}; cat ${JSON.stringify(ts)} >&3; sleep 60`], { stdio: 'ignore' });
  const code = await new Promise((r) => p.on('exit', r));
  camera.kill('SIGKILL');
  assert.equal(code, 0, log);
  const hist = fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8');
  assert.match(hist, /court1 no new video for \d+s: restarting the camera connection/, hist);
  assert.match(hist, /recording INTERRUPTED after \d+s \(no new video for 4 s/, hist);
});

test('stops before the disk gets tight', async () => {
  const out = path.join(tmp, 'rec5');
  const { code, out: log } = await run(['--camera', 'court1=CAM1', '--out', out, '--min-free-gb', '999999', '--segment-s', '5', '--for', '5'], { CAM1: SRC });
  assert.equal(code, 0, log);
  assert.match(fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8'), /court1 PAUSED: free disk [\d.]+ GB is below 999999 GB/);
  assert.ok(mkvs(path.join(out, 'court1')).length <= 1);
});

test('one recorder per folder; an ffmpeg left over from a crashed run is stopped', async () => {
  const out = path.join(tmp, 'rec6');
  fs.mkdirSync(path.join(out, 'court1'), { recursive: true });
  const leftover = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-i', SRC, '-map', '0:v', '-c', 'copy', '-f', 'segment',
    '-segment_time', '5', '-strftime', '1', '-segment_format', 'matroska', path.join(out, 'court1', 'court1-%Y%m%d-%H%M%S.mkv')],
  { stdio: ['pipe', 'ignore', 'ignore'] });
  await wait(1500);
  const exited = new Promise((r) => leftover.on('exit', () => r(true)));
  const first = spawn(process.execPath, [path.join(HERE, 'recorder.mjs'), '--camera', 'court1=CAM1', '--out', out, '--segment-s', '5',
    '--min-free-gb', '0', '--for', '6'], { env: { ...process.env, CAM1: SRC } });
  await wait(1500);
  const second = await run(['--camera', 'court1=CAM1', '--out', path.join(out, '..', 'rec6'), '--segment-s', '5', '--min-free-gb', '0', '--for', '3'], { CAM1: SRC });
  assert.equal(second.code, 3, second.out);
  assert.match(second.out, /another recorder \(pid \d+\) is already recording/);
  assert.equal(await new Promise((r) => first.on('exit', r)), 0);
  assert.equal(await Promise.race([exited, wait(3000).then(() => false)]), true, 'leftover ffmpeg still running');
  assert.match(fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8'), /stopping a leftover ffmpeg \(pid \d+\)/);
});

test('starts when loaded the way pm2 loads it (argv[1] is not this file)', async () => {
  const out = path.join(tmp, 'rec7');
  const wrapper = path.join(tmp, 'pm2-like-wrapper.mjs');
  fs.writeFileSync(wrapper, `await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'recorder.mjs')).href)});\n`);
  const { code, out: log } = await run(['--camera', 'court1=CAM1', '--out', out, '--segment-s', '5', '--min-free-gb', '0', '--for', '3'],
    { CAM1: SRC, pm_exec_path: path.join(HERE, 'recorder.mjs') }, wrapper);
  assert.equal(code, 0, log);
  assert.match(log, /recorder started/);
});

test('a match being played counts as live even without a stream (internet drop)', async () => {
  const out = path.join(tmp, 'rec9');
  const statusJson = path.join(tmp, 'match-status.json');
  const write = (state) => fs.writeFileSync(statusJson, JSON.stringify({ updatedMs: Date.now(), supabase: { state: 'listening', sinceMs: Date.now() },
    courts: { court1: { text: 'x', state } } }));
  write('playing');
  const keep = setInterval(() => write('playing'), 1000);
  const { code, out: log } = await run(['--camera', 'court1=CAM1', '--out', out, '--segment-s', '5', '--min-free-gb', '0',
    '--only-while-live', '--live-hint', 'court1=@10.8.8.8', '--match-status', statusJson, '--for', '6'], { CAM1: SRC });
  clearInterval(keep);
  assert.equal(code, 0, log);
  assert.match(fs.readFileSync(path.join(out, 'ledger-history.txt'), 'utf8'), /court1 is LIVE \(match being played\)/);
  assert.ok(mkvs(path.join(out, 'court1')).length >= 1, log);
});

test('a lock left by a recorder from before a reboot does not block the start', async () => {
  const out = path.join(tmp, 'rec10');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '.recorder.pid'), `${process.pid} some-earlier-boot`);
  const { code, out: log } = await run(['--camera', 'court1=CAM1', '--out', out, '--segment-s', '5', '--min-free-gb', '0', '--for', '2'], { CAM1: SRC });
  assert.equal(code, 0, log);
  assert.match(log, /recorder started/);
});

test('a missing camera address is refused at start', async () => {
  const { code, out } = await run(['--camera', 'court1=NOPE', '--out', path.join(tmp, 'rec8')], {});
  assert.equal(code, 2);
  assert.match(out, /no camera address for NOPE/);
});
