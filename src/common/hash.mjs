import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha1(buf) { return createHash('sha1').update(buf).digest('hex'); }
export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

export function hashFile(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const h = createHash(algorithm);
    createReadStream(filePath)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export async function hashFileBoth(filePath) {
  return { sha1: await hashFile(filePath, 'sha1'), sha256: await hashFile(filePath, 'sha256') };
}
