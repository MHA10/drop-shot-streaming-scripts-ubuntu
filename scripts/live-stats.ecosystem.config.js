// pm2 process definition for the near-live player stats + heatmap reader.
//
// It builds live-stats-out/stats.json + heatmap.png while the match streams, and
// does NOT touch the ffmpeg stream going to YouTube.
//
// TWO ways to feed it video chunks (set SOURCE):
//
//  SOURCE=buffer  (preferred — no second capture)
//    Reuse the chunks the streamer ALREADY writes for highlights. Turn the buffer on
//    in the streamer's env (HIGHLIGHT_ENABLED=true, HIGHLIGHT_BUFFER_DIR=./highlight-buffer),
//    then point BUFFER_DIR at that court's folder: <HIGHLIGHT_BUFFER_DIR>/<courtId>.
//    Those chunks are ~2s each (HIGHLIGHT_BUFFER_SEGMENT_SEC), which is fine — the reader
//    keeps the detector loaded in memory, so short chunks don't cost a reload each time.
//
//  SOURCE=camera  (fallback — buffer off)
//    The reader runs its OWN ffmpeg and slices the camera itself. Use the low-res second
//    stream (…/Streaming/Channels/102) so it doesn't disturb the HD stream to YouTube.
//
// One-time setup on the box: install the Python vision deps track_players.py needs
// (ultralytics + opencv) and have yolo11s.pt present (repo root or MODEL=…).
//
// Deploy:
//   pm2 start scripts/live-stats.ecosystem.config.js
//   pm2 save
//   pm2 logs dropshot-live-stats       # watch the "xN realtime" + backlog line
module.exports = {
  apps: [
    {
      name: 'dropshot-live-stats',
      script: './live_stats.py',
      interpreter: 'python3',
      cwd: __dirname,                 // scripts/ — so track_players.py etc. resolve
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: 20000,              // model load takes a few seconds; don't count that as a crash
      max_memory_restart: '3000M',    // resident torch + yolo11s + a growing master
      // Give the reader time to finish the chunk it's mid-way through and run its
      // shutdown (write the final stats/heatmap, and — in camera mode — kill its own
      // ffmpeg child) before pm2 SIGKILLs it. A chunk at IMGSZ 960 on this CPU can take
      // several seconds; the default ~1.6s kill timeout would hard-kill mid-chunk and
      // orphan the camera ffmpeg.
      kill_timeout: 15000,
      time: true,
      env: {
        SOURCE: 'buffer',             // 'buffer' (reuse streamer chunks) or 'camera' (slice camera)
        // buffer mode: point at <HIGHLIGHT_BUFFER_DIR>/<courtId>
        BUFFER_DIR: '/home/dropshot/drop-shot-streaming-scripts-ubuntu/highlight-buffer/COURT_ID_HERE',
        // camera mode (only used when SOURCE=camera):
        // SECURITY: the URL below carries the camera's admin password. 'PASS' is a
        // PLACEHOLDER. Put the REAL password in the box's shell/env, NOT in this tracked
        // file — do not commit the real credential (it would live in git history forever).
        CAMERA_URL: 'rtsp://admin:PASS@192.168.18.220:554/Streaming/Channels/102',
        CLIP_SEC: '30',
        OUT_DIR: './live-stats-out',
        TARGET_FPS: '3',
        IMGSZ: '960',
        THREADS: '2',                 // cap detector CPU threads; leaves cores for the live ffmpeg. DO NOT raise blindly
        NAMES: '',
        LOGO: '../public/ds.png',     // cwd is scripts/, the logo lives at repo-root public/
        MODEL: '../yolo11s.pt',       // cwd is scripts/, the weights live at repo root
        // Left at auto: STATS_EVERY (buffer 12 / camera 1), CHECKPOINT_SEC (60),
        // DROP_BACKLOG (6), STATIC_REFRESH (60), SWAP_MARGIN (0.15). Override here if needed.
      },
    },
  ],
};
