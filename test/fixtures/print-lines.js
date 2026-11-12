'use strict';
// Test fixture: prints three lines with small gaps, then exits 0.
// Used by the smoke test's "print" oneshot template.
const lines = ['LINE-1', 'LINE-2', 'LINE-3'];
let i = 0;
const tick = () => {
  if (i >= lines.length) {
    process.exit(0);
    return;
  }
  console.log(lines[i]);
  i += 1;
  setTimeout(tick, 80);
};
tick();
