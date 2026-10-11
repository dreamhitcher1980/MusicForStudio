// ---------------------------------------------------------------------------
// Lyrics Studio — a fully offline "AI lyrics" generator.
//
// Word-bank + template engine: pick an emotion vocabulary, weave the user's
// theme and keywords into a chorus hook, and stamp out tagged sections
// ([Verse 1], [Chorus], …) that the Create textarea (and the engines) accept
// directly. No network, no model — rhymes are approximate, but every run is
// different and it always gives you a starting point to edit.
// ---------------------------------------------------------------------------

const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Per-emotion vocabulary: images and verbs that keep the lines coherent.
const EMOTIONS = {
  uplifting: {
    adj: ['golden', 'bright', 'wide-open', 'electric', 'fearless', 'morning'],
    noun: ['sunrise', 'horizon', 'skyline', 'wings', 'signal', 'fireworks'],
    verb: ['rise', 'run', 'chase', 'climb', 'shine', 'burn'],
    place: ['rooftops', 'coastline', 'city lights', 'open road', 'high ground'],
    feel: ['alive', 'unstoppable', 'weightless', 'awake', 'home'],
  },
  melancholic: {
    adj: ['faded', 'quiet', 'grey', 'empty', 'distant', 'autumn'],
    noun: ['rain', 'photograph', 'voicemail', 'window', 'harbor', 'leaves'],
    verb: ['drift', 'wait', 'remember', 'let go', 'wander', 'ache'],
    place: ['empty streets', 'old apartment', 'last train', 'riverbank', 'kitchen floor'],
    feel: ['hollow', 'far away', 'half-forgotten', 'tired', 'sorry'],
  },
  romantic: {
    adj: ['slow', 'certain', 'midnight', 'velvet', 'honest', 'summer'],
    noun: ['heartbeat', 'love letter', 'candlelight', 'silhouette', 'promises', 'embrace'],
    verb: ['hold', 'stay', 'fall', 'whisper', 'dance', 'choose'],
    place: ['your doorway', 'the dancefloor', 'backseat stars', 'our corner café', 'the pier'],
    feel: ['yours', 'breathless', 'certain', 'found', 'warm'],
  },
  dark: {
    adj: ['cold', 'shadowed', 'restless', 'iron', 'midnight', 'hollow'],
    noun: ['thunder', 'mirror', 'sirens', 'smoke', 'edge', 'warning'],
    verb: ['haunt', 'run', 'hide', 'burn', 'break', 'watch'],
    place: ['back alleys', 'the void', 'dead ends', 'the flood', 'nightfall'],
    feel: ['numb', 'cornered', 'awake at 3am', 'unforgiven', 'gone'],
  },
  party: {
    adj: ['loud', 'neon', 'endless', 'shaking', 'gold', 'wild'],
    noun: ['bassline', 'strobes', 'crowd', 'confetti', 'afterglow', 'speakers'],
    verb: ['move', 'jump', 'turn up', 'glow', 'lose it', 'ride'],
    place: ['the club', 'festival grounds', 'rooftop party', 'the floor', 'downtown'],
    feel: [' electric', 'limitless', 'tonight-forever', 'loud', 'up'],
  },
  chill: {
    adj: ['lazy', 'hazy', 'soft', 'slow-burning', 'sun-bleached', 'easy'],
    noun: ['coffee', 'vinyl hiss', 'hammock', 'sunset', 'tape deck', 'breeze'],
    verb: ['float', 'breathe', 'sway', 'cruise', 'unwind', 'drift'],
    place: ['the balcony', 'a quiet drive', 'the porch', 'slow afternoons', 'the shoreline'],
    feel: ['at ease', 'mellow', 'unbothered', 'light', 'okay'],
  },
};

// Genre seasoning: extra flavor lines so a rap take doesn't read like folk.
const GENRE_FLAVOR = {
  rap: ['Uh,', 'Yeah,', 'Look —', 'Check it:'],
  edm: ['(Oh-oh-oh)', '(Hold — drop)', '(Hands up)', '(We go)'],
  rock: ['Whoa-oh,', 'Hey!', 'Na-na-na —', '(Guitar)'],
  pop: ['Ooh,', 'Hey,', 'La-la-la,', 'Oh-oh —'],
  country: ['Honey,', 'Lord knows,', 'Out here,', 'Darlin\','],
  lofi: ['(tape hiss)', 'Slow down,', 'Mm,', '(rain outside)'],
  metal: ['(Riff)', 'Scream it —', '(Breakdown)', 'Fire —'],
};

const STRUCTURES = {
  'verse-chorus': ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Outro'],
  'verse-chorus-bridge': ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus'],
  'verse-only': ['Verse 1', 'Verse 2', 'Verse 3'],
  aaba: ['Verse 1', 'Verse 2', 'Bridge', 'Verse 3'],
};

