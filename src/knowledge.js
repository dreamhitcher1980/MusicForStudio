// knowledge.js — a distilled music knowledge base for the on-device engine.
//
// This is the "learned from real music research" layer, put together from
// three open sources so no user has to start from scratch:
//
//   1. FMA (github.com/mdeff/fma) — 106,574 tracks arranged in a 161-genre
//      taxonomy. GENRE_ALIASES below maps the vocabulary people actually use
//      (FMA's genre names among them) onto this app's curated styles.
//   2. ACE-Step 1.5 (github.com/ace-step/ACE-Step-1.5) — its LM "query
//      rewriting" turns a short user phrase into a structured song blueprint.
//      expandPrompt() does a fast, rule-based version of that.
//   3. MusicGen prompting practice (huggingface.co/blog/theeseus-ai/
//      musicgen-lora-large) — "preprocess prompts: structured and descriptive,
//      with genres, tempos, instruments". STYLE_TRAITS carries that vocabulary
//      per style, and expandPrompt() emits exactly that shape.
//
// Nothing here calls the network — it's static musical knowledge that makes
// both the on-device engine and the remote engines understand you better.

// ---------------------------------------------------------------------------
// Genre vocabulary → app styles. Keys cover FMA's taxonomy names, common
// colloquialisms, and scene slang. Matched as lowercase substring/word hits.
// ---------------------------------------------------------------------------
export const GENRE_ALIASES = {
  // Electronic & Dance
  'electronic': 'dance', 'edm': 'dance', 'dance': 'dance', 'house': 'house',
  'deep house': 'deephouse', 'tech house': 'house', 'progressive house': 'house',
  'techno': 'techno', 'industrial': 'techno', 'idm': 'techno',
  'electro': 'dance', 'electro house': 'festivalanthem',
  'trance': 'trance', 'psytrance': 'trance', 'vaporwave': 'futuresynth',
  'synthwave': 'synthwave', 'retrowave': 'synthwave', 'outrun': 'synthwave',
  'darksynth': 'synthwave', 'synth pop': 'synthpop', 'synthpop': 'synthpop',
  'dubstep': 'dubstep', 'brostep': 'dubstep',
  'drum & bass': 'dance', 'drum and bass': 'dance', 'dnb': 'dance', 'jungle': 'dance',
  'breakbeat': 'dance', 'big beat': 'dance',
  'chillwave': 'chillhop', 'chillout': 'chillhop', 'downtempo': 'chillhop',
  'ambient house': 'deephouse',
  // Hip-Hop, R&B, Reggae
  'hip hop': 'hiphop', 'hip-hop': 'hiphop', 'rap': 'hiphop', 'hiphouse': 'hiphop',
  'boom bap': 'boombap', 'old school hip hop': 'boombap', 'east coast': 'boombap',
  'trap': 'trap', 'drill': 'trap', 'phonk': 'phonk', 'memphis': 'phonk',
  'r&b': 'smoothrnb', 'rnb': 'smoothrnb', 'rhythm and blues': 'smoothrnb',
  'contemporary r&b': 'smoothrnb', 'soul': 'soul', 'neo soul': 'neosoul', 'motown': 'soul',
  'reggae': 'dancehall', 'dancehall': 'dancehall', 'dub': 'dancehall', 'ska': 'dancehall',
  'reggaeton': 'reggaeton', 'latin trap': 'reggaeton', 'moombahton': 'reggaeton',
  // Pop & rock
  'pop': 'pop', 'k-pop': 'kpop', 'kpop': 'kpop', 'j-pop': 'kpop', 'city pop': 'kpop',
  'indie pop': 'pop', 'electropop': 'synthpop', 'hyperpop': 'kpop',
  'rock': 'rock', 'classic rock': 'classicrock', 'soft rock': 'classicrock',
  'punk': 'poppunk', 'pop punk': 'poppunk', 'emo': 'poppunk',
  'indie rock': 'indierock', 'indie': 'indierock', 'shoegaze': 'indierock',
  'grunge': 'indierock', 'garage rock': 'indierock',
  'metal': 'heavymetal', 'heavy metal': 'heavymetal', 'thrash': 'heavymetal',
  'doom': 'heavymetal', 'stoner rock': 'heavymetal', 'hardcore': 'heavymetal',
  'blues rock': 'blues',
  // Jazz, folk, cinematic, world
  'jazz': 'jazz', 'swing': 'jazz', 'big band': 'jazz', 'bebop': 'jazz', 'fusion': 'jazz',
  'blues': 'blues', 'delta blues': 'blues', 'chicago blues': 'blues',
  'folk': 'acousticfolk', 'acoustic': 'acousticfolk', 'singer-songwriter': 'acousticfolk',
  'americana': 'acousticfolk', 'bluegrass': 'acousticfolk', 'singer songwriter': 'acousticfolk',
  'country': 'country', 'bluegrass country': 'country', 'outlaw country': 'country',
  'classical': 'classical', 'orchestral': 'classical', 'baroque': 'classical',
  'opera': 'classical', 'chamber music': 'classical',
  'ambient': 'ambient', 'drone': 'ambient', 'new age': 'ambient', 'soundscape': 'ambient',
  'cinematic': 'cinematicambient', 'soundtrack': 'cinematicambient', 'film score': 'cinematicambient',
  'trailer': 'epicorchestral', 'epic': 'epicorchestral',
  'gospel': 'gospel', 'christian': 'gospel', 'worship': 'gospel',
  'ballad': 'ballad', 'singer ballad': 'ballad',
  'funk': 'funk', 'disco': 'disco', 'nu disco': 'disco',
  'world': 'afrobeat', 'afrobeat': 'afrobeat', 'afrobeats': 'afrobeat', 'highlife': 'afrobeat',
  'amapiano': 'afrobeat', 'latin': 'latin', 'salsa': 'latin', 'cumbia': 'latin',
  'bossa nova': 'latin', 'tango': 'latin', 'samba': 'latin', 'flamenco': 'latin',
  'lo-fi': 'chillhop', 'lofi': 'chillhop', 'lo fi': 'chillhop', 'study beats': 'chillhop',
  'jazzhop': 'chillhop', 'chillhop': 'chillhop',
};

