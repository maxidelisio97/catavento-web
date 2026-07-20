module.exports = {
  apps: [
    {
      name: 'catavento-payments',
      cwd: __dirname,
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
