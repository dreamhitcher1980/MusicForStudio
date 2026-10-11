// Voice recording — capture a family member's real voice with the mic and turn
// it into a compact "vocal profile" the offline engine can sing with.
//
// The profile is a small JSON object (pitch, brightness, breathiness, vibrato…)
// stored per member in localStorage under 'mfs.voice.<memberId>'; the raw
// recording is kept in IndexedDB's 'audio' store under 'voice-<memberId>' so
// the member can preview it and the recorder dialog can show it. The profile
// is what generation uses: gen.js resamples the actual recording for lead
// vocals, so the member's own timbre — not a generic synth — sings their songs.

const VOICE_KEY = (id) => `mfs.voice.${id || 'me'}`;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

// Record up to `seconds` seconds of mic audio. onLevel(0..1) fires every frame
// for a live meter. Resolves with { blob, seconds } — the caller decodes it.
export async function recordVoiceSample({ seconds = 3, onLevel = null } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This browser has no microphone recorder. Try Chrome, Edge or Firefox.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime = ['audio/webm', 'audio/ogg', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const done = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
  });

  // Live level meter via an AnalyserNode on the raw stream.
  let ac = null;
  let raf = 0;
  if (onLevel) {
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is decorative — recording continues without it */ }
  }

  rec.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  if (rec.state !== 'inactive') rec.stop();
  const blob = await done;
  cancelAnimationFrame(raf);
  stream.getTracks().forEach((t) => t.stop());
  if (ac) ac.close().catch(() => {});
  if (!blob.size) throw new Error('The recording came back empty — check that the mic is not muted.');
  return { blob, seconds };
}

// ---------------------------------------------------------------------------
// Analysis — the recording becomes a compact vocal profile
// ---------------------------------------------------------------------------

function decodeBlob(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  return blob.arrayBuffer()
    .then((ab) => ac.decodeAudioData(ab))
    .then((buffer) => { ac.close().catch(() => {}); return buffer; })
    .catch((err) => { ac.close().catch(() => {}); throw err; });
}

function toMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  if (buffer.numberOfChannels > 1) for (let i = 0; i < n; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

// Autocorrelation pitch detector (ACF with parabolic interpolation) on a short
// window. Returns f0 in Hz, or -1 when the window is too quiet/unvoiced.
function detectPitch(x, sr) {
  const SIZE = Math.min(2048, x.length);
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.006) return -1;
  let r1 = 0;
  let r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(x[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(x[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const y = x.slice(r1, r2);
  const n = y.length;
  if (n < 128) return -1;
  const c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += y[i] * y[i + lag];
    c[lag] = sum;
  }
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1;
  let maxpos = -1;
  for (let i = d + 1; i < n - 1; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  if (maxpos <= 0) return -1;
  let T0 = maxpos;
  const x1 = c[T0 - 1];
  const x2 = c[T0];
  const x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);
  const f0 = sr / T0;
  return f0 > 50 && f0 < 1100 ? f0 : -1;
}

// Analyze a decoded AudioBuffer (or raw Blob) into the vocal profile:
//   f0        — median speaking/singing pitch in Hz
//   spread    — how much the pitch wanders (cents stddev across windows)
//   bright    — high-frequency energy ratio (first-difference filter)
//   breathy   — zero-crossing rate, normalized 0..1
//   level     — overall loudness (used for the record dialog's verdict)
export async function analyzeVoiceSample(input) {
  const buffer = input instanceof AudioBuffer ? input : await decodeBlob(input);
  const sr = buffer.sampleRate;
  const x = toMono(buffer);
  const n = x.length;

  // Loudness + high-frequency energy ratio.
  let energy = 0;
  let hEnergy = 0;
  let crossings = 0;
  for (let i = 0; i < n; i++) {
    energy += x[i] * x[i];
    const d = x[i] - (i > 0 ? x[i - 1] : 0);
    hEnergy += d * d;
    if (i > 0 && ((x[i] >= 0) !== (x[i - 1] >= 0))) crossings++;
  }
  const level = Math.sqrt(energy / n);
  const bright = hEnergy / (energy + 1e-9);
  const zcr = crossings / n;

  // Pitch across 8 windows spread over the clip (skips 15% edges).
  const win = Math.min(2048, Math.floor(n / 6));
  const f0s = [];
  if (win >= 256) {
    const startPad = Math.floor(n * 0.12);
    for (let w = 0; w < 8; w++) {
      const off = startPad + Math.floor((n - 2 * startPad - win) * (w / 7));
      const f0 = detectPitch(x.subarray(off, off + win), sr);
      if (f0 > 0) f0s.push(f0);
    }
  }
  f0s.sort((a, b) => a - b);
  const f0 = f0s.length ? f0s[Math.floor(f0s.length / 2)] : 0;
  // Pitch spread: median absolute deviation of log2-ratios, in cents.
  let spread = 0;
  if (f0s.length >= 3) {
    const cents = f0s.map((f) => 1200 * Math.log2(f / f0));
    const med = cents[Math.floor(cents.length / 2)];
    const devs = cents.map((c) => Math.abs(c - med)).sort((a, b) => a - b);
    spread = devs[Math.floor(devs.length / 2)];
  }

  if (!f0 || level < 0.004) {
    return { ok: false, reason: level < 0.004 ? 'too-quiet' : 'no-pitch', f0, spread, bright, breathy: Math.min(1, zcr / 0.25), level };
  }
  return {
    ok: true,
    f0: Math.round(f0 * 10) / 10,
    spread: Math.round(spread),
    bright: Math.round(bright * 1000) / 1000,
    breathy: Math.round(Math.min(1, zcr / 0.25) * 100) / 100,
    level: Math.round(level * 1000) / 1000,
    windows: f0s.length,
  };
}

// Human-readable verdict shown under the meter after recording.
export function describeVoiceProfile(p) {
  if (!p || !p.ok) return 'The recording was not usable — try again a little louder and hold a steady note.';
  const low = p.f0 < 130;
  const high = p.f0 > 260;
  const range = low ? 'a low voice' : high ? 'a high voice' : 'a mid-range voice';
  const air = p.breathy > 0.5 ? ' breathy' : p.bright > 0.45 ? ' bright' : ' warm';
  return `Heard ${range}, ${air} and ${p.spread > 90 ? 'expressive' : 'steady'} — saved to your account.`;
}

// ---------------------------------------------------------------------------
// Per-member persistence
// ---------------------------------------------------------------------------

export function getVoiceSample(memberId = null) {
  try {
    const raw = localStorage.getItem(VOICE_KEY(memberId));
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.ok ? p : null;
  } catch {
    return null;
  }
}

export function storeVoiceSample(memberId, profile) {
  localStorage.setItem(VOICE_KEY(memberId), JSON.stringify({ ...profile, savedAt: Date.now() }));
}

export function clearVoiceSample(memberId = null) {
  localStorage.removeItem(VOICE_KEY(memberId));
}

// The raw recording, for preview playback in the recorder dialog.
export async function storeVoiceAudio(memberId, blob) {
  const { idbPut, idbDelete, idbGet } = await import('./db.js');
  if (blob) await idbPut('audio', { id: `voice-${memberId || 'me'}`, blob });
  else await idbDelete('audio', `voice-${memberId || 'me'}`);
}

export async function getVoiceAudio(memberId = null) {
  const { idbGet } = await import('./db.js');
  const rec = await idbGet('audio', `voice-${memberId || 'me'}`);
  return rec ? rec.blob : null;
}
