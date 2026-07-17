module.exports = {
  apps: [
    {
      name: 'catavento-payments',
      cwd: __dirname,
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
