// ---------------------------------------------------------------------------
// SFX Studio — procedural sound-effect synthesizer (from brev.ai's "AI Sound
// Effects" idea, done honestly offline). Each effect is pure deterministic
// DSP written straight to a 16-bit PCM WAV, so a (type, seed) pair always
// produces the exact same audio — SFX songs re-render from their stored
// params just like engine songs do from their seed.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const SFX_TYPES = [
  { id: 'boom', label: '💥 Boom', hint: 'deep cinematic impact' },
  { id: 'laser', label: '🔫 Laser', hint: 'sci-fi zap' },
  { id: 'whoosh', label: '💨 Whoosh', hint: 'fast fly-by' },
  { id: 'coin', label: '🪙 Coin', hint: 'arcade pickup' },
  { id: 'rain', label: '🌧️ Rain', hint: 'steady downpour loop' },
  { id: 'thunder', label: '⛈️ Thunder', hint: 'distant rumble + crack' },
  { id: 'alarm', label: '🚨 Alarm', hint: 'urgent beeping' },
  { id: 'glitch', label: '📺 Glitch', hint: 'digital stutter burst' },
];

const SR = 44100;

// Simple one-pole lowpass for noise shaping.
function lowpass(data, alpha) {
  let v = 0;
  for (let i = 0; i < data.length; i++) {
    v += alpha * (data[i] - v);
    data[i] = v;
  }
}

function synth(type, rng) {
  const mk = (seconds) => new Float32Array(Math.floor(seconds * SR));
  switch (type) {
    case 'boom': {
      const out = mk(1.6);
      const f0 = 90 + rng() * 50;
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const f = f0 * Math.exp(-t * 4) + 24;
        const ph = 2 * Math.PI * f * t;
        const body = Math.sin(ph) * Math.exp(-t * 3.2) * 0.9;
        out[i] = body;
      }
      // transient click layer
      for (let i = 0; i < SR * 0.03 && i < out.length; i++) out[i] += (rng() * 2 - 1) * (1 - i / (SR * 0.03)) * 0.5;
      return out;
    }
    case 'laser': {
      const out = mk(0.45);
      const f0 = 1400 + rng() * 900;
      const f1 = 160 + rng() * 90;
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const p = t / (out.length / SR);
        const f = f0 * Math.pow(f1 / f0, p);
        // phase accumulates for a proper sweep
        out[i] = Math.sign(Math.sin(2 * Math.PI * f0 * (Math.pow(f1 / f0, p) - 1) / Math.log(f1 / f0))) * Math.exp(-p * 3) * 0.55;
      }
      return out;
    }
    case 'whoosh': {
      const out = mk(1.1);
      const n = out.map(() => rng() * 2 - 1);
      lowpass(n, 0.12 + rng() * 0.06);
      for (let i = 0; i < out.length; i++) {
        const p = i / out.length;
        const env = Math.sin(Math.PI * p) ** 2; // swell in, fade out
        out[i] = n[i] * env * 0.85;
      }
      return out;
    }
    case 'coin': {
      const out = mk(0.5);
      const b = 988, e = 1319; // B5 → E6
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const f = t < 0.08 ? b : e;
        const lt = t < 0.08 ? t : t - 0.08;
        const env = Math.exp(-lt * (t < 0.08 ? 6 : 9));
        out[i] = (Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.28 + Math.sin(2 * Math.PI * f * t) * 0.22) * env;
      }
      return out;
    }
    case 'rain': {
      const out = mk(3);
      const n = out.map(() => rng() * 2 - 1);
      lowpass(n, 0.45); // patter-ish
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const fade = Math.min(1, t / 0.4, (out.length / SR - t) / 0.5);
        const gust = 0.8 + 0.2 * Math.sin(2 * Math.PI * 0.4 * t + rng() * 0.02);
        out[i] = n[i] * 0.5 * fade * gust + n[i] * n[i] * 0.15;
      }
      return out;
    }
    case 'thunder': {
      const out = mk(2.6);
      const n = out.map(() => rng() * 2 - 1);
      lowpass(n, 0.05);
      const crack = mk(0.06).map(() => (rng() * 2 - 1));
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const env = Math.exp(-t * 1.4) * (1 + 0.3 * Math.sin(2 * Math.PI * 7 * t));
        out[i] = n[i] * env * 0.95;
        if (i < crack.length) out[i] += crack[i] * (1 - i / crack.length) * 0.8;
      }
      return out;
    }
    case 'alarm': {
      const out = mk(2);
      const f = 720 + rng() * 160;
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const on = Math.floor(t / 0.25) % 2 === 0;
        const lt = t % 0.25;
        const env = Math.min(1, lt / 0.01, (0.25 - lt) / 0.05);
        out[i] = (on ? Math.sin(2 * Math.PI * f * t) * 0.4 : Math.sin(2 * Math.PI * f * 0.66 * t) * 0.28) * env;
      }
      return out;
    }
    case 'glitch': {
      const out = mk(1);
      let i = 0;
      while (i < out.length) {
        const seg = Math.floor((0.004 + rng() * 0.05) * SR);
        const f = 80 + Math.floor(rng() * 30) * 60;
        const sq = rng() < 0.6;
        const hold = rng() < 0.3;
        const v = rng() * 2 - 1;
        for (let j = 0; j < seg && i < out.length; j++, i++) {
          const t = j / SR;
          const env = Math.exp(-(i / out.length) * 2);
          out[i] = (hold ? v : sq ? Math.sign(Math.sin(2 * Math.PI * f * t)) : Math.sin(2 * Math.PI * f * t)) * 0.4 * env;
        }
      }
      return out;
    }
    default:
      return mk(0.5);
  }
}

function wavFromMono(mono) {
  const n = mono.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const ws = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ws(36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Deterministic per (type, seed): same params → bit-identical WAV.
export function generateSfxWav({ type = 'boom', seed }) {
  const s = typeof seed === 'number' ? seed : hashSeed(String(seed));
  const rng = mulberry32(s ^ hashSeed(type));
  const mono = synth(type, rng);
  return { blob: wavFromMono(mono), duration: mono.length / SR };
}
