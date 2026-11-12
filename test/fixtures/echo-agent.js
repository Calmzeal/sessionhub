'use strict';
// Test fixture: interactive echo CLI.
// Prints READY, echoes every stdin line as "ECHO: <line>",
// exits 0 when it receives the line "STOP" (after printing BYE).
const readline = require('readline');

console.log('READY');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  const text = String(line).replace(/\r$/, '');
  if (text === 'STOP') {
    console.log('BYE');
    rl.close();
    setTimeout(() => process.exit(0), 50);
    return;
  }
  console.log('ECHO: ' + text);
});

rl.on('close', () => {
  setTimeout(() => process.exit(0), 100);
});

process.on('SIGTERM', () => process.exit(0));
