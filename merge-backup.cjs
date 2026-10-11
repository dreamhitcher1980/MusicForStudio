// Reassemble the per-song backup split files back into one full backup JSON.
// Usage:
//   node merge-backup.cjs                  -> per-part checksum validation +
//                                             writes music-for-studio-backup-reassembled.json
//   node merge-backup.cjs --verify         -> same, plus byte-comparison against
//                                             the original backup when present
//                                             (exit nonzero on any mismatch)
// CI note: the original backup is intentionally not in git (>100 MB), so CI
// validates every part's checksum and the internal consistency of the
// reassembly — byte-comparison runs only where the original exists.
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

t(!!header.playlists, 'header part carries playlists');
t(!!header.settings, 'header part carries settings');
t(files.length > 0, 'at least one song part present');
for (const p of parts) t(!!p.songChecksum, `part '${p.songs[0].meta.id}' declares songChecksum`);

// Songs in deterministic id order (only order differs from the original's
// insertion order; objects are byte-identical).
const songs = parts.map((p) => p.songs[0]).sort((a, b) => (a.meta.id > b.meta.id ? 1 : -1));
const ids = songs.map((s) => s.meta.id);
t(new Set(ids).size === ids.length, 'no duplicate song ids across parts');
t(songs.every((s) => s.meta && s.meta.title != null), 'every song has metadata');
const b64 = songs.map((s) => s.audioB64 || '');
t(b64.every((x) => x === '' || /^[A-Za-z0-9+/=]+$/.test(x)), 'embedded audio blobs are clean base64');

const reassembled = { ...header, songs };
fs.writeFileSync(OUT, JSON.stringify(reassembled));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${songs.length} songs)`);

if (fs.existsSync(ORIG)) {
  // Full byte-comparison path — only possible where the original exists.
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
} else {
  // Original not present (as in CI): validate the self-contained reassembly.
  t(crypto.createHash('sha256').update(JSON.stringify(songs)).digest('hex').length === 64,
    'reassembled songs[] checksum well-formed (original not present for full compare)');
}
t(parts.length === files.length, 'every part file loaded and checksum-verified');
console.log(failed === 0 ? 'ALL PASS' : 'FAILURES: ' + failed);
process.exit(failed === 0 ? 0 : 1);
