// pm2 definitions for the tournament recorder and match log (Hello Padel, 2026-11-22).
//
// Install on the box (as the box user, NOT inside the streamer's folder):
//   mkdir -p ~/dropshot-tournament && copy recorder.mjs, match-log.mjs and this file there
//   create ~/dropshot-tournament/cameras.env (chmod 600, never in git):
//     CAM_URL_COURT1=rtsp://<login>@192.168.0.112:554/cam/realmonitor?channel=1&subtype=0
//     CAM_URL_COURT2=rtsp://<login>@192.168.0.111:554/cam/realmonitor?channel=1&subtype=0
//   cd ~/dropshot-tournament && pm2 start ecosystem.config.cjs
//   Stats (ds-stats) also needs, in ~/dropshot-tournament: stats-runner.mjs, stats/ (the
//   python steps, people-template.html, courts.json, models/yolo11s.pt and
//   models/torch/hub/checkpoints/resnet50-11ad3fa6.pth) and stats-venv/ (python with
//   torch 2.8.0 CPU, torchvision 0.23.0, ultralytics 8.4.178, scipy 1.13.1, numpy 1.26.4;
//   the box has no pip, so pip was put in the venv from its PyPI wheel).
//   Look here first: cat ~/dropshot-tournament/STATUS.txt (rewritten every 10 s)
//   and for stats: cat ~/dropshot-tournament/STATS.txt
//   Details: recordings/ledger-history.txt, recordings/health.csv, recordings/<court>/ffmpeg.log,
//            matches/history.txt, matches/matches.txt; pm2 logs ds-recorder / ds-match-log
// Recording only runs while a court is live (--only-while-live): its stream is on, or
// the match log says a match is being played there. It stops 15 minutes after neither
// is true, so an internet drop mid-match does not stop the local recording.
// Off switch (the live stream and reels keep going):
//   pm2 stop ds-recorder ds-match-log ds-stats
// No `pm2 save` on purpose: it would also rewrite how the box restores Hassan's
// processes after a reboot. After a reboot, start these two again by hand.
//
// Courts (checked 2026-11-21 in the streamer's own logs and Supabase notes):
//   court1 = a7139753-436c-4a37-8b54-292606e1eba4 ("production court")   camera 192.168.0.112
//   court2 = 1ffe7135-b170-49f4-a433-6218d88c07d0 ("production court 2") camera 192.168.0.111
const HOME = process.env.HOME;
const DIR = `${HOME}/dropshot-tournament`;

module.exports = {
  apps: [
    {
      name: 'ds-recorder',
      script: `${DIR}/recorder.mjs`,
      cwd: DIR,
      args: ['--env-file', `${DIR}/cameras.env`,
        '--camera', 'court1=CAM_URL_COURT1', '--camera', 'court2=CAM_URL_COURT2',
        '--out', `${DIR}/recordings`, '--min-free-gb', '15', '--only-while-live',
        '--status', `${DIR}/STATUS.txt`, '--match-status', `${DIR}/matches/status.json`],
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 15000, // time for ffmpeg to finish its file after "q"
      max_memory_restart: '300M',
      time: true,
    },
    {
      name: 'ds-match-log',
      script: `${DIR}/match-log.mjs`,
      cwd: DIR,
      args: ['--env-file', `${HOME}/Documents/drop-shot-streaming-scripts-ubuntu/.env`,
        '--court', 'court1=a7139753-436c-4a37-8b54-292606e1eba4',
        '--court', 'court2=1ffe7135-b170-49f4-a433-6218d88c07d0',
        '--out', `${DIR}/matches`],
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '200M',
      time: true,
    },
    {
      // Player stats per match, only while the box is free (no court live, no match
      // being played, no reel being made, for 5 minutes). Freezes its work the moment a
      // court goes live. Look here first: cat ~/dropshot-tournament/STATS.txt
      name: 'ds-stats',
      script: `${DIR}/stats-runner.mjs`,
      cwd: DIR,
      args: ['--root', DIR, '--env-file', `${DIR}/cameras.env`,
        '--camera', 'court1=CAM_URL_COURT1', '--camera', 'court2=CAM_URL_COURT2',
        '--ground-env', `${HOME}/Documents/drop-shot-streaming-scripts-ubuntu/.env`],
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 8000, // time to stop the running job (it carries on from its last step later)
      max_memory_restart: '200M', // the runner only; the job itself is a separate python process
      time: true,
    },
  ],
};