// ---------------------------------------------------------------------------
// Production traits per app style id — the instrument/production vocabulary
// that makes structured prompts specific (the #1 quality lever per the
// MusicGen prompting guide). Used by expandPrompt() for remote engines.
// ---------------------------------------------------------------------------
export const STYLE_TRAITS = {
  dance: 'four-on-the-floor kick, sidechained saw synths, club sound system, festival energy',
  house: 'warm piano house chords, filtered disco loops, groovy bassline, classic 909 drums',
  deephouse: 'warm chord stabs, deep sub-bass, jazzy rhodes, smooth late-night groove',
  techno: 'hypnotic looping modular synth, industrial percussion, dark warehouse atmosphere',
  trance: 'soaring supersaw lead, rolling bassline, euphoric breakdown, uplifting arpeggios',
  dubstep: 'growling wobble bass, half-time drums, snappy snares, aggressive sound design',
  festivalanthem: 'massive drop, big room saw chords, crowd energy, punchy kick',
  synthwave: 'gated 80s drums, analog arpeggios, neon retro lead, driving bassline',
  futuresynth: 'crisp future synth layers, plucks, wide stereo pads, modern mix',
  synthpop: 'bright pop synth hooks, glossy production, danceable beat, catchy chorus',
  chillhop: 'dusty vinyl crackle, mellow jazz guitar, lazy swung drums, cozy warmth',
  hiphop: 'boom-bap drums, sampled melody chops, deep bass, confident flow space',
  boombap: 'gritty vinyl drums, jazz samples, upright bass, golden-era NYC sound',
  trap: 'rolling hi-hat rolls, booming 808 glides, dark cinematic bells, tight ad-libs',
  southerntrap: 'slow heavy 808s, atmospheric pads, melodic hook, southern bounce',
  phonk: 'distorted cowbells, chopped soul vocals, crunchy tape drums, drift energy',
  pop: 'radio-polished production, bright synth layers, huge chorus, tight low end',
  upbeatpop: 'bright plucks, punchy drums, catchy topline, sunny commercial energy',
  kpop: 'maximalist production, genre-switching sections, explosive hooks, polished vocals',
  rock: 'overdriven guitars, live drums, driving bassline, raw band energy',
  classicrock: 'electric guitar riffs, vintage amp warmth, anthemic chorus, 70s production',
  poppunk: 'fast palm-muted power chords, punchy drums, energetic emotional vocals',
  heavymetal: 'down-tuned riffing, double-kick drums, aggressive vocals, dark power',
  indierock: 'jangly guitars, melodic bass, lo-fi warmth, melancholic atmosphere',
  jazz: 'upright walking bass, brushed drums, smoky saxophone, swing feel, lounge intimacy',
  blues: 'twelve-bar shuffle, expressive guitar bends, hammond organ, soulful grit',
  soul: 'warm rhythm section, horn stabs, gospel-rooted vocals, vintage console sound',
  neosoul: 'lush rhodes chords, silky bass, laid-back groove, smooth vocal harmonies',
  smoothrnb: 'silky electric piano, slow groove, sensual atmosphere, smooth vocal layers',
  gospel: 'powerful choir, hammond organ, handclaps, uplifting church energy',
  reggaeton: 'dembow rhythm, punchy sub bass, latin percussion, steamy club energy',
  dancehall: 'offbeat skank guitar, deep dub bass, tropical percussion, laid-back groove',
  afrobeat: 'polyrhythmic percussion, sunny horns, syncopated groove, log drums',
  latin: 'latin percussion, montuno piano, brassy hits, warm danceable rhythm',
  funk: 'slap bass, tight horn section, wah guitar, greasy groove',
  disco: 'four-on-the-floor beat, string section sweeps, octave bass, glittering hi-hats',
  country: 'twangy telecaster, acoustic strum, steel guitar, storytelling warmth',
  acousticfolk: 'strummed acoustic guitar, warm cello, intimate close vocals, natural room',
  ballad: 'gentle piano, swelling strings, emotional build, intimate vocal space',
  classical: 'orchestral strings, expressive piano, chamber arrangement, concert hall depth',
  ambient: 'evolving pads, deep drones, spacious reverb, weightless atmosphere',
  cinematicambient: 'slow orchestral swells, deep drone, cinematic space, emotional tension',
  epicorchestral: 'brass staccatos, sweeping strings, epic percussion, heroic build',
};

