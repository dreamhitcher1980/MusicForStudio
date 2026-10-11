// Generative audio engine for MusicForStudio.
// Turns a prompt + style + title into an ORIGINAL, deterministic track.
// Every stage of synthesis runs in plain JavaScript, sample by sample — no
// WebAudio rendering nodes — so the same seed always produces the exact same
// PCM output, bit for bit. Different prompts produce different music. No
// samples, no external content, no AI APIs — everything is synthesized from
// scratch.

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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

const SEMITONES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
const PENT_MINOR = [0, 3, 5, 7, 10];
const PENT_MAJOR = [0, 2, 4, 7, 9];

export const STYLES = [
  { id: 'dance', label: 'Dance & EDM', bpm: 126, mode: 'minor', pent: 'minor', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'sawtooth', leadWave: 'sawtooth', pad: true, delay: 0.5, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.16, bassGain: 0.22, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.5, choir: false },
  { id: 'house', label: 'House', bpm: 122, mode: 'dorian', pent: 'minor', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: true, delay: 0.5, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.15, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.45, choir: true },
  { id: 'hiphop', label: 'Hip-Hop', bpm: 92, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.4, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.75, density: 0.45, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.2, bassGain: 0.26, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.4, choir: false },
  { id: 'lofi', label: 'Lo-Fi Beats', bpm: 78, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0.5, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.75, density: 0.4, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.18, bassGain: 0.24 },
  { id: 'synthwave', label: 'Synthwave', category: 'Electronic & Dance', beat: 'four', bpm: 110, mode: 'minor', pent: 'minor', fourFloor: true, hatStep: 8, swing: 0, bassWave: 'sawtooth', leadWave: 'sawtooth', pad: true, delay: 0.75, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.14, bassGain: 0.2, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.55, choir: true, vocBright: 1.1, vocBreath: 0.2, vocVibrato: 6, scene: 'Synthwave: 110 BPM, pulsing retro synths, 80s drum machine, driving bassline, neon night vibe' },
  { id: 'pop', label: 'Pop', bpm: 116, mode: 'major', pent: 'major', fourFloor: true, hatStep: 8, swing: 0, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.375, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.6, choir: true },
  { id: 'rock', label: 'Rock', bpm: 142, mode: 'mixolydian', pent: 'major', fourFloor: false, hatStep: 8, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: false, delay: 0.375, density: 0.7, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.15, leadGain: 0.15, bassGain: 0.2 },
  { id: 'metal', label: 'Metal', bpm: 150, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: false, delay: 0.25, density: 0.75, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.12, leadGain: 0.13, bassGain: 0.18 },
  { id: 'jazz', label: 'Classic Jazz', category: 'Acoustic, Jazz & Folk', beat: 'four', bpm: 96, mode: 'minor', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.5, bassWave: 'triangle', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.4, leadGain: 0.17, bassGain: 0.2, seventh: true, scene: 'Classic Jazz: swing rhythm, upright bass, smoky saxophone solo, walking bassline, lounge mood' },
  { id: 'ambient', label: 'Ambient', bpm: 64, mode: 'major', pent: 'major', fourFloor: false, hatStep: 0, swing: 0, bassWave: 'sine', leadWave: 'sine', pad: true, delay: 1, density: 0.3, rootOct: 1, leadOct: 3, dist: 0, reverb: 0.6, leadGain: 0.2, bassGain: 0.16, choir: true, vocalVowel: 'oo' },
  { id: 'classical', label: 'Classical', bpm: 76, mode: 'major', pent: 'major', fourFloor: false, hatStep: 0, swing: 0, bassWave: 'triangle', leadWave: 'sine', pad: true, delay: 0.5, density: 0.5, rootOct: 1, leadOct: 3, dist: 0, reverb: 0.45, leadGain: 0.18, bassGain: 0.16, choir: true, vocalVowel: 'ah' },
  { id: 'reggaeton', label: 'Reggaeton', bpm: 98, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.3, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.5, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.18, leadGain: 0.16, bassGain: 0.26, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.5, choir: true },
  { id: 'afrobeat', label: 'Afrobeats', category: 'Global Urban & Regional Scenes', beat: 'skank', bpm: 106, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.35, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.5, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.22, leadGain: 0.16, bassGain: 0.24, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.5, choir: true, vocBright: 1.1, vocBreath: 0.3, vocVibrato: 6, scene: 'Afrobeats (Nigeria / West Africa): polyrhythmic percussion, infectious syncopated dance grooves, sunny brass horn sections, smooth autotuned vocals' },
  { id: 'funk', label: 'Funk', bpm: 110, mode: 'mixolydian', pent: 'major', fourFloor: false, hatStep: 16, swing: 0.5, bassWave: 'square', leadWave: 'triangle', pad: true, delay: 0.25, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.18, leadGain: 0.17, bassGain: 0.24, seventh: true, vocal: 'syllable', vocalOct: 12, vocalVowel: 'oh', vocalDensity: 0.4, choir: true },
  { id: 'soul', label: 'Soul', bpm: 84, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.3, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.45, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.3, leadGain: 0.18, bassGain: 0.22, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.55, choir: true },
  { id: 'disco', label: 'Disco', bpm: 118, mode: 'major', pent: 'major', fourFloor: true, hatStep: 16, swing: 0.15, bassWave: 'square', leadWave: 'sawtooth', pad: true, delay: 0.375, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.24, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.5, choir: true },
  { id: 'country', label: 'Country', bpm: 100, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.2, bassWave: 'triangle', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.18, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.5, choir: false },
  { id: 'blues', label: 'Blues', bpm: 88, mode: 'mixolydian', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.6, bassWave: 'triangle', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.45, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.18, bassGain: 0.2, seventh: true },
  { id: 'latin', label: 'Latin', bpm: 102, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.4, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.24, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.5, choir: false },
  { id: 'techno', label: 'Techno', category: 'Electronic & Dance', beat: 'four', bpm: 130, mode: 'minor', pent: 'minor', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: true, delay: 0.5, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.14, bassGain: 0.24, vocBright: 0.9, vocBreath: 0.15, vocVibrato: 4, scene: 'Techno: 130 BPM, industrial warehouse vibe, dark hypnotic repetition, driving modular synths' },
  { id: 'trance', label: 'Trance', bpm: 138, mode: 'minor', pent: 'minor', fourFloor: true, hatStep: 8, swing: 0, bassWave: 'sawtooth', leadWave: 'sawtooth', pad: true, delay: 0.75, density: 0.65, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.3, leadGain: 0.14, bassGain: 0.2, choir: true, vocalVowel: 'oo' },
  { id: 'dubstep', label: 'Dubstep', bpm: 140, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0.2, bassWave: 'sawtooth', leadWave: 'sawtooth', pad: false, delay: 0.375, density: 0.7, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.12, leadGain: 0.14, bassGain: 0.26 },
  { id: 'phonk', label: 'Phonk', category: 'Underground Electronic Subcultures', beat: 'boomBap', bpm: 86, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.45, bassWave: 'sine', leadWave: 'square', pad: false, delay: 0.375, density: 0.6, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.1, leadGain: 0.15, bassGain: 0.3, vocal: 'syllable', vocalOct: 12, vocalVowel: 'oo', vocalDensity: 0.4, vocBright: 0.85, vocBreath: 0.15, vocVibrato: 5, scene: 'Phonk (Eastern Europe / Memphis roots): distorted cowbells, slowed-down 80s Memphis rap tapes, heavy distorted bass, dark drift racing aesthetic' },
  { id: 'kpop', label: 'K-Pop', category: 'Global Urban & Regional Scenes', beat: 'four', bpm: 120, mode: 'major', pent: 'major', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.375, density: 0.7, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.65, choir: true, vocBright: 1.3, vocBreath: 0.35, vocVibrato: 8, scene: 'K-Pop (South Korea): ultra-polished maximalist pop production, sudden genre switches, explosive electronic dance beats, catchy hooks, high-energy vocals' },
  { id: 'ballad', label: 'Ballad', bpm: 70, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.1, bassWave: 'sine', leadWave: 'sine', pad: true, delay: 0.75, density: 0.4, rootOct: 1, leadOct: 3, dist: 0, reverb: 0.45, leadGain: 0.2, bassGain: 0.16, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.45, choir: true },
  { id: 'gospel', label: 'Gospel', bpm: 82, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.2, bassWave: 'triangle', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.18, bassGain: 0.18, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.55, choir: true },

  // ---- Curated genre scenes (with descriptive prompts, beats and vocal character)
  { id: 'upbeatpop', label: 'Upbeat Pop', category: 'Pop & Electronic', beat: 'four', bpm: 120, mode: 'major', pent: 'major', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.375, density: 0.65, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.62, choir: true, vocBright: 1.25, vocBreath: 0.3, vocVibrato: 8, scene: 'Upbeat Pop: 120 BPM, bright synths, catchy chorus, energetic female vocals, self-discovery theme' },
  { id: 'futuresynth', label: 'Futuristic Synthwave', category: 'Pop & Electronic', beat: 'four', bpm: 100, mode: 'minor', pent: 'minor', fourFloor: true, hatStep: 8, swing: 0, bassWave: 'sawtooth', leadWave: 'sawtooth', pad: true, delay: 0.75, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.15, bassGain: 0.2, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.5, choir: true, vocBright: 1.1, vocBreath: 0.2, vocVibrato: 6, scene: 'Futuristic Synthwave: pulsing synths, rolling bass, driving 80s beat, retro-futuristic mood' },
  { id: 'festivalanthem', label: 'EDM Festival Anthem', category: 'Pop & Electronic', beat: 'four', bpm: 128, mode: 'minor', pent: 'minor', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: true, delay: 0.5, density: 0.7, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.3, leadGain: 0.15, bassGain: 0.24, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.6, choir: true, vocBright: 1.2, vocBreath: 0.4, vocVibrato: 8, scene: 'EDM Festival Anthem: 128 BPM, massive drop, high energy, heavy bass synthesizer, massive crowd atmosphere' },
  { id: 'boombap', label: 'Boom Bap Hip-Hop', category: 'Hip-Hop, R&B & Reggae', beat: 'boomBap', bpm: 90, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.5, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.75, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.18, bassGain: 0.24, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.4, vocBright: 0.85, vocBreath: 0.15, vocVibrato: 5, scene: 'Boom Bap Hip-Hop: 90 BPM, gritty vinyl drums, classic boom-bap feel, mellow groove, conversational male rap flow' },
  { id: 'southerntrap', label: 'Southern Trap', category: 'Hip-Hop, R&B & Reggae', beat: 'trap', bpm: 72, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.3, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.375, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.15, bassGain: 0.3, vocal: 'syllable', vocalOct: 12, vocalVowel: 'oo', vocalDensity: 0.5, vocBright: 0.9, vocBreath: 0.2, vocVibrato: 6, scene: 'Southern Trap: booming 808s, slow heavy bass, dark atmospheric pads, catchy melodic hook' },
  { id: 'smoothrnb', label: 'Smooth R&B', category: 'Hip-Hop, R&B & Reggae', beat: 'four', bpm: 74, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.35, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.4, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.18, bassGain: 0.22, vocal: 'syllable', vocalOct: 24, vocalVowel: 'oo', vocalDensity: 0.55, choir: true, vocBright: 1.05, vocBreath: 0.35, vocVibrato: 7, scene: 'Smooth R&B: slow tempo, warm electric piano chords, sensual mood, soft soulful vocals' },
  { id: 'classicrock', label: 'Classic Rock', category: 'Rock, Punk & Metal', beat: 'four', bpm: 138, mode: 'mixolydian', pent: 'major', fourFloor: true, hatStep: 8, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: false, delay: 0.375, density: 0.6, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.15, leadGain: 0.16, bassGain: 0.2, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.4, vocBright: 0.8, vocBreath: 0.15, vocVibrato: 5, scene: 'Classic Rock: electric guitar riffs, driving acoustic drums, rebellious energy, gritty raw male vocals' },
  { id: 'poppunk', label: 'Modern Pop-Punk', category: 'Rock, Punk & Metal', beat: 'four', bpm: 176, mode: 'major', pent: 'major', fourFloor: true, hatStep: 8, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: false, delay: 0.25, density: 0.7, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.12, leadGain: 0.15, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.55, vocBright: 1.15, vocBreath: 0.35, vocVibrato: 7, scene: 'Modern Pop-Punk: upbeat tempo, fast palm-muted guitar distortion, emotional high-energy vocals, nostalgic mood' },
  { id: 'chillhop', label: 'Lo-Fi Chillhop', category: 'Acoustic, Jazz & Folk', beat: 'boomBap', bpm: 85, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0.5, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.75, density: 0.4, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.18, bassGain: 0.22, crackle: 0.35, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.35, choir: true, vocBright: 1.0, vocBreath: 0.25, vocVibrato: 5, scene: 'Lo-Fi Chillhop: 85 BPM, soft vinyl crackle, mellow jazz guitar loop, relaxed lazy beat, cozy atmosphere' },
  { id: 'cinematicambient', label: 'Cinematic Ambient', category: 'Cinematic & Orchestral', beat: 'half', bpm: 58, mode: 'major', pent: 'major', fourFloor: false, hatStep: 0, swing: 0, bassWave: 'sine', leadWave: 'sine', pad: true, delay: 1, density: 0.3, rootOct: 1, leadOct: 3, dist: 0, reverb: 0.6, leadGain: 0.2, bassGain: 0.16, choir: true, vocalVowel: 'oo', vocBright: 1.0, vocBreath: 0.2, vocVibrato: 4, scene: 'Cinematic Ambient: deep ambient sleep drone, slow evolving orchestral strings, zero gravity, dark academia rain texture' },

  // ---- Rock, Punk & Metal
  { id: 'heavymetal', label: 'Heavy Metal', category: 'Rock, Punk & Metal', beat: 'doubleBass', bpm: 150, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: false, delay: 0.25, density: 0.75, rootOct: 0, leadOct: 2, dist: 1, reverb: 0.1, leadGain: 0.14, bassGain: 0.22, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.45, vocBright: 0.75, vocBreath: 0.12, vocVibrato: 4, scene: 'Heavy Metal: double bass drums, down-tuned heavy guitar riffs, aggressive vocals, dark atmosphere' },
  { id: 'indierock', label: 'Indie Rock', category: 'Rock, Punk & Metal', beat: 'four', bpm: 118, mode: 'dorian', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0.15, bassWave: 'triangle', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.3, leadGain: 0.16, bassGain: 0.2, crackle: 0.18, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.45, vocBright: 0.95, vocBreath: 0.25, vocVibrato: 6, scene: 'Indie Rock: jangling guitars, melodic bassline, lo-fi aesthetic, melancholic lyrics, male vocals' },

  // ---- Hip-Hop, R&B & Reggae
  { id: 'trap', label: 'Trap', category: 'Hip-Hop, R&B & Reggae', beat: 'trap', bpm: 140, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.25, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.375, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.18, leadGain: 0.15, bassGain: 0.3, vocal: 'syllable', vocalOct: 12, vocalVowel: 'oo', vocalDensity: 0.5, vocBright: 0.9, vocBreath: 0.2, vocVibrato: 6, scene: 'Trap: 140 BPM, booming 808 bass, rapid hi-hats, dark cinematic keys, aggressive delivery' },
  { id: 'neosoul', label: 'Neo-Soul', category: 'Hip-Hop, R&B & Reggae', beat: 'boomBap', bpm: 80, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.4, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.45, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.18, bassGain: 0.22, seventh: true, vocal: 'syllable', vocalOct: 24, vocalVowel: 'oo', vocalDensity: 0.55, choir: true, vocBright: 1.05, vocBreath: 0.35, vocVibrato: 7, scene: 'Neo-Soul: smooth electric piano, laid-back groove, sensual mood, warm soulful female vocals' },
  { id: 'dancehall', label: 'Reggae / Dancehall', category: 'Hip-Hop, R&B & Reggae', beat: 'skank', bpm: 88, mode: 'major', pent: 'major', fourFloor: false, hatStep: 16, swing: 0.5, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.25, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.22, leadGain: 0.17, bassGain: 0.26, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.45, vocBright: 1.0, vocBreath: 0.25, vocVibrato: 6, scene: 'Reggae / Dancehall: offbeat guitar skanks, heavy dub bassline, tropical rhythm, danceable groove' },

  // ---- Electronic & Dance
  { id: 'synthpop', label: 'Synth-Pop', category: 'Electronic & Dance', beat: 'four', bpm: 118, mode: 'major', pent: 'major', fourFloor: true, hatStep: 8, swing: 0.05, bassWave: 'square', leadWave: 'sawtooth', pad: true, delay: 0.5, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.2, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.6, choir: true, vocBright: 1.2, vocBreath: 0.3, vocVibrato: 8, scene: 'Synth-Pop: bright synth melodies, danceable electronic beats, polished pop vocals, catchy hook' },
  { id: 'deephouse', label: 'Deep House', category: 'Electronic & Dance', beat: 'four', bpm: 124, mode: 'dorian', pent: 'minor', fourFloor: true, hatStep: 16, swing: 0.1, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.16, bassGain: 0.24, seventh: true, vocal: 'syllable', vocalOct: 24, vocalVowel: 'oo', vocalDensity: 0.4, choir: true, vocBright: 1.0, vocBreath: 0.25, vocVibrato: 6, scene: 'Deep House: 124 BPM, four-on-the-floor kick, warm chord stabs, deep sub-bass, hypnotic groove' },

  // ---- Acoustic, Jazz & Folk
  { id: 'acousticfolk', label: 'Acoustic Folk', category: 'Acoustic, Jazz & Folk', beat: 'four', bpm: 84, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.15, bassWave: 'triangle', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.45, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.3, leadGain: 0.18, bassGain: 0.18, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.5, vocBright: 1.0, vocBreath: 0.25, vocVibrato: 6, scene: 'Acoustic Folk: strummed acoustic guitar, warm cello accompaniment, intimate vocals, storytelling vibe' },

  // ---- Cinematic & Orchestral
  { id: 'epicorchestral', label: 'Epic Orchestral', category: 'Cinematic & Orchestral', beat: 'four', bpm: 120, mode: 'major', pent: 'major', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'triangle', leadWave: 'sawtooth', pad: true, delay: 0.5, density: 0.7, rootOct: 1, leadOct: 3, dist: 0, reverb: 0.55, leadGain: 0.16, bassGain: 0.2, choir: true, vocalVowel: 'ah', vocBright: 1.15, vocBreath: 0.2, vocVibrato: 5, scene: 'Epic Orchestral: building brass staccatos, sweeping orchestral strings, cinematic percussion, heroic mood' },
  { id: 'darkambient', label: 'Dark Ambient', category: 'Cinematic & Orchestral', beat: 'half', bpm: 55, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 0, swing: 0, bassWave: 'sine', leadWave: 'sine', pad: true, delay: 1, density: 0.25, rootOct: 1, leadOct: 3, dist: 0, reverb: 0.7, leadGain: 0.2, bassGain: 0.16, crackle: 0.12, choir: true, vocalVowel: 'oo', vocBright: 0.9, vocBreath: 0.15, vocVibrato: 4, scene: 'Dark Ambient: slow evolving drone, ethereal pads, zero gravity atmosphere, rain texture' },

  // ---- Global Urban & Regional Scenes
  { id: 'ukdrill', label: 'UK Drill', category: 'Global Urban & Regional Scenes', beat: 'trap', bpm: 140, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.2, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.5, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.15, leadGain: 0.16, bassGain: 0.3, vocal: 'syllable', vocalOct: 12, vocalVowel: 'oo', vocalDensity: 0.5, vocBright: 0.8, vocBreath: 0.2, vocVibrato: 5, scene: 'UK Drill (United Kingdom): 140 BPM, sliding 808 basslines, erratic hi-hat patterns, dark eerie piano loops, aggressive street-level lyricism' },
  { id: 'latintrap', label: 'Latin Trap & Reggaeton', category: 'Global Urban & Regional Scenes', beat: 'trap', bpm: 98, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 16, swing: 0.35, bassWave: 'sine', leadWave: 'square', pad: true, delay: 0.375, density: 0.55, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.28, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.55, choir: true, vocBright: 1.15, vocBreath: 0.3, vocVibrato: 7, scene: 'Latin Trap & Reggaeton (Puerto Rico / Colombia): dembow rhythm, booming bass, seductive syncopated groove, party energy, melodic Spanish vocals' },
  { id: 'amapiano', label: 'Amapiano', category: 'Global Urban & Regional Scenes', beat: 'boomBap', bpm: 110, mode: 'major', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.4, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.5, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.25, leadGain: 0.17, bassGain: 0.24, seventh: true, vocal: 'syllable', vocalOct: 24, vocalVowel: 'oo', vocalDensity: 0.45, vocBright: 1.05, vocBreath: 0.3, vocVibrato: 6, scene: 'Amapiano (South Africa): 110 BPM, deep log-drum basslines, jazzy lounge piano keys, airy percussive loops, soulful African house vibe' },

  // ---- Underground Electronic Subcultures
  { id: 'eurodance', label: 'Eurodance & Hands Up', category: 'Underground Electronic Subcultures', beat: 'four', bpm: 140, mode: 'major', pent: 'major', fourFloor: true, hatStep: 16, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: true, delay: 0.375, density: 0.65, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.2, leadGain: 0.16, bassGain: 0.22, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ah', vocalDensity: 0.6, choir: true, vocBright: 1.25, vocBreath: 0.3, vocVibrato: 8, scene: 'Eurodance & Hands Up (90s/00s Europe): 140 BPM, driving uplifting synths, four-on-the-floor kick, nostalgic rave chords, energetic female vocals' },
  { id: 'hyperpop', label: 'Hyperpop', category: 'Underground Electronic Subcultures', beat: 'four', bpm: 160, mode: 'major', pent: 'major', fourFloor: true, hatStep: 16, swing: 0.05, bassWave: 'sawtooth', leadWave: 'square', pad: true, delay: 0.25, density: 0.75, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.15, leadGain: 0.17, bassGain: 0.22, vocal: 'syllable', vocalOct: 24, vocalVowel: 'ee', vocalDensity: 0.7, choir: true, vocBright: 1.45, vocBreath: 0.4, vocVibrato: 10, scene: 'Hyperpop (Internet/PC Music scene): glitched 160 BPM beats, pitched-up metallic synths, extreme vocal processing, chaotic maximalist pop' },
  { id: 'liquiddnb', label: 'Liquid Drum & Bass', category: 'Underground Electronic Subcultures', beat: 'dnb', bpm: 174, mode: 'dorian', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0.1, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.5, density: 0.6, rootOct: 0, leadOct: 2, dist: 0, reverb: 0.35, leadGain: 0.15, bassGain: 0.24, seventh: true, choir: true, vocalVowel: 'oo', vocBright: 1.0, vocBreath: 0.2, vocVibrato: 6, scene: 'Liquid Drum & Bass (UK Club Scene): 174 BPM, fast rolling breaks, atmospheric ambient pads, deep sub-bass, smooth jazzy elements' },

  // ---- Alt, Indie & Regional Rock Scenes
  { id: 'grunge', label: 'Seattle Grunge', category: 'Alt, Indie & Regional Rock Scenes', beat: 'four', bpm: 116, mode: 'minor', pent: 'minor', fourFloor: false, hatStep: 8, swing: 0, bassWave: 'square', leadWave: 'sawtooth', pad: false, delay: 0.25, density: 0.6, rootOct: 1, leadOct: 2, dist: 1, reverb: 0.15, leadGain: 0.16, bassGain: 0.22, vocal: 'syllable', vocalOct: 12, vocalVowel: 'ah', vocalDensity: 0.5, vocBright: 0.7, vocBreath: 0.2, vocVibrato: 5, scene: 'Seattle Grunge (90s USA): heavy fuzz guitar distortion, dynamic quiet-loud transitions, angsty slacker vocals, dark alternative rock' },
  { id: 'shoegaze', label: 'Shoegaze', category: 'Alt, Indie & Regional Rock Scenes', beat: 'four', bpm: 92, mode: 'mixolydian', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.1, bassWave: 'triangle', leadWave: 'sawtooth', pad: true, delay: 0.75, density: 0.5, rootOct: 1, leadOct: 2, dist: 0.6, reverb: 0.55, leadGain: 0.16, bassGain: 0.18, choir: true, vocalVowel: 'ah', vocBright: 0.9, vocBreath: 0.3, vocVibrato: 7, scene: 'Shoegaze (UK Dream Pop): wall of sound, swirling guitar reverb, heavy audio feedback, buried ethereal vocals, dreamy melancholic atmosphere' },
  { id: 'desertrock', label: 'Desert Rock / Stoner Metal', category: 'Alt, Indie & Regional Rock Scenes', beat: 'half', bpm: 90, mode: 'mixolydian', pent: 'major', fourFloor: false, hatStep: 8, swing: 0.15, bassWave: 'sawtooth', leadWave: 'sawtooth', pad: false, delay: 0.5, density: 0.5, rootOct: 0, leadOct: 2, dist: 1, reverb: 0.2, leadGain: 0.16, bassGain: 0.26, vocal: 'syllable', vocalOct: 12, vocalVowel: 'oo', vocalDensity: 0.4, vocBright: 0.75, vocBreath: 0.15, vocVibrato: 4, scene: 'Desert Rock / Stoner Metal (California Desert): downtuned fuzzy guitars, heavy hypnotic grooves, psychedelic blues riffs, dry dusty atmosphere' },
  { id: 'citypop', label: 'City Pop', category: 'Alt, Indie & Regional Rock Scenes', beat: 'four', bpm: 100, mode: 'major', pent: 'major', fourFloor: true, hatStep: 8, swing: 0.4, bassWave: 'sine', leadWave: 'triangle', pad: true, delay: 0.375, density: 0.6, rootOct: 1, leadOct: 2, dist: 0, reverb: 0.3, leadGain: 0.17, bassGain: 0.22, seventh: true, vocal: 'syllable', vocalOct: 24, vocalVowel: 'oo', vocalDensity: 0.55, choir: true, vocBright: 1.1, vocBreath: 0.3, vocVibrato: 7, scene: 'City Pop (80s Japan): smooth jazz-fusion chords, funky slap basslines, glamorous retro production, breezy nostalgic late-night drive vibe' },
];

const PROGRESSIONS = {
  major: [
    [0, 5, 3, 4],
    [3, 4, 0, 5],
    [0, 4, 5, 3],
    [3, 0, 4, 5],
    [0, 5, 1, 4],
  ],
  minor: [
    [0, 5, 3, 4],
    [0, 3, 5, 6],
    [5, 3, 4, 5],
    [0, 4, 3, 5],
    [0, 5, 1, 4],
  ],
};

// Drum patterns on a per-bar 16th-note grid. Each returns kick/snare for a step.
// Hats are handled separately (swung 16ths + an extra tick for 16-note styles).
export function makeBeat(id) {
  switch (id) {
    case 'boomBap': // classic boom-bap: kick on 1, the "and" of 2, and the "and" of 3
      return (n) => ({ kick: n === 0 || n === 7 || n === 10, snare: n === 4 || n === 12 });
    case 'trap': // sparse 808-style kicks with halftime snare
      return (n) => ({ kick: n === 0 || n === 6 || n === 10 || n === 14, snare: n === 4 || n === 12 });
    case 'half': // halftime: sparse kick, snare on 3 and 4
      return (n) => ({ kick: n === 0 || n === 12, snare: n === 4 || n === 8 });
    case 'skank': // gritty skank: kick on 1, snare backbeat
      return (n) => ({ kick: n === 0, snare: n === 4 || n === 12 });
    case 'doubleBass': // rolling blast-beat kicks
      return (n) => ({ kick: n % 2 === 0, snare: n === 4 || n === 12 });
    case 'dnb': // rolling drum & bass break (kick + snare syncopation)
      return (n) => ({ kick: n === 0 || n === 5 || n === 11, snare: n === 4 || n === 12 });
    default: // four-on-the-floor
      return (n) => ({ kick: n % 4 === 0, snare: n === 4 || n === 12 });
  }
}

export const MOOD_WORDS = {
  dark: ['dark', 'melancholic', 'sad', 'gloomy', 'noir', 'haunting'],
  bright: ['bright', 'happy', 'sunny', 'upbeat', 'joyful', 'shimmering'],
  chill: ['chill', 'calm', 'mellow', 'soft', 'dreamy', 'relaxed'],
  epic: ['epic', 'cinematic', 'powerful', 'anthem', 'grand', 'huge'],
};

function pickStyle(styleIds, rng) {
  const ids = styleIds && styleIds.length ? styleIds : ['pop'];
  const pool = STYLES.filter((s) => ids.includes(s.id));
  return pool[Math.floor(rng() * pool.length)] || STYLES[0];
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// Build the generation spec. `opts` carries AI-taste steering: bpmBias (tempo
// nudge), densityBias (busy vs. sparse arrangement), mood (forced mood keyword)
// and vocals ('on' | 'off' | 'female' | 'male' | 'mine' | null). 'mine' sings
// with the signed-in member's recorded voice (voiceSample).
// A member's voice signature: deterministic vocal timbre params derived from
// their id, so every member's vocals sound distinct and consistent across all
// their songs — their own "voiceprint" for music and the videos made from it.
function voiceCharacter(sig) {
  if (sig == null) return null;
  const rng = mulberry32((Number(sig) >>> 0) || 1);
  return {
    bright: 0.85 + rng() * 0.45,      // formant brightness multiplier
    cents: Math.round((rng() * 2 - 1) * 55), // subtle pitch shade (±55 cents)
    vibrato: 3.5 + rng() * 5,         // vibrato depth in cents
    breath: 0.08 + rng() * 0.3,       // breathiness amount
    scoop: 18 + rng() * 26,           // how much notes scoop into pitch
    detune: 6 + rng() * 7,            // double-track detune width
  };
}

function buildSpec(style, prompt, rng, { bpmBias = 0, densityBias = 0, mood: moodOverride = null, vocals = null, durationSec = 0, voiceSig = null, voiceSample = null } = {}) {
  let s = style;
  // Apply the AI's voice preference: add syllable vocals to an instrumental
  // style, or strip voices from a vocal one — clone so the preset is untouched.
  if (vocals === 'on' || vocals === 'female' || vocals === 'male' || (vocals === 'mine' && voiceSample)) {
    if (!s.vocal && !s.choir) {
      s = { ...s, vocal: 'syllable', choir: false, vocalOct: s.vocalOct || (s.leadOct === 3 ? 24 : 12), vocalVowel: 'ah', vocalDensity: s.density };
    }
  } else if (vocals === 'off') {
    if (s.vocal || s.choir) s = { ...s, vocal: false, choir: false };
  }
  // Voice character: 'female' sings an octave-flip up with a brighter formant,
  // 'male' sits low and darker. Subtle, but clearly audible on vocal styles.
  if ((vocals === 'female' || vocals === 'male') && s.vocal) {
    const oct = s.vocalOct || 12;
    s = { ...s, vocalOct: vocals === 'female' ? oct + 12 : Math.max(0, oct - 12), vocBright: vocals === 'female' ? 1.25 : 0.85 };
  }

  const mood = moodOverride || Object.keys(MOOD_WORDS).find((m) => MOOD_WORDS[m].some((w) => prompt.toLowerCase().includes(w))) || null;
  let bpm = s.bpm;
  if (mood === 'chill') bpm = Math.round(bpm * 0.9);
  if (mood === 'epic') bpm = Math.round(bpm * 1.05);
  if (mood === 'dark') bpm = Math.round(bpm * 0.95);
  if (bpmBias) bpm = Math.round(bpm * (1 + bpmBias)); // AI tempo nudge

  const rootMidi = 45 + Math.floor(rng() * 12); // A1..G#2-ish
  const scale = SEMITONES[s.mode] || SEMITONES.minor;
  const progs = PROGRESSIONS[s.mode === 'dorian' || s.mode === 'mixolydian' ? (s.mode === 'dorian' ? 'minor' : 'major') : s.mode] || PROGRESSIONS.minor;
  const progression = progs[Math.floor(rng() * progs.length)];

  const barSeconds = (4 * 60) / bpm;
  // Default to a ~26 s clip; a durationSec target (e.g. a 3–4 min full song)
  // expands the arrangement into that many repeated loops, so renderSong fills
  // the requested length with structure that builds as it repeats.
  const target = durationSec || 26;
  const loops = Math.max(2, Math.min(64, Math.round(target / (barSeconds * 4))));
  const seconds = barSeconds * 4 * loops;
  const density = Math.max(0.05, Math.min(0.95, (s.density || 0.5) + (densityBias || 0)));

  // 'mine' + a usable profile: lead vocals become the member's real recording.
  const useSample = vocals === 'mine' && voiceSample && voiceSample.ok && voiceSample.f0 > 0;
  return { style: s, bpm, rootMidi, scale, progression, loops, seconds, rng, mood, density, voxChar: voiceCharacter(voiceSig), mineVoice: useSample ? voiceSample : null };
}

// ---------------------------------------------------------------------------
// Pure-JS DSP
// ---------------------------------------------------------------------------
// Everything below renders sample by sample into plain Float32Arrays. No
// WebAudio nodes are involved, so a given seed always produces the exact same
// PCM output — bit-for-bit identical across runs on the same engine. (WebAudio's
// OfflineAudioContext renderer is a black box whose internal floating-point
// rounding is not reproducible, which is why the whole chain lives here.)

const SR = 44100;

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

function oscPhase(wave, p) {
  switch (wave) {
    case 'square':
      return Math.sin(2 * Math.PI * p) >= 0 ? 1 : -1;
    case 'sawtooth':
      return 2 * p - 1;
    case 'triangle':
      return 4 * Math.abs(p - 0.5) - 1;
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

// RBJ biquad with fixed coefficients (deterministic; state kept in `f`).
function makeBiquad(type, f, q) {
  const w0 = (2 * Math.PI * Math.min(Math.max(f, 1), SR / 2 - 1)) / SR;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'bandpass') {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    // lowpass
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function bqStep(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

// Exponential attack/sustain/release envelope parameters (per-sample ratios).
function envParams(gain, attack, release) {
  const atkS = Math.max(1, Math.round(attack * SR));
  const relS = Math.max(1, Math.round(release * SR));
  return {
    atkS,
    relS,
    atkRatio: Math.pow(gain / 0.0001, 1 / atkS),
    relRatio: Math.pow(0.0001 / gain, 1 / relS),
  };
}

// Add src (starting at sample 0) into dst at an offset in seconds, times gain.
function addAt(dst, src, t, gain = 1) {
  const off = Math.round(t * SR);
  const n = Math.min(src.length, dst.length - off);
  if (n <= 0) return;
  for (let i = 0; i < n; i++) dst[off + i] += src[i] * gain;
}

// Oscillator + envelope + optional lowpass (the "tone" voice).
function toneBuf({ dur, freq, wave, gain, attack = 0.01, release = 0.08, detune = 0, filter = 0 }) {
  const n = Math.max(1, Math.ceil(dur * SR));
  const out = new Float32Array(n);
  const f = (freq * Math.pow(2, detune / 1200)) / SR;
  const { atkS, relS, atkRatio, relRatio } = envParams(gain, attack, release);
  const lpF = filter ? makeBiquad('lowpass', filter, 1) : null;
  let phase = 0;
  let env = 0.0001;
  for (let i = 0; i < n; i++) {
    if (i < atkS) env *= atkRatio;
    else if (i >= n - relS) env *= relRatio;
    let x = oscPhase(wave, phase);
    if (lpF) x = bqStep(lpF, x);
    out[i] = x * env;
    phase += f;
    if (phase >= 1) phase -= 1;
  }
  return out;
}

// White noise with attack + exponential decay, optional serial hp/bp filters.
function noiseBuf({ dur, gain, hp = 0, bp = 0, q = 1, attack = 0.001, rng }) {
  const n = Math.max(1, Math.ceil(dur * SR));
  const out = new Float32Array(n);
  const atkS = Math.max(1, Math.round(attack * SR));
  const decS = Math.max(1, n - atkS);
  const atkRatio = Math.pow(gain / 0.0001, 1 / atkS);
  const decRatio = Math.pow(0.0001 / gain, 1 / decS);
  const hpF = hp ? makeBiquad('highpass', hp, 1) : null;
  const bpF = bp ? makeBiquad('bandpass', bp, q) : null;
  let env = 0.0001;
  for (let i = 0; i < n; i++) {
    if (i < atkS) env *= atkRatio;
    else env *= decRatio;
    let x = rng() * 2 - 1;
    if (hpF) x = bqStep(hpF, x);
    if (bpF) x = bqStep(bpF, x);
    out[i] = x * env;
  }
  return out;
}

// Kick: sine with exponential pitch sweep (150 -> 46 Hz) and exponential decay.
function kickBuf({ dur, gain }) {
  const n = Math.max(1, Math.ceil(dur * SR));
  const out = new Float32Array(n);
  const fRatio = Math.pow(46 / 150, 1 / n);
  const envRatio = Math.pow(0.0001 / gain, 1 / n);
  let phase = 0;
  let f = 150;
  let env = gain;
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(2 * Math.PI * phase) * env;
    phase += f / SR;
    if (phase >= 1) phase -= 1;
    f *= fRatio;
    env *= envRatio;
  }
  return out;
}

// Formant tables for synthesized vowels (frequency, bandwidth, relative gain)
const FORMANTS = {
  ah: [
    { f: 730, b: 90, g: 1.0 },
    { f: 1090, b: 110, g: 0.5 },
    { f: 2440, b: 160, g: 0.22 },
  ],
  oo: [
    { f: 300, b: 60, g: 1.0 },
    { f: 870, b: 90, g: 0.4 },
    { f: 2240, b: 140, g: 0.18 },
  ],
  ee: [
    { f: 270, b: 70, g: 1.0 },
    { f: 2290, b: 130, g: 0.6 },
    { f: 3010, b: 160, g: 0.3 },
  ],
  oh: [
    { f: 400, b: 80, g: 1.0 },
    { f: 800, b: 100, g: 0.5 },
    { f: 2600, b: 150, g: 0.22 },
  ],
};

// Resample a Float32Array by `rate` with linear interpolation — the primitive
// that shifts a recorded voice's pitch (rate > 1 → higher/chipmunk-free for
// small rates; we keep rates within ±4 semitones so the timbre stays natural).
function resampleLinear(buf, rate) {
  if (!buf || !buf.length) return new Float32Array(1);
  if (Math.abs(rate - 1) < 1e-6) return buf;
  const n = Math.max(1, Math.floor(buf.length / rate));
  const out = new Float32Array(n);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = buf[i0] || 0;
    const b = buf[i0 + 1] || a;
    out[i] = a + (b - a) * frac;
    pos += rate;
  }
  return out;
}

// Sing a note with a member's RECORDED voice: the mic sample is pitch-shifted
// to the note and reshaped with a syllable envelope. Deterministic — the same
// seed + sample reproduces the exact same audio byte-for-byte. `samp` is the
// analyzed profile { f0, ok, ... }; `audio` the raw Float32Array at 44.1kHz.
const SAMPLE_SILENT = new Float32Array(1);
function sampleVoiceBuf({ dur, freq, gain, attack = 0.04, release = 0.09, f0, audio, brightness = 1, rng }) {
  if (!audio || audio.length < 64) return SAMPLE_SILENT;
  const n = Math.max(1, Math.ceil(dur * SR));
  const out = new Float32Array(n);
  // Pitch shift = resample ratio from the recorded f0 to the target note.
  const rate = Math.max(0.4, Math.min(3.5, freq / Math.max(60, f0 || 160)));
  // A little head-and-tail trim keeps consonant clicks out of the loop.
  const trim = Math.min(Math.floor(audio.length * 0.04), Math.round(0.03 * SR));
  const body = audio.subarray(trim, audio.length - trim);
  // Pick a slight offset per note (seeded) so repeated notes don't sound cloned.
  const off = Math.floor(rng() * Math.max(1, body.length - Math.floor(body.length * 0.6)));
  const src = resampleLinear(body.subarray(off), rate);
  // Crossfade-loop the shifted sample to cover the note's full duration.
  const loopLen = src.length;
  const fade = Math.max(64, Math.min(2048, Math.floor(loopLen * 0.08)));
  const { atkS, relS, atkRatio, relRatio } = envParams(gain, Math.max(0.012, attack), release);
  let env = 0.0001;
  for (let i = 0; i < n; i++) {
    if (i < atkS) env *= atkRatio;
    else if (i >= n - relS) env *= relRatio;
    let s;
    if (i < loopLen) s = src[i];
    else {
      const li = (i - loopLen) % Math.max(1, loopLen - fade);
      s = li < loopLen - fade ? src[li] : src[li] * (1 - (li - (loopLen - fade)) / fade) + src[li + fade - loopLen] * ((li - (loopLen - fade)) / fade);
    }
    // First-difference brightness tilt, applied AFTER pitch shifting (so the
    // member's recorded EQ survives; the tilt only opens or closes the highs).
    if (brightness !== 1) {
      const hp = s - (i > 0 ? out[i - 1] : 0);
      s = s + (brightness - 1) * hp * 2.2;
    }
    out[i] = s * env;
  }
  return out;
}

// Humanized vocal synthesizer. On top of the formant-filtered saws + vibrato, it
// adds the micro-articulations that make a voice feel human:
//  - bright  = formant brightness (bright high voices / darker chesty voices)
//  - breath  = filtered air noise riding the envelope (audible "breath")
//  - scoop   = a small pitch settle into the note (sings "into" the pitch)
//  - wobble  = a slow seeded pitch drift (vocal instability)
//  - shaped vibrato that swells in/out instead of being constant
// Everything seeded, so the same prompt reproduces the same vocal, byte-for-byte.
function voiceBuf({ dur, freq, gain, vowel = 'ah', attack = 0.04, release = 0.09, detuneSpread = 9, vibrato = 6, bright = 1, breath = 0.2, scoop = 30, rng }) {
  const n = Math.max(1, Math.ceil(dur * SR));
  const out = new Float32Array(n);
  const pitchScale = Math.pow(freq / 261.63, 0.35);
  const formants = (FORMANTS[vowel] || FORMANTS.ah).map((fm) => ({
    f: makeBiquad('bandpass', Math.max(220, Math.min(9000, fm.f * pitchScale * bright)), fm.f / fm.b),
    g: fm.g,
  }));
  const { atkS, relS, atkRatio, relRatio } = envParams(gain, Math.max(0.015, attack), release);
  const voices = [];
  for (let v = 0; v < 2; v++) {
    voices.push({
      phase: 0,
      lfoPhase: 0,
      detune: (v === 0 ? -1 : 1) * detuneSpread * (0.5 + rng() * 0.5),
      lfoF: vibrato ? (5.2 + rng() * 0.8) / SR : 0,
      vibrato,
    });
  }
  // slow vocal wobble + a breath bandpass (both deterministic via the seeded rng)
  const wobF = (0.4 + rng() * 0.35) / SR;
  const wobDepth = 1.5 + rng() * 2.5;
  const wobPhase = rng() * Math.PI * 2;
  const breathF = makeBiquad('bandpass', 2200 + rng() * 800, 0.9);
  const scoopSteps = Math.max(1, Math.round(0.05 * SR));
  let env = 0.0001;
  for (let i = 0; i < n; i++) {
    if (i < atkS) env *= atkRatio;
    else if (i >= n - relS) env *= relRatio;
    let x = 0;
    for (const vc of voices) {
      // vibrato swells in and out; a pitch scoop settles into the note; wobble adds drift
      const vibDepth = vc.vibrato * Math.min(1, i / (0.15 * SR)) * Math.min(1, (n - i) / (0.15 * SR));
      const scoopOff = scoop * Math.max(0, 1 - i / scoopSteps);
      const wob = Math.sin(2 * Math.PI * wobPhase + 2 * Math.PI * wobF * i) * wobDepth;
      const cents = vc.detune + Math.sin(2 * Math.PI * vc.lfoPhase) * vibDepth + scoopOff + wob;
      const f = (freq * Math.pow(2, cents / 1200)) / SR;
      x += oscPhase('sawtooth', vc.phase);
      vc.phase += f;
      if (vc.phase >= 1) vc.phase -= 1;
      vc.lfoPhase += vc.lfoF;
      if (vc.lfoPhase >= 1) vc.lfoPhase -= 1;
    }
    x *= 0.5;
    let y = 0;
    for (const fm of formants) y += fm.g * bqStep(fm.f, x);
    // breathy air — filtered white noise riding the envelope
    out[i] = y * env + bqStep(breathF, rng() * 2 - 1) * breath * 0.14 * env;
  }
  return out;
}

// Feedback delay line with wet/dry mix.
function applyDelay(buf, delayTime, feedback, wet) {
  const n = buf.length;
  const dl = Math.max(1, Math.round(delayTime * SR));
  const out = new Float32Array(n);
  const ring = new Float32Array(dl);
  let wp = 0;
  for (let i = 0; i < n; i++) {
    let rp = wp - dl;
    if (rp < 0) rp += dl;
    const d = ring[rp];
    ring[wp] = buf[i] + d * feedback;
    out[i] = d * wet;
    if (++wp === dl) wp = 0;
  }
  return out;
}

// Schroeder reverb: 4 damped combs (seeded lengths) + 2 series allpasses.
function applyReverb(buf, amount, rng) {
  const n = buf.length;
  const combLen = [0.0297, 0.0371, 0.0411, 0.0437];
  const combFb = [0.742, 0.733, 0.715, 0.694];
  const combs = combLen.map((len, i) => {
    const dl = Math.max(1, Math.round((len + rng() * 0.002) * SR));
    return {
      ring: new Float32Array(dl),
      wp: 0,
      fb: combFb[i],
      lp: 0,
      lpA: Math.exp((-2 * Math.PI * (6500 - i * 400)) / SR),
    };
  });
  const mkAllpass = (D, g) => {
    const dl = Math.max(1, Math.round(D * SR));
    const ring = new Float32Array(dl);
    let wp = 0;
    return (x) => {
      let rp = wp - dl;
      if (rp < 0) rp += dl;
      const d = ring[rp];
      ring[wp] = x + g * d;
      if (++wp === dl) wp = 0;
      return d - g * x;
    };
  };
  const ap1 = mkAllpass(0.005, 0.7);
  const ap2 = mkAllpass(0.0017, 0.5);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    let tap = 0;
    for (const c of combs) {
      let rp = c.wp - c.ring.length;
      if (rp < 0) rp += c.ring.length;
      const raw = c.ring[rp];
      c.lp += (1 - c.lpA) * (raw - c.lp);
      c.ring[c.wp] = x + c.fb * c.lp;
      if (++c.wp === c.ring.length) c.wp = 0;
      tap += c.lp;
    }
    out[i] = ap2(ap1(tap)) * amount;
  }
  return out;
}

// Soft-clip distortion (rock/metal lead).
function distort(buf) {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.tanh(2.2 * 1.6 * buf[i]);
  return out;
}

// Master fade in/out (exponential, matching the old master gain envelope).
function applyMasterEnv(buf, seconds) {
  const n = buf.length;
  const fadeInS = Math.max(1, Math.round(0.6 * SR));
  const fadeOutStart = Math.round((seconds - 1.6) * SR);
  const fadeOutEnd = Math.min(n, Math.round((seconds - 0.1) * SR));
  const fadeOutS = Math.max(1, fadeOutEnd - fadeOutStart);
  const inRatio = Math.pow(0.85 / 0.0001, 1 / fadeInS);
  const outRatio = Math.pow(0.0001 / 0.85, 1 / fadeOutS);
  let g = 0.0001;
  for (let i = 0; i < n; i++) {
    if (i < fadeInS) g *= inRatio;
    else if (i >= fadeOutStart) g *= outRatio;
    else g = 0.85;
    buf[i] *= g;
  }
}

// Pure-JS dynamics compressor (replaces DynamicsCompressorNode, which is not
// bit-deterministic). Threshold -14 dB, ratio 4:1, attack 4 ms, release 180 ms,
// plus ~3 dB makeup.
function jsCompress(data) {
  const len = data.length;
  const threshold = Math.pow(10, -14 / 20);
  const ratio = 4;
  const atk = Math.exp(-1 / (SR * 0.004));
  const rel = Math.exp(-1 / (SR * 0.18));
  const makeup = 1.35;
  let env = 0;
  for (let i = 0; i < len; i++) {
    const peak = Math.abs(data[i]);
    env = peak > env ? atk * env + (1 - atk) * peak : rel * env + (1 - rel) * peak;
    let gain = 1;
    if (env > threshold) gain = Math.pow(threshold / env, 1 - 1 / ratio);
    data[i] *= gain * makeup;
  }
}

function monoToAudioBuffer(mono) {
  const buf = new AudioBuffer({ length: mono.length, numberOfChannels: 2, sampleRate: SR });
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  for (let i = 0; i < mono.length; i++) {
    l[i] = mono[i];
    r[i] = mono[i];
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Arrangement & rendering
// ---------------------------------------------------------------------------

async function renderSong(spec, rng) {
  const { style, bpm, rootMidi, scale, progression, loops, seconds, density = style.density } = spec;
  // Optional note collector: when spec.notes is an array, every synthesized
  // note is logged there — the source for the MIDI exporter (see notesToMidi).
  const notes = Array.isArray(spec.notes) ? spec.notes : null;
  const pushNote = (t, d, m, tr, vel) => { if (notes) notes.push({ t, d, m, tr, vel }); };
  const total = Math.max(1, Math.ceil(seconds * SR));
  const master = new Float32Array(total);
  const leadBus = new Float32Array(total);
  const drumBus = new Float32Array(total);

  const beat = 60 / bpm;
  const step = beat / 2;
  const barBeats = 4;
  const bars = progression.length;
  const totalSteps = bars * barBeats * 2;
  const loopSeconds = beat * barBeats * bars;

  // ---- Harmony: chord progression repeated across every loop
  const chords = [];
  for (let l = 0; l < loops; l++) {
    for (let b = 0; b < bars; b++) {
      const degree = progression[b];
      const semis = scale[degree % 7] + 12 * Math.floor(degree / 7);
      const root = rootMidi + semis;
      const third = root + (scale[(degree + 2) % 7] + 12 * Math.floor((degree + 2) / 7) - scale[degree % 7]);
      const fifth = root + (scale[(degree + 4) % 7] + 12 * Math.floor((degree + 4) / 7) - scale[degree % 7]);
      const chord = [root, third, fifth];
      if (style.seventh) {
        chord.push(root + (scale[(degree + 6) % 7] + 12 * Math.floor((degree + 6) / 7) - scale[degree % 7]));
      }
      chords.push({ start: l * loopSeconds + b * barBeats * beat, dur: barBeats * beat, root, chord, loop: l });
    }
  }

  // ---- Pads (detuned saws, straight to master)
  if (style.pad) {
    for (const c of chords) {
      for (const n of c.chord) {
        pushNote(c.start, c.dur * 0.98, n + 12, 3, 62);
        const f = midiToFreq(n + 12);
        for (const det of [-6, 6]) {
          addAt(master, toneBuf({ dur: c.dur * 0.98, freq: f, wave: 'sawtooth', gain: 0.045, attack: 0.55, release: 0.6, detune: det, filter: 2200 }), c.start);
        }
      }
    }
    await yieldToUI();
  }

  // ---- Bass
  for (const c of chords) {
    const pattern = style.fourFloor ? [0, 0, 7, 0, 12, 0, 7, 0] : [0, 7, 12, 0, 0, 7, 0, 12];
    for (let i = 0; i < 4; i++) {
      const t = c.start + i * beat;
      const semi = pattern[(i * 2) % pattern.length];
      pushNote(t, beat * 0.85, c.root + 12 * style.rootOct + semi, 1, 96);
      addAt(master, toneBuf({
        dur: beat * 0.85,
        freq: midiToFreq(c.root + 12 * style.rootOct + semi),
        wave: style.bassWave,
        gain: style.bassGain,
        attack: 0.005,
        release: 0.05,
        filter: 420,
      }), t);
    }
  }
  await yieldToUI();

  // ---- Drums (16th-note grid, driven by the style's beat pattern)
  if (style.hatStep) {
    const step16 = step / 2; // 16th note = half an 8th
    const bar16 = barBeats * 4;
    const beatF = makeBeat(style.beat);
    for (let l = 0; l < loops; l++) {
      for (let b = 0; b < bars; b++) {
        const barT = l * loopSeconds + b * barBeats * beat;
        for (let n = 0; n < bar16; n++) {
          const t = barT + n * step16;
          const swung = t + (n % 2 === 1 ? style.swing * step16 : 0);
          const ev = beatF(n);
          if (ev.kick) {
            pushNote(t, 0.24, 36, 0, 112);
            addAt(master, kickBuf({ dur: 0.24, gain: 0.82 }), t);
            if (style.beat === 'trap' || style.beat === 'boomBap') {
              pushNote(t + step16 * 2, 0.32, 36, 0, 70);
              addAt(master, kickBuf({ dur: 0.32, gain: 0.4 }), t + step16 * 2);
            }
          }
          if (ev.snare) {
            pushNote(swung, 0.16, 38, 0, 100);
            addAt(drumBus, noiseBuf({ dur: 0.16, gain: 0.42, bp: 1900, q: 0.9, attack: 0.002, rng }), swung);
            addAt(drumBus, toneBuf({ dur: 0.09, freq: 190, wave: 'triangle', gain: 0.22 }), swung);
          }
          // hats: swung backbeat + a tight tick on the 16s
          if (n % 2 === 1 || style.hatStep === 16) {
            pushNote(swung, 0.03, 42, 0, 58);
            addAt(drumBus, noiseBuf({ dur: 0.03, gain: 0.1 + rng() * 0.06, hp: 7600, attack: 0.001, rng }), swung);
          }
          if (style.hatStep === 16 && n % 2 === 1) {
            addAt(drumBus, noiseBuf({ dur: 0.016, gain: 0.07, hp: 7600, attack: 0.001, rng }), t + 0.001);
          }
        }
      }
    }
  }

  // ---- Vinyl crackle (lo-fi texture) — sparse random clicks, fully seeded
  if (style.crackle) {
    for (let i = 0; i < total; i += 1 + Math.floor(rng() * 9000)) {
      if (rng() < 0.2) master[i] += (rng() < 0.5 ? -1 : 1) * (0.008 + rng() * 0.025) * style.crackle;
    }
  }
  await yieldToUI();

  // ---- Lead melody
  const pent = style.pent === 'major' ? PENT_MAJOR : PENT_MINOR;
  const leadRoot = rootMidi + 12 * (style.leadOct - 1);
  const leadNotes = pent.map((s) => leadRoot + s);
  const motif = [];
  const motifLen = 8; // steps
  for (let i = 0; i < motifLen; i++) {
    motif.push(rng() < density ? Math.floor(rng() * leadNotes.length) : null);
  }
  let idx = Math.floor(rng() * leadNotes.length);
  const wander = (base) => {
    idx = Math.max(0, Math.min(leadNotes.length - 1, base + (rng() < 0.6 ? (rng() < 0.5 ? -1 : 1) : rng() < 0.5 ? -2 : 2)));
  };

  for (let s = 0; s < totalSteps * loops; s++) {
    const loopIdx = Math.floor(s / totalSteps);
    const sIn = s % totalSteps;
    const barInLoop = Math.floor(sIn / (barBeats * 2));
    const posInBar = sIn % (barBeats * 2);
    let stepIdx = motif[posInBar % motifLen];
    if (barInLoop >= 2 && stepIdx != null) stepIdx = Math.min(leadNotes.length - 1, stepIdx + (rng() < 0.5 ? 2 : -2));
    if (loopIdx >= 2 && stepIdx != null) stepIdx = Math.min(leadNotes.length - 1, stepIdx + 1); // chorus lift
    if (stepIdx == null) {
      if (rng() < 0.25) wander(idx);
      continue;
    }
    const note = leadNotes[Math.max(0, Math.min(leadNotes.length - 1, stepIdx))];
    wander(stepIdx);
    const t = loopIdx * loopSeconds + sIn * step;
    const dur = rng() < 0.35 ? step * 1.9 : step * 0.92;
    const vel = 0.7 + rng() * 0.3;
    pushNote(t, dur, note, 2, Math.round(60 + vel * 40));
    addAt(leadBus, toneBuf({
      dur,
      freq: midiToFreq(note),
      wave: style.leadWave,
      gain: style.leadGain * vel,
      attack: 0.008,
      release: 0.07,
      filter: style.dist ? 0 : 3800,
    }), t);
    if (rng() < 0.18) {
      // harmony third
      pushNote(t, dur * 0.9, note + 4, 2, 52);
      addAt(leadBus, toneBuf({
        dur: dur * 0.9,
        freq: midiToFreq(note + 4),
        wave: style.leadWave,
        gain: style.leadGain * vel * 0.45,
        attack: 0.008,
        release: 0.07,
        filter: 3200,
      }), t);
    }
  }
  await yieldToUI();

  // ---- Vocals
  const hasVocals = !!style.vocal || !!style.choir;
  const vocalBus = new Float32Array(total);
  if (hasVocals) {
    const vowel = style.vocalVowel || 'ah';

    // Choir pads: sustained vowel on chord tones, entering on the second loop.
    // Each chord's voice stack is rendered once and reused for every loop
    // occurrence (identical notes, identical duration).
    if (style.choir) {
      for (let b = 0; b < bars; b++) {
        const c = chords[b];
        const parts = [];
        for (const n of c.chord) {
          pushNote(c.start, c.dur * 0.96, n + 12, 3, 55);
          const f = midiToFreq(n + 12);
          for (let v = 0; v < 3; v++) {
            parts.push(voiceBuf({ dur: c.dur * 0.96, freq: f, gain: 0.028, vowel, attack: 0.7, release: 0.8, detuneSpread: 13, vibrato: 4, bright: (style.vocBright || 1) * (spec.voxChar ? 0.92 + spec.voxChar.bright * 0.1 : 1), breath: (style.vocBreath ?? 0.2) * 0.4, scoop: 12, rng }));
          }
        }
        let stackLen = 0;
        for (const p of parts) if (p.length > stackLen) stackLen = p.length;
        const stack = new Float32Array(stackLen);
        for (const p of parts) {
          for (let i = 0; i < p.length; i++) stack[i] += p[i];
        }
        for (let l = 0; l < loops; l++) {
          addAt(vocalBus, stack, l * loopSeconds + b * barBeats * beat);
        }
      }
    }

    // Syllable lead: chord-tone melody sung from the second loop
    if (style.vocal) {
      const vScale = style.pent === 'major' ? PENT_MAJOR : PENT_MINOR;
      const vRoot = rootMidi + style.vocalOct; // vocalOct is already in semitones
      const vNotes = vScale.map((s) => vRoot + s);
      const chordTonesOf = (c) => [c.root, c.chord[1], c.chord[2]].map((m) => m + style.vocalOct);
      const density = style.vocalDensity || 0.5;
      let vIdx = Math.floor(rng() * vNotes.length);

      for (let s = 0; s < totalSteps * loops; s++) {
        const loopIdx = Math.floor(s / totalSteps);
        if (loopIdx === 0) continue; // instrumental intro
        const sIn = s % totalSteps;
        const t = loopIdx * loopSeconds + sIn * step;
        const chordIdx = Math.floor(sIn / (barBeats * 2)) % bars;
        const c = chords[chordIdx];
        const barPos = sIn % (barBeats * 2);
        const barIdx = Math.floor(sIn / (barBeats * 2));
        const isLanding = barPos === barBeats * 2 - 1 && barIdx === bars - 1;

        let sing;
        if (isLanding) sing = true;
        else if (barPos === barBeats * 2 - 1) sing = rng() < 0.55;
        else sing = rng() < density;

        if (!sing) {
          if (rng() < 0.3) vIdx = Math.max(0, Math.min(vNotes.length - 1, vIdx + (rng() < 0.5 ? -1 : 1)));
          continue;
        }

        let midi;
        if (isLanding) {
          const tones = chordTonesOf(c);
          midi = tones[0] + 12; // root an octave up for a lift at phrase ends
        } else if (rng() < 0.65) {
          const tones = chordTonesOf(c);
          midi = tones[Math.floor(rng() * tones.length)];
        } else {
          vIdx = Math.max(0, Math.min(vNotes.length - 1, vIdx + (rng() < 0.5 ? -1 : 1)));
          midi = vNotes[vIdx];
        }

        const dur = isLanding ? beat * 2 : rng() < 0.4 ? beat * 0.95 : step * 0.92;
        const vel = 0.85 + rng() * 0.3;
        pushNote(t, dur, midi, 4, Math.round(70 + vel * 30));
        const vox = spec.voxChar;
        const mv = spec.mineVoice;
        addAt(vocalBus,
          mv && mv.audio
            ? sampleVoiceBuf({
              dur,
              freq: midiToFreq(midi),
              gain: 0.14 * vel,
              attack: 0.02,
              release: 0.08,
              f0: mv.f0,
              audio: mv.audio,
              brightness: 0.85 + (mv.bright || 0.3),
              rng,
            })
            : voiceBuf({
          dur,
          freq: midiToFreq(midi) * (vox ? Math.pow(2, vox.cents / 1200) : 1),
          gain: 0.1 * vel,
          vowel,
          attack: 0.035,
          release: 0.09,
          detuneSpread: vox ? vox.detune : 8,
          vibrato: vox ? vox.vibrato : (style.vocVibrato || 7),
          bright: (style.vocBright || 1) * (vox ? vox.bright : 1),
          breath: vox ? vox.breath : (style.vocBreath ?? 0.2),
          scoop: vox ? vox.scoop : 30,
          rng,
        }), t);
      }
    }
    await yieldToUI();
  }

  // ---- Lead processing: distortion, delay echo, reverb sends
  const leadOut = style.dist ? distort(leadBus) : leadBus;
  addAt(master, leadOut, 0, 1);
  addAt(master, applyDelay(leadOut, style.delay * beat, 0.32, 0.32), 0);

  const reverbIn = new Float32Array(total);
  addAt(reverbIn, leadOut, 0, 0.3);
  addAt(reverbIn, drumBus, 0, 0.18);
  if (hasVocals) addAt(reverbIn, vocalBus, 0, 0.42);
  addAt(master, applyReverb(reverbIn, style.reverb, rng), 0);

  // ---- Final mix: buses into master, fade, compress
  addAt(master, drumBus, 0, 0.8);
  if (hasVocals) addAt(master, vocalBus, 0, 1);
  applyMasterEnv(master, seconds);
  jsCompress(master);

  const buffer = monoToAudioBuffer(master);
  return { buffer, seconds, hasVocals };
}

// ---------------------------------------------------------------------------
// WAV encoding
// ---------------------------------------------------------------------------

export function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const length = buffer.length;
  const ab = new ArrayBuffer(44 + length * numCh * 2);
  const dv = new DataView(ab);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  dv.setUint32(4, 36 + length * numCh * 2, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numCh * 2, true);
  dv.setUint16(32, numCh * 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, length * numCh * 2, true);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateTrack({ title, prompt, styles = [], lyrics = '', seedOverride, bpmBias = 0, densityBias = 0, mood = null, vocals = null, durationSec = 0, voiceSig = null, voiceSample = null }) {
  const seed = seedOverride != null ? seedOverride : hashSeed(`${title}|${prompt}|${styles.join(',')}|${lyrics}|${bpmBias}|${densityBias}|${mood}|${vocals}|${durationSec}|${voiceSig == null ? '' : `vs${voiceSig}`}${voiceSample ? `|vm${voiceSample.f0},${voiceSample.bright},${voiceSample.breathy}` : ''}`);
  const rng = mulberry32(seed);
  const style = pickStyle(styles, rng);
  const spec = buildSpec(style, prompt, rng, { bpmBias, densityBias, mood, vocals, durationSec, voiceSig, voiceSample });
  // 'mine' mode needs the actual recording; if it's missing, unreadable or
  // undecodable (imported metadata, cleared storage), fall back to the
  // synthesized voice instead of failing the whole generation.
  if (spec.mineVoice) {
    try {
      const { getVoiceAudio } = await import('./voicerec.js');
      const blob = await getVoiceAudio();
      if (!blob) throw new Error('no recording');
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await ac.decodeAudioData(await blob.arrayBuffer()).finally(() => ac.close().catch(() => {}));
      const ch = buffer.getChannelData(0);
      spec.mineVoice.audio = ch instanceof Float32Array ? ch : Float32Array.from(ch);
      spec.mineVoice.f0 = spec.mineVoice.f0 || 160;
    } catch {
      spec.mineVoice = null;
    }
  }
  const midiNotes = []; // every rendered note lands here for the MIDI exporter
  spec.notes = midiNotes;
  const { buffer, seconds, hasVocals } = await renderSong(spec, rng);
  const blob = audioBufferToWav(buffer);
  return {
    blob,
    duration: seconds,
    seed,
    styleId: style.id,
    styleLabel: style.label,
    bpm: spec.bpm,
    mood: spec.mood || null,
    density: spec.density,
    hasVocals,
    midiNotes,
  };
}

// Deterministic cover palette from a seed
// ---------------------------------------------------------------------------
// notesToMidi — write a Standard MIDI File (format 1) from collected notes.
// Tracks: 0 drums (GM ch10), 1 bass, 2 lead, 3 chords/pads/choir, 4 vocals.
// Deterministic input → byte-identical .mid.
// ---------------------------------------------------------------------------
const MIDI_TRACKS = [
  { name: 'Drums', channel: 9, program: null },
  { name: 'Bass', channel: 1, program: 38 }, // Synth Bass 1
  { name: 'Lead', channel: 2, program: 81 }, // Lead 2 (sawtooth)
  { name: 'Chords', channel: 3, program: 89 }, // Pad 2 (warm)
  { name: 'Vocals', channel: 4, program: 85 }, // Lead 6 (voice)
];

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

export function notesToMidi(notes, bpm = 120) {
  const ticksPerQuarter = 480;
  const secToTicks = (s) => Math.max(0, Math.round((s * bpm * ticksPerQuarter) / 60));
  const chunks = [];
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n) => [(n >>> 8) & 255, n & 255];
  const str = (s) => [...s].map((c) => c.charCodeAt(0));

  const trackChunk = (events) => {
    let last = 0;
    const bytes = [];
    for (const [t, ...data] of events) {
      bytes.push(...vlq(Math.max(0, Math.round(t - last))), ...data);
      last = t;
    }
    bytes.push(...vlq(0), 0xff, 0x2f, 0x00); // End of Track
    return [...str('MTrk'), ...u32(bytes.length), ...bytes];
  };

  // Conductor track: tempo + 4/4 time signature.
  const mpq = Math.round(60000000 / (bpm || 120));
  const conductor = trackChunk([
    [0, 0xff, 0x51, 0x03, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255],
    [0, 0xff, 0x58, 0x04, 4, 2, 24, 8],
  ]);
  chunks.push(conductor);

  MIDI_TRACKS.forEach((cfg, tr) => {
    const mine = notes.filter((n) => n.tr === tr && n.m >= 0 && n.m <= 127);
    const evs = [];
    if (cfg.program != null) evs.push([0, 0xc0 | cfg.channel, cfg.program]);
    evs.push([0, 0xff, 0x03, cfg.name.length, ...str(cfg.name)]); // track name
    for (const n of mine) {
      const on = secToTicks(n.t);
      const off = Math.max(on + 1, secToTicks(n.t + (n.d || 0.1)));
      const vel = Math.max(1, Math.min(127, n.vel || 90));
      evs.push([on, 0x90 | cfg.channel, n.m, vel]);
      evs.push([off, 0x80 | cfg.channel, n.m, 0]);
    }
    evs.sort((a, b) => a[0] - b[0] || (b[1] & 0xf0) - (a[1] & 0xf0)); // note-offs first at equal ticks
    chunks.push(trackChunk(evs));
  });

  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(ticksPerQuarter)];
  return new Uint8Array([...header, ...chunks.flat()]);
}

export function coverFromSeed(seed) {
  const rng = mulberry32(seed);
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 40 + Math.floor(rng() * 120)) % 360;
  const s = 55 + Math.floor(rng() * 25);
  const l = 38 + Math.floor(rng() * 18);
  return { h1, h2, s, l };
}

export function suggestTitles(prompt, rngSeed) {
  const words = prompt.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const picks = [];
  const rng = mulberry32(rngSeed || 1);
  const w = words.length;
  if (w >= 2) {
    picks.push(cap(words[Math.floor(rng() * w)]) + ' ' + cap(words[Math.floor(rng() * w)]));
  }
  picks.push(cap(words[Math.floor(rng() * w)] || 'song') + ' Nights');
  return picks;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
