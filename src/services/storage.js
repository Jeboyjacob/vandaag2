'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomToken } = require('../lib/security');

const ALLOWED = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** Check file signature (magic bytes) so the declared type cannot be faked trivially. */
async function sniffVideo(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    await fh.read(buf, 0, 12, 0);
    if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
      const brand = buf.slice(8, 12).toString('ascii');
      return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    }
    if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * Private on-disk video storage. Files live outside the public directory under random
 * names and are only served through an access-controlled route.
 */
function createVideoStorage(config) {
  const root = path.resolve(config.uploadDir);
  const tmpDir = path.join(root, 'tmp');
  const videoDir = path.join(root, 'videos');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  return {
    tmpDir,
    maxBytes: config.videoMaxMb * 1024 * 1024,
    isAllowedMime: (mime) => Object.prototype.hasOwnProperty.call(ALLOWED, mime),
    /** Validate a temp upload and move it into storage. Returns { key, mime }. */
    async commitUpload(tmpPath) {
      const mime = await sniffVideo(tmpPath).catch(() => null);
      if (!mime) {
        await fsp.rm(tmpPath, { force: true });
        const err = new Error('Dit bestand is geen geldige video (mp4, mov of webm).');
        err.code = 'INVALID_VIDEO';
        throw err;
      }
      const key = `${randomToken(18)}.${ALLOWED[mime]}`;
      await fsp.rename(tmpPath, path.join(videoDir, key));
      return { key, mime };
    },
    pathFor(key) {
      if (!/^[A-Za-z0-9_-]+\.(mp4|mov|webm)$/.test(key)) throw new Error('Ongeldige videosleutel');
      return path.join(videoDir, key);
    },
    async remove(key) {
      if (!key) return;
      await fsp.rm(this.pathFor(key), { force: true });
    },
    async discardTmp(tmpPath) {
      if (tmpPath) await fsp.rm(tmpPath, { force: true });
    },
  };
}

module.exports = { createVideoStorage, sniffVideo };
