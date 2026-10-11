# Backup splits — music-for-studio-backup-2026-09-07.json

The original backup export was 112 MB (one 41.9 MB song exists twice, plus
one 41.9 MB at index 4), exceeding GitHub's 100 MB hard file limit. It was
split one-song-per-file; no data was lost or changed.

## Contents

- `_header.json` — everything except songs + their audio: settings, playlists,
  the embedded `audio` marker, app/kind/version/exportedAt.
- `<songId>-<slug>.json` — one per song, each containing a full `songs` array
  (exactly the app's import shape) plus per-file integrity metadata:
  - `songChecksum` — sha256 of `JSON.stringify(song)`; verify after download.
  - `checksumOf` — the original backup this part belongs to.
  - `settings` / `playlists` — copied so any one part is also a self-sufficient
    (metadata + playlists) library import even on its own.

### Not committed

`f85c8dec…-tempo-test-1.json` and `6919037f…-tempo-test-2.json` (41.9 MB each)
are excluded from the repo via `.gitignore` — they stay on disk and can be
restored from any full backup export. Everything else is committed.

### Sizes

| file | MB |
|---|---|
| tempo-test-1 / tempo-test-2 | 41.9 each (the big WAV pair) |
| meta-only-song (5029bd83) | 8.0 |
| backup-new-song (a9c6e59f) | 7.2 |
| drive-drive | 7.6 |
| auto-test | 6.5 |
| meta-only-song (meta001) | 4.3 |
| rainy-night / orphan / bkp-new-1 / imported-gold | ~0.06 each |
| `_header.json` | 0.0004 |

Largest part: **41.9 MB** — well within GitHub's 100 MB limit.

## Verify + reassemble

```bash
node merge-backup.cjs           # writes music-for-studio-backup-reassembled.json
# compare to the original:
node merge-backup.cjs --verify
```

## Why 41.9 MB is not a problem

41.9 MB < 100 MB. Done.
