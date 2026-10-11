// ai.js — on-device taste learning model
//
// A small neural network (MLP: [styles one-hot + bpm + vocals + mood] -> 16
// tanh -> 1 sigmoid) trained entirely in the browser with plain backpropagation.
// It learns from your interactions — likes, plays, skips, downloads, shares —
// and predicts how much you'll enjoy a candidate song, steering the style and
// tempo used when you generate new music. 100% offline: weights and training
// data live in localStorage; nothing ever leaves the device.

import { STYLES, MOOD_WORDS } from './gen.js';

const AI_KEY = 'musicforstudio.ai.v1';
const HIDDEN = 16;
const LEARN_RATE = 0.06;
const EPOCHS = 40;
const DECAY = 0.02; // L2 weight decay — keeps the tiny net from memorizing noise
const MIN_SAMPLES = 6;
const MAX_SAMPLES = 150;

// Deterministic weight init (seeded) so the model starts identically every time.
function seededRng() {
  let a = 42;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Feature layout (positions stay fixed so persisted weights stay valid as styles
// are added; the model is only ever trained/loaded with one consistent size):
export const BPM_DIM = () => STYLES.length;
export const VOCALS_DIM = () => STYLES.length + 1;
export const CHOIR_DIM = () => STYLES.length + 2;
export const LYRICS_DIM = () => STYLES.length + 3;
export const DENSITY_DIM = () => STYLES.length + 4;
export const MOOD_DIM = () => {
  const o = {};
  Object.keys(MOOD_WORDS).forEach((k, i) => {
    o[k] = STYLES.length + 5 + i;
  });
  return o;
};

export function featureSize() {
  return STYLES.length + 9;
}

export function featuresFor(song) {
  const f = new Float64Array(featureSize());
  STYLES.forEach((s, i) => {
    f[i] = s.id === song.styleId ? 1 : 0;
  });
  const style = STYLES.find((s) => s.id === song.styleId) || STYLES[0];
  const k = STYLES.length;
  f[BPM_DIM()] = ((song.bpm || 100) - 60) / 100;
  f[VOCALS_DIM()] = style.vocal ? 1 : 0;
  f[CHOIR_DIM()] = style.choir ? 1 : 0;
  f[LYRICS_DIM()] = song.lyrics && song.lyrics.trim() ? 1 : 0;
  f[DENSITY_DIM()] = style.density ?? 0.5;
  const p = (song.prompt || '').toLowerCase();
  const mdim = MOOD_DIM();
  for (const key of Object.keys(mdim)) {
    if (MOOD_WORDS[key].some((w) => p.includes(w))) f[mdim[key]] = 1;
  }
  return f;
}

export class TasteNet {
  constructor(nIn) {
    this.nIn = nIn;
    this.nHid = HIDDEN;
    const r = seededRng();
    this.W1 = new Float64Array(this.nHid * nIn);
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (r() - 0.5) * 0.6;
    this.b1 = new Float64Array(this.nHid);
    this.W2 = new Float64Array(this.nHid);
    for (let i = 0; i < this.nHid; i++) this.W2[i] = (r() - 0.5) * 0.6;
    this.b2 = 0;
  }

  forward(x) {
    const h = new Float64Array(this.nHid);
    const w1 = this.W1;
    const b1 = this.b1;
    const nIn = this.nIn;
    for (let j = 0; j < this.nHid; j++) {
      let z = b1[j];
      const off = j * nIn;
      for (let i = 0; i < nIn; i++) z += w1[off + i] * x[i];
      h[j] = Math.tanh(z);
    }
    let z = this.b2;
    const w2 = this.W2;
    for (let j = 0; j < this.nHid; j++) z += w2[j] * h[j];
    return { out: 1 / (1 + Math.exp(-z)), h };
  }

  predict(x) {
    return this.forward(x).out;
  }

  train(samples) {
    const nIn = this.nIn;
    for (let e = 0; e < EPOCHS; e++) {
      for (const s of samples) {
        const { out, h } = this.forward(s.x);
        const dOut = out - s.y;
        const w2 = this.W2;
        const w1 = this.W1;
        const b1 = this.b1;
        // hidden-layer gradients first (before touching W2)
        const dhs = new Float64Array(this.nHid);
        for (let j = 0; j < this.nHid; j++) {
          dhs[j] = dOut * w2[j] * (1 - h[j] * h[j]);
        }
        for (let j = 0; j < this.nHid; j++) {
          w2[j] -= LEARN_RATE * (dOut * h[j] + DECAY * w2[j]);
        }
        this.b2 -= LEARN_RATE * dOut;
        for (let j = 0; j < this.nHid; j++) {
          const off = j * nIn;
          for (let i = 0; i < nIn; i++) w1[off + i] -= LEARN_RATE * (dhs[j] * s.x[i] + DECAY * w1[off + i]);
          b1[j] -= LEARN_RATE * dhs[j];
        }
      }
    }
  }

  serialize() {
    return {
      nIn: this.nIn,
      W1: Array.from(this.W1),
      b1: Array.from(this.b1),
      W2: Array.from(this.W2),
      b2: this.b2,
    };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let model = null;
let samples = []; // { x: Float64Array, y: 1|0, ts: number }
let trainTimer = null;

export function aiInit() {
  try {
    const raw = localStorage.getItem(AI_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && d.inputSize === featureSize() && d.params && Array.isArray(d.samples)) {
        samples = d.samples.map((s) => ({ x: Float64Array.from(s.x), y: s.y, ts: s.ts }));
        model = new TasteNet(d.params.nIn);
        model.W1 = Float64Array.from(d.params.W1);
        model.b1 = Float64Array.from(d.params.b1);
        model.W2 = Float64Array.from(d.params.W2);
        model.b2 = d.params.b2;
      }
      if (d && Array.isArray(d.contextLog)) contextLog = d.contextLog;
      if (d && Array.isArray(d.soundLog)) soundLog = d.soundLog;
    }
  } catch {
    /* fresh start */
  }
  // Weights were already trained (and persisted) when each interaction landed,
  // so load them as-is — retraining from scratch here would overfit the tiny
  // net to the handful of persisted samples and make recommendations flip.
  if (!model) model = new TasteNet(featureSize());
  return samples.length;
}

// Record one piece of feedback: label 1 = liked/enjoyed, 0 = skipped/disliked.
// weight repeats the sample (e.g. a like counts twice as strongly as a play).

// ---------------------------------------------------------------------------
// Context signals (technique from MeloTune: context-aware, privacy-first
// listening). Every interaction logs WHEN it happened — time-of-day bucket and
// weekend — so the engine can learn e.g. “lo-fi for nights, EDM for afternoons”.
// Stays in localStorage like everything else; nothing leaves the device.
// ---------------------------------------------------------------------------
export function currentContext() {
  const h = new Date().getHours();
  const bucket = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night';
  const day = new Date().getDay();
  return { bucket, weekend: day === 0 || day === 6 };
}

let contextLog = []; // { styleId, bucket, y, ts }
let soundLog = []; // { f: {e,d,b,r}, y, ts } — audio-fingerprint feedback

// Audio-fingerprint feedback (technique from genreAI: judge music by its
// extracted sound features, not just its label). main.js computes the
// fingerprint from the rendered audio; recording ties it to the like/skip.
export function aiRecord(song, label, weight = 1) {
  if (!song || !song.styleId) return;
  const x = featuresFor(song);
  for (let w = 0; w < weight; w++) samples.push({ x, y: label ? 1 : 0, ts: Date.now() });
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
  const ctx = currentContext();
  contextLog.push({ styleId: song.styleId, bucket: ctx.bucket, y: label ? 1 : 0, ts: Date.now() });
  if (contextLog.length > MAX_SAMPLES) contextLog = contextLog.slice(-MAX_SAMPLES);
  if (song.audioFeatures) {
    soundLog.push({ f: song.audioFeatures, y: label ? 1 : 0, ts: Date.now() });
    if (soundLog.length > MAX_SAMPLES) soundLog = soundLog.slice(-MAX_SAMPLES);
  }
  clearTimeout(trainTimer);
  trainTimer = setTimeout(() => {
    model.train(samples);
    persist();
  }, 300);
}

function persist() {
  try {
    localStorage.setItem(
      AI_KEY,
      JSON.stringify({
        inputSize: featureSize(),
        samples: samples.map((s) => ({ x: Array.from(s.x), y: s.y, ts: s.ts })),
        params: model.serialize(),
        contextLog,
        soundLog,
      })
    );
  } catch {
    /* storage full — the in-memory model still works for this session */
  }
}

export function aiSampleCount() {
  return samples.length;
}

export function aiReset() {
  samples = [];
  model = new TasteNet(featureSize());
  contextLog = [];
  soundLog = [];
  try {
    localStorage.removeItem(AI_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Sound fingerprint (genreAI technique) — how your liked music SOUNDS vs. the
// library average, in four normalized audio features: energy (e), dynamics
// (d), brightness (b), rhythmic density (r). Generalizes across style labels:
// “you like bright, high-energy music” applies to genres you've barely tried.
// ---------------------------------------------------------------------------
export function aiSoundProfile() {
  const mean = (list) => {
    if (!list.length) return null;
    const acc = { e: 0, d: 0, b: 0, r: 0 };
    for (const it of list) for (const k of Object.keys(acc)) acc[k] += it.f[k] || 0;
    for (const k of Object.keys(acc)) acc[k] /= list.length;
    return acc;
  };
  const liked = mean(soundLog.filter((s) => s.y === 1));
  const all = mean(soundLog);
  const count = soundLog.length;
  if (!liked || !all || count < 3) return { count, confidence: 0 };
  const delta = {};
  for (const k of ['e', 'd', 'b', 'r']) delta[k] = liked[k] - all[k];
  return { count, confidence: Math.min(1, count / 8), liked, all, delta };
}

// Context winner (MeloTune technique): the style you statistically enjoy in
// the CURRENT time bucket, provided there's real evidence and a margin.
export function aiContextStyle() {
  const { bucket } = currentContext();
  const rows = {};
  for (const c of contextLog) {
    if (c.bucket !== bucket) continue;
    rows[c.styleId] = rows[c.styleId] || { pos: 0, tot: 0 };
    rows[c.styleId].tot++;
    if (c.y === 1) rows[c.styleId].pos++;
  }
  let best = null;
  for (const styleId of Object.keys(rows)) {
    if (rows[styleId].tot < 3) continue;
    const rate = (rows[styleId].pos + 1) / (rows[styleId].tot + 2);
    if (!best || rate > best.rate) best = { styleId, ...rows[styleId], rate };
  }
  if (!best) return null;
  const overall = contextLog.length ? contextLog.filter((c) => c.y === 1).length / contextLog.length : 0.5;
  if (best.rate - overall < 0.12) return null; // must beat the baseline clearly
  return { styleId: best.styleId, bucket, count: best.tot, rate: best.rate };
}

// ---------------------------------------------------------------------------
// “Tuned for you” (MY Taste Engine / LastWave technique) — a discovery feed
// built from listening history, seed tracks and the sound fingerprint. Each
// pick carries an honest reason naming the signal that earned its place.
// ---------------------------------------------------------------------------
const FEAT_KEYS = ['e', 'd', 'b', 'r'];

function featureSim(f, mean) {
  if (!f || !mean) return null;
  let dist = 0;
  for (const k of FEAT_KEYS) dist += Math.abs((f[k] || 0) - mean[k]);
  return 1 - dist / FEAT_KEYS.length; // 1 = identical sound
}

export function aiForYou(songs) {
  if (samples.length < MIN_SAMPLES || !songs?.length) return null;
  const prof = aiSoundProfile();
  const { bucket } = currentContext();
  const ctx = {}; // per-style enjoyment rate in this bucket
  for (const c of contextLog) {
    if (c.bucket !== bucket) continue;
    ctx[c.styleId] = ctx[c.styleId] || { pos: 0, tot: 0 };
    ctx[c.styleId].tot++;
    if (c.y === 1) ctx[c.styleId].pos++;
  }
  const gCache = new Map();
  const genreOf = (styleId) => {
    const i = STYLES.findIndex((s) => s.id === styleId);
    if (i < 0) return 0.5;
    if (!gCache.has(i)) gCache.set(i, genreScore(i).score);
    return gCache.get(i);
  };
  const now = Date.now();
  const scored = songs.map((song) => {
    const sim = featureSim(song.audioFeatures, prof.liked);
    const ctxEntry = ctx[song.styleId];
    const ctxRate = ctxEntry && ctxEntry.tot >= 2 ? (ctxEntry.pos + 1) / (ctxEntry.tot + 2) : null;
    const g = genreOf(song.styleId);
    let score = 0.45 * g;
    const parts = { genre: 0.45 * g };
    if (sim != null && prof.confidence > 0) {
      parts.sound = 0.3 * sim;
      score += parts.sound;
    } else {
      parts.pri = 0.15 * (song.liked ? 1 : 0.4);
      score += parts.pri;
    }
    if (ctxRate != null) {
      parts.context = 0.2 * ctxRate;
      score += parts.context;
    }
    score += song.liked ? 0.06 : 0;
    score += !song.plays ? 0.04 : 0; // gentle nudge toward unheard takes
    score -= Math.min(0.15, ((now - (song.createdAt || now)) / 864e5) * 0.01); // fresh-ish bias
    // the dominant signal names the reason
    let reason = 'strong genre match with your taste';
    const best = Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0];
    if (best === 'sound') {
      const hints = [];
      if (sim != null && song.audioFeatures) {
        if (song.audioFeatures.b > (prof.all?.b ?? 0.5) + 0.08) hints.push('bright');
        if (song.audioFeatures.e > (prof.all?.e ?? 0.5) + 0.08) hints.push('high-energy');
        if (song.audioFeatures.d > (prof.all?.d ?? 0.5) + 0.08) hints.push('dynamic');
      }
      reason = hints.length ? `${hints.join(', ')} — the sound you keep coming back to` : 'matches the sound of your liked songs';
    } else if (best === 'context') reason = `a go-to ${bucket} listen`;
    else if (best === 'pri' && song.liked) reason = 'one of your liked songs';
    return { song, score, reason };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

// Feature vector for a style "as itself" (no mood words, no lyrics). All other
// dims use the style's own attributes, so predicts here are directly comparable.
function styleVector(style) {
  const x = new Float64Array(featureSize());
  x[STYLES.findIndex((s) => s.id === style.id)] = 1;
  x[BPM_DIM()] = (style.bpm - 60) / 100;
  x[VOCALS_DIM()] = style.vocal ? 1 : 0;
  x[CHOIR_DIM()] = style.choir ? 1 : 0;
  x[LYRICS_DIM()] = 0;
  x[DENSITY_DIM()] = style.density ?? 0.5;
  return x;
}

// Scores one genre by blending its normalized neural-net prediction with
// Laplace-smoothed direct evidence. Two guards keep the bars honest:
//  - the net's prediction is pulled toward the neutral 0.5 by a genre's own
//    evidence count (total/(total+2)), so an untouched genre stays ~50% instead
//    of drifting on a sparse-data artifact;
//  - a 65/35 blend with the empirical positive rate anchors the score.
function genreScore(i) {
  const rawModel = model ? model.predict(styleVector(STYLES[i])) : 0.5;
  let pos = 0;
  let tot = 0;
  for (const smp of samples) {
    if (smp.x[i] === 1) {
      tot++;
      if (smp.y === 1) pos++;
    }
  }
  const trust = tot / (tot + 2);
  const trustedModel = 0.5 + (rawModel - 0.5) * trust;
  const empirical = (pos + 1) / (tot + 2);
  return { score: 0.65 * trustedModel + 0.35 * empirical, empirical, trustedModel, pos, neg: tot - pos, tot };
}

// Returns { styleIds, bpmBias, densityBias, mood, vocals, topStyle, score,
// count } or null when the model hasn't seen enough feedback yet. The style +
// tempo recommendation is joined by three more learnt biases, all derived from
// your liked vs. skipped songs rather than fragile net probes:
//  - mood     — the mood keyword appearing in the most liked prompts (needs ≥2)
//  - vocals   — 'on' | 'off' | null, from whether you've enjoyed voices more
//  - densityBias — the arrangement-busyness lean, from liked songs' density
// Uses the same style scoring as aiProfile, so the top bar always matches.
export function aiRecommend() {
  if (samples.length < MIN_SAMPLES) return null;
  const scored = STYLES.map((s, i) => ({ style: s, ...genreScore(i) }));
  scored.sort((a, b) => b.score - a.score);
  let top = scored[0];

  // --- tempo nudge: toward the average BPM you've enjoyed, ±12%
  let bpmBias = 0;
  const posBpms = [];
  for (const s of samples) if (s.y === 1) posBpms.push(s.x[BPM_DIM()] * 100 + 60);
  if (posBpms.length) {
    const mean = posBpms.reduce((a, b) => a + b, 0) / posBpms.length;
    const lo = top.style.bpm * 0.88;
    const hi = top.style.bpm * 1.12;
    const target = Math.max(lo, Math.min(hi, mean));
    bpmBias = (target - top.style.bpm) / top.style.bpm;
  }

  // --- density lean: liked songs' styles' density, clamped to ±0.18 of the top style
  let densityBias = 0;
  const posDensities = [];
  for (const s of samples) if (s.y === 1) posDensities.push(s.x[DENSITY_DIM()]);
  if (posDensities.length) {
    const mean = posDensities.reduce((a, b) => a + b, 0) / posDensities.length;
    const bias = mean - top.style.density;
    densityBias = Math.max(-0.18, Math.min(0.18, bias));
  }

  // --- mood preference: which mood appeared in the most of your liked prompts
  let mood = null;
  let bestCount = 0;
  const moodCounts = {};
  const mdim = MOOD_DIM();
  for (const s of samples) {
    if (s.y !== 1) continue;
    for (const key of Object.keys(mdim)) {
      if (s.x[mdim[key]] === 1) moodCounts[key] = (moodCounts[key] || 0) + 1;
    }
  }
  for (const key of Object.keys(moodCounts)) {
    if (moodCounts[key] > bestCount) {
      bestCount = moodCounts[key];
      mood = key;
    }
  }
  if (bestCount < 2) mood = null; // need at least 2 liked songs naming a mood

  // --- voice preference: Laplace-smoothed enjoyment of voiced vs. voiceless songs
  let vocals = null;
  const vdim = VOCALS_DIM();
  const cdim = CHOIR_DIM();
  let posVoices = 0;
  let totVoices = 0;
  let posSilent = 0;
  let totSilent = 0;
  for (const s of samples) {
    if (s.x[vdim] === 1 || s.x[cdim] === 1) {
      totVoices++;
      if (s.y === 1) posVoices++;
    } else {
      totSilent++;
      if (s.y === 1) posSilent++;
    }
  }
  const rateVoices = (posVoices + 1) / (totVoices + 2);
  const rateSilent = (posSilent + 1) / (totSilent + 2);
  if (rateVoices - rateSilent > 0.08) vocals = 'on';
  else if (rateSilent - rateVoices > 0.08) vocals = 'off';

  // --- sound-fingerprint lean (genreAI): if the music you LIKE is brighter /
  // more dynamic / denser than average, nudge the arrangement that way.
  const sound = aiSoundProfile();
  let soundHints = null;
  if (sound.confidence > 0) {
    densityBias += Math.max(-0.1, Math.min(0.1, sound.delta.d * 0.3 + sound.delta.b * 0.2));
    const hints = [];
    if (sound.delta.b > 0.1) hints.push('bright');
    else if (sound.delta.b < -0.1) hints.push('warm');
    if (sound.delta.e > 0.12) hints.push('punchy');
    if (sound.delta.r > 0.1) hints.push('driving');
    if (hints.length) soundHints = hints.join(', ');
  }

  // --- context switch (MeloTune): if you reliably enjoy a different style in
  // the current time bucket than the overall winner, prefer it now.
  const ctx = aiContextStyle();
  let contextUsed = false;
  if (ctx && ctx.styleId !== top.style.id) {
    const i = STYLES.findIndex((s) => s.id === ctx.styleId);
    if (i >= 0) {
      const ctxEntry = genreScore(i);
      if (ctxEntry.score > top.score + 0.04) {
        top = { style: STYLES[i], ...ctxEntry };
        contextUsed = true;
      }
    }
  }

  return {
    styleIds: [top.style.id],
    bpmBias,
    densityBias,
    mood,
    vocals,
    soundHints,
    contextStyle: ctx,
    contextUsed,
    topStyle: top.style,
    score: top.score,
    count: samples.length,
  };
}

// Per-genre predicted affinity, ranked high→low. Uses the exact same scoring as
// aiRecommend, so the top row always equals the current suggestion, and an
// untouched genre always sits at ~50% until direct feedback arrives — which is
// what makes the learning visible over time.
export function aiProfile() {
  const rows = STYLES.map((s, i) => ({
    id: s.id,
    label: s.label,
    bpm: s.bpm,
    ...genreScore(i),
  }));
  rows.sort((a, b) => b.score - a.score);
  return { rows, count: samples.length };
}
