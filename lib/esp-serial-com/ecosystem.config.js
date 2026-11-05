// pm2 process definition for the ESP32 → Supabase score forwarder.
//
// Runtime config (SUPABASE_URL, SUPABASE_ANON_KEY, PORT_FILTER, COURT_MAP) is read
// from a `.env` file placed NEXT TO score-to-supabase.js — this file is kept
// secret-free and box-agnostic so it can be committed and reused on any box.
//
// Deploy on a box:
//   1. copy score-to-supabase.js + this file into the run dir (e.g. ~/esp-serial-com)
//   2. create ./.env there:
//        SUPABASE_URL=...
//        SUPABASE_ANON_KEY=...
//        PORT_FILTER=ttyACM0
//        COURT_MAP=<esp-court-uuid>:<streamer-court-uuid>
//   3. stop whatever else is holding the serial port (the old harness)
//   4. pm2 start ecosystem.config.js
//      pm2 save
//      pm2 logs dropshot-score
module.exports = {
  apps: [
    {
      name: 'dropshot-score',
      script: './score-to-supabase.js',
      cwd: __dirname,              // so the .env next to the script is found regardless of where pm2 is invoked
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,         // give the serial device time to reappear before reconnecting
      min_uptime: 10000,           // a crash within 10s counts toward max_restarts (stops a tight crash loop)
      max_memory_restart: '150M',
      time: true,                  // timestamp every log line
    },
  ],
};
