module.exports = {
  apps: [
    {
      name: "paperclip-client",
      script: "server.js",
      cwd: "/opt/paperclip-client",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
