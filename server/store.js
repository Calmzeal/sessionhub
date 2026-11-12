'use strict';

// Persistent state store.
// Persists session metadata (meta + logFile, NO lines) to <dataDir>/hub-state.json.
// - Debounced saves (500 ms).
// - Atomic write via a temp file + rename.
// - Creates dataDir and dataDir/logs on boot.

const fs = require('fs');
const path = require('path');

const SAVE_DEBOUNCE_MS = 500;

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'hub-state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    this._timer = null;
    this._getPayload = null;
    this._lastPayload = { version: 1, savedAt: null, sessions: [] };
  }

  /**
   * Load the persisted state. Returns the stored session metas (array) or [].
   */
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.sessions)) return parsed.sessions;
      return [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[sessionhub] could not read state file ${this.file}: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * Queue a debounced save. `getPayload` returns the JSON-serializable payload.
   */
  queue(getPayload) {
    this._getPayload = getPayload;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /**
   * Flush a pending save immediately (used on shutdown). Optional getPayload
   * replaces the queued payload getter.
   */
  flush(getPayload) {
    if (getPayload) this._getPayload = getPayload;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._getPayload) return;
    let payload;
    try {
      payload = this._getPayload();
    } catch (err) {
      console.warn(`[sessionhub] state serialization failed: ${err.message}`);
      return;
    }
    this.write(payload);
  }

  /**
   * Atomic write: temp file in the same directory, then rename over the target.
   */
  write(payload) {
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.file);
      this._lastPayload = payload;
    } catch (err) {
      console.warn(`[sessionhub] could not persist state to ${this.file}: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { Store };