// ---------------------------------------------------------------------------
// expandPrompt — build a structured, descriptive prompt for a remote engine
// (works for MusicGen and ACE-Step alike). Order matters: genre framing, the
// user's own words, then tempo/instrument/production specifics.
// ---------------------------------------------------------------------------
export function expandPrompt({ prompt = '', style = null, bpm = null, mood = null, vocals = null } = {}) {
  const parts = [];
  if (style && style.label) parts.push(`${style.label.toLowerCase()} style`);
  const userText = (prompt || '').trim();
  if (userText) parts.push(userText);
  const traits = style && STYLE_TRAITS[style.id];
  if (traits) parts.push(traits);
  if (bpm) parts.push(`${Math.round(bpm)} BPM`);
  if (mood) parts.push(`${mood} mood`);
  if (vocals === false || vocals === 'off') parts.push('instrumental, no vocals');
  else if (vocals === 'female') parts.push('female vocals');
  else if (vocals === 'male') parts.push('male vocals');
  else if (style && (style.vocal || style.choir) && vocals !== false) parts.push('with vocals');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// styleForText — map free text (a prompt that names a genre we don't have a
// chip for, e.g. "drum & bass" or "bossa nova") onto the closest curated
// style. Longest-alias match wins; falls back to null when nothing matches.
// ---------------------------------------------------------------------------
export function styleForText(text, STYLES) {
  const t = ` ${(text || '').toLowerCase()} `;
  let best = null;
  let bestLen = 0;
  for (const [alias, styleId] of Object.entries(GENRE_ALIASES)) {
    const needle = ` ${alias} `;
    if (t.includes(needle) && alias.length > bestLen && STYLES.some((s) => s.id === styleId)) {
      best = styleId;
      bestLen = alias.length;
    }
  }
  return best;
}