// Line templates. {adj}/{noun}/{verb}/{place}/{feel} pull from the emotion;
// {theme} and {kw} are the user's own words so the song stays about *their* idea.
const VERSE_TEMPLATES = [
  'I {verb} through the {adj} {noun}, counting every light',
  'There\'s a {adj} {noun} where the {place} used to be',
  'We were {feel}, writing promises in {place}',
  'Every {noun} knows the way I {verb} for you',
  '{kw} on my mind, {adj} as the {noun}',
  'Take me back to {place}, where the {noun} runs {adj}',
  'I keep a {adj} {noun} in the pocket of my coat',
  'If the {noun} calls, I\'ll {verb} a little more',
  'Nothing in the {place} ever felt so {feel}',
  'The {noun} keeps a record of the things we never say',
];

const CHORUS_TEMPLATES = [
  '{THEME} — that\'s the {noun} in my chest, {feel}',
  'So {verb} with me tonight, {THEME} in the {adj} dark',
  'We are {THEME}, {adj} and {feel}, we are {THEME}',
  'Say my name like {THEME}, let the {place} hear it too',
  '{THEME}, oh — I\'d {verb} a thousand {noun}s for you',
  'Hold the {noun}, start the fire — {THEME} tonight',
];

const BRIDGE_TEMPLATES = [
  '(quiet now) — just the {noun} and me, {feel}',
  'Maybe {THEME} was the {adj} {noun} all along',
  'And if the {noun} asks about us, tell it {kw}',
  'One more night, one more {adj} {noun}, then I\'m gone',
];

const OUTRO_TEMPLATES = [
  '{THEME}… {THEME}… (fade)',
  'La-la-la… {THEME}',
  'Still {feel}, still {THEME}',
];

const fill = (tpl, vocab, theme, kw) =>
  tpl
    .replace(/\{THEME\}/g, theme || kw || rnd(vocab.noun))
    .replace(/\{kw\}/g, kw || theme || rnd(vocab.noun))
    .replace(/\{adj\}/g, () => rnd(vocab.adj))
    .replace(/\{noun\}/g, () => rnd(vocab.noun))
    .replace(/\{verb\}/g, () => rnd(vocab.verb))
    .replace(/\{place\}/g, () => rnd(vocab.place))
    .replace(/\{feel\}/g, () => rnd(vocab.feel));

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function linesFor(templates, vocab, theme, kw, n, flavor) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let line = fill(rnd(templates), vocab, theme, kw);
    if (flavor && i === 0 && Math.random() < 0.6) line = `${rnd(flavor)} ${line}`;
    out.push(cap(line));
  }
  return out.join('\n');
}

export const LYRIC_EMOTIONS = Object.keys(EMOTIONS);

export function randomTheme() {
  const themes = [
    'chasing the city lights', 'last summer on the coast', 'letters I never sent',
    'dancing through the storm', 'a heart on the run', 'coming home in the rain',
    'neon hearts at midnight', 'the night we burned the map', 'gravity of you',
    'starting over at sunrise', 'static on the radio', 'kingdom of the lonely',
    'paper airplanes at 3am', 'wildflowers on the interstate',
  ];
  return rnd(themes);
}

// Build a full tagged lyric sheet. `emotion` may be 'auto' (derived from the
// genre), `genre` may be '' — both degrade gracefully.
export function generateLyrics({ theme = '', keywords = '', emotion = 'auto', genre = '', structure = 'verse-chorus' } = {}) {
  const g = (genre || '').toLowerCase();
  const byGenre =
    (/rap|hip|trap/.test(g) && 'party') ||
    (/metal|punk|hard/.test(g) && 'dark') ||
    (/edm|dance|house|techno/.test(g) && 'party') ||
    (/lofi|chill|ambient|jazz/.test(g) && 'chill') ||
    (/country|folk/.test(g) && 'melancholic') ||
    (/ballad|soul|r&b/.test(g) && 'romantic') ||
    null;
  const emoKey =
    emotion !== 'auto' && EMOTIONS[emotion] ? emotion : byGenre || rnd(Object.keys(EMOTIONS));
  const vocab = EMOTIONS[emoKey];
  const flavorKey = Object.keys(GENRE_FLAVOR).find((k) => g.includes(k.split(' ')[0]));
  const flavor = flavorKey ? GENRE_FLAVOR[flavorKey] : null;

  theme = (theme || '').trim().toLowerCase();
  const kw = (keywords || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean)[0] || '';

  const sections = STRUCTURES[structure] || STRUCTURES['verse-chorus'];
  const out = [];
  let verseN = 0;
  for (const name of sections) {
    out.push(`[${name}]`);
    if (name === 'Verse 1') verseN = 1;
    if (name.startsWith('Verse') && name !== 'Verse 1') verseN = Number(name.split(' ')[1]) || verseN + 1;
    if (name === 'Chorus') out.push(linesFor(CHORUS_TEMPLATES, vocab, theme, kw, 2, flavor));
    else if (name === 'Bridge') out.push(linesFor(BRIDGE_TEMPLATES, vocab, theme, kw, 2, null));
    else if (name === 'Outro') out.push(linesFor(OUTRO_TEMPLATES, vocab, theme, kw, 1, null));
    else out.push(linesFor(VERSE_TEMPLATES, vocab, theme, kw, 4, verseN === 1 ? flavor : null));
    out.push('');
  }
  return out.join('\n').trim();
}
