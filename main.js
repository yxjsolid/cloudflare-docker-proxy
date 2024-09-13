const wrangler = require('wrangler');

wrangler.unstable_dev('src/index.js', {
    env: 'dev',
})