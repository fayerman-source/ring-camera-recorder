// pm2 process definition. Usage:
//   npm install && npm run build
//   npm run auth            # interactive, once
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 logs ring-camera-recorder
//   pm2 save && pm2 startup # survive reboots
module.exports = {
  apps: [
    {
      name: 'ring-camera-recorder',
      script: 'dist/index.js',
      cwd: __dirname + '/..',
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 20,
      env: {
        // RING_OUTPUT_DIR: '/var/lib/ring-recordings',
        // RING_RETENTION_DAYS: '14',
        // RING_DEBUG: '1',
      },
    },
  ],
};
