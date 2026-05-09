// PM2 config for self-hosted deploys. Railway uses railway.json instead.
module.exports = {
  apps: [
    {
      name: "autoblog-engine",
      script: "src/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production" }
    }
  ]
};
