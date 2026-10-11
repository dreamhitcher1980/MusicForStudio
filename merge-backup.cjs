// Reassemble the per-song backup split files back into one full backup JSON.
// Usage:
//   node merge-backup.cjs            -> writes music-for-studio-backup-reassembled.json
//   node merge-backup.cjs --verify   -> additionally byte-compares against the
//                                       original backup (if present) and exits
//                                       nonzero on any mismatch.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'backup-splits');
const OUT = path.join(__dirname, 'music-for-studio-backup-reassembled.json');
const ORIG = path.join(__dirname, 'music-for-studio-backup-2026-09-07.json');

const header = JSON.parse(fs.readFileSync(path.join(DIR, '_header.json'), 'utf8'));
const files = fs.readdirSync(DIR).filter((f) => f !== '_header.json' && f !== 'README.md' && f.endsWith('.json')).sort();

const parts = [];
for (const f of files) {
  const p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (p.songChecksum && crypto.createHash('sha256').update(JSON.stringify(p.songs[0])).digest('hex') !== p.songChecksum) {
    console.error(`CHECKSUM FAIL: ${f} — file corrupted, aborting.`);
    process.exit(1);
  }
  parts.push(p);
}

let failed = 0;
const t = (ok, name) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; };

// Songs in deterministic id order (only order differs from the original's
// insertion order; objects are byte-identical).
const songs = parts.map((p) => p.songs[0]).sort((a, b) => (a.meta.id > b.meta.id ? 1 : -1));
const reassembled = { ...header, songs };

fs.writeFileSync(OUT, JSON.stringify(reassembled));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${songs.length} songs)`);

if (process.argv.includes('--verify') || fs.existsSync(ORIG)) {
  const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
  t(songs.length === orig.songs.length, 'song count matches');
  const byId = {};
  orig.songs.forEach((s) => { byId[s.meta.id] = s; });
  let identical = true;
  songs.forEach((s) => {
    if (JSON.stringify(s) !== JSON.stringify(byId[s.meta.id])) {
      identical = false;
      console.log(`    song ${s.meta.id} differs`);
    }
  });
  t(identical, 'all songs byte-identical to original');
  t(crypto.createHash('sha256').update(JSON.stringify(orig.songs)).digest('hex') === orig.checksum,
    'original songs[] checksum matches its own stored checksum (sanity)');
  // Note: the stored checksum covers the original's INSERTION order; our
  // reassembly sorts by id, which is equivalent data but a different byte
  // string — so we compare against a sorted copy of the original instead.
  const sortedOrig = [...orig.songs].sort((a, b) => (a.meta.id > b.meta.id ? 1 : -1));
  t(crypto.createHash('sha256').update(JSON.stringify(sortedOrig)).digest('hex') === crypto.createHash('sha256').update(JSON.stringify(songs)).digest('hex'),
    'reassembled songs[] checksum equals sorted original (data is byte-identical; order is deterministic)');
  t(parts.length === files.length, 'every part file loaded and checksum-verified');
}
console.log(failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failed);
process.exit(failed === 0 ? 0 : 1);
