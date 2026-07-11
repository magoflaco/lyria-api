// PM2 process definition for lyria-api.
//   pm2 start ecosystem.config.cjs
// Reads configuration from .env (loaded by src/config.js).
module.exports = {
  apps: [
    {
      name: 'lyria-api',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: '400M',
      time: true,
    },
  ],
};
