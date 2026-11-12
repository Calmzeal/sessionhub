'use strict';
// Generate a random 24-byte hex token to share between the hub and agents.
// Usage: node scripts/gen-token.js
const crypto = require('crypto');
console.log(crypto.randomBytes(24).toString('hex'));
