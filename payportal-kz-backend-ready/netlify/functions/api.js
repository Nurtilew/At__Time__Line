'use strict';

// This adapter is exclusively for Netlify Functions. Mark the runtime explicitly so
// the app fails closed for payments because this build uses a temporary SQLite file.
process.env.NETLIFY = 'true';
process.env.DATABASE_PATH = process.env.DATABASE_PATH || '/tmp/payportal-kz.sqlite';

const serverless = require('serverless-http');
const app = require('../../server');

exports.handler = serverless(app);
