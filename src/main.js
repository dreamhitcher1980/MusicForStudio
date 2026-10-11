import { initDB, idbPut, idbGet, idbGetAll, idbDelete, uid, migrateMembers } from './db.js';  import { initFamily, activeMember as familyActiveMember, getMembers as familyMembers, isUnlocked as familyIsUnlocked, memberVoiceSig as familyVoiceSig, memberVoiceType as familyVoiceType, setMemberVoice as familySetVoice, memberById as familyMemberById } from './family.js';
import { memberVoiceLabel as familyVoiceLabel } from './family.js';
import { renderAccountSection, accountSummaryHtml } from './account.js';
import { Player } from './player.js';
import { generateTrack, coverFromSeed, suggestTitles, STYLES, hashSeed, MOOD_WORDS, audioBufferToWav, notesToMidi } from './gen.js';
import { recordVoiceSample, analyzeVoiceSample, describeVoiceProfile, getVoiceSample, clearVoiceSample, storeVoiceAudio } from './voicerec.js';
import { memberHasRecordedVoice } from './family.js';
import { aiInit, aiRecord, aiRecommend, aiReset, aiSampleCount, aiProfile, aiForYou, aiSoundProfile, aiContextStyle, currentContext } from './ai.js';
import { checkServer, generateRemote, generateAceStep, wavDuration, expandPrompt, DEFAULT_URL, DEFAULT_ACESTEP_URL } from './server.js';
import { styleForText } from './knowledge.js';
import { generateLyrics, randomTheme } from './lyrics.js';
import { generateSfxWav, SFX_TYPES } from './sfx.js';
import QRCode from 'qrcode';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'musicforstudio.settings.v1';

const state = {
  songs: [],
  view: 'home',
  currentSongId: null,
  currentObjectUrl: null,
  order: [], // playback order for next/prev within current view
  shuffle: false,
  repeat: 'off', // 'off' | 'all' | 'one'
  volume: 0.8,
  muted: false,
  search: '',
  libraryFilter: 'all', // Library filter: 'all' | 'liked' | a scene category name
  exploreGenre: 'dance',
  exploreCat: 'all', // Explore category filter ('all' or a curated category name)
  exploreGenreByCat: {}, // last-explored scene per category (restores Explore tabs)
  exploreCache: [], // discovery cards (not saved)
  remixes: [], // remix result cards (not saved)
  incoming: [], // song received via a share link
  creating: false,
  aiEnabled: true,
  aiPlayId: null,
  aiPlayStart: 0,
  remoteEnabled: false,
  remoteEngine: 'musicgen', // 'musicgen' | 'acestep' — which local server to use
  remoteUrl: DEFAULT_URL,
  checkingServer: false,
  createLength: 180, // requested song length, seconds (Clip / Full / Long)
  remixLength: 180,
  createStyleCat: 'all', // style-chip category filter on the Create form
  remixStyleCat: 'all', // style-chip category filter on the Remix form
  theme: 'dark', // 'dark' | 'light' appearance
  playlists: [], // custom playlists: { id, name, songIds, createdAt }
  playlistViewId: null, // playlist being browsed inside Library, or null
  autoExport: false, // write every new song to the chosen Workspace folder
  metaOnlyBackup: false, // backup skips embedded audio → tiny archive that re-renders from seeds
  customPresets: [], // user-saved editor presets: { name, startFrac, endFrac, fadeInSec, fadeOutSec }
  editMemory: {}, // per-song editor state: { songId: { start, end, fadeIn, fadeOut, zoom } } (slider fractions)
  // Auto-backup reminder: nudge after every `every` new songs since the last
  // backup. `count` counts new songs; `remindedAt` is the count at which the
  // banner was last dismissed (so it stays away until the next multiple).
  backupReminder: { every: 10, count: 0, remindedAt: 0 },
  styleRef: '', // song id whose audio guides ACE-Step style transfer ('' = none)
  styleRefStrength: 0.5, // 0.2 subtle · 0.5 balanced · 0.8 strong
};

// Learn-tab demo tracks: rendered on demand, kept in memory only (never saved).
const learnDemos = [];

const els = {};
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    state.volume = typeof s.volume === 'number' ? s.volume : 0.8;
    state.shuffle = !!s.shuffle;
    state.repeat = ['all', 'one'].includes(s.repeat) ? s.repeat : 'off';
    state.libraryFilter = s.libraryFilter || 'all';
    state.createStyleCat = s.createStyleCat || 'all';
    state.remixStyleCat = s.remixStyleCat || 'all';
    state.exploreGenre = s.exploreGenre || 'dance';
    state.exploreCat = s.exploreCat || 'all';
    state.exploreGenreByCat = s.exploreGenreByCat && typeof s.exploreGenreByCat === 'object' && !Array.isArray(s.exploreGenreByCat) ? s.exploreGenreByCat : {};
    state.aiEnabled = typeof s.aiEnabled === 'boolean' ? s.aiEnabled : true;
    state.remoteEnabled = !!s.remoteEnabled;
    state.remoteEngine = s.remoteEngine === 'acestep' ? 'acestep' : 'musicgen';
    state.remoteUrl = typeof s.remoteUrl === 'string' && s.remoteUrl ? s.remoteUrl : (state.remoteEngine === 'acestep' ? DEFAULT_ACESTEP_URL : DEFAULT_URL);
    state.theme = s.theme === 'light' ? 'light' : 'dark';
    state.autoExport = !!s.autoExport;
    state.metaOnlyBackup = !!s.metaOnlyBackup;
    state.customPresets = Array.isArray(s.customPresets) ? s.customPresets : [];
    state.editMemory = s.editMemory && typeof s.editMemory === 'object' ? s.editMemory : {};
    state.backupReminder = s.backupReminder && typeof s.backupReminder === 'object'
      ? { every: Math.max(0, Number(s.backupReminder.every) || 0), count: Math.max(0, Number(s.backupReminder.count) || 0), remindedAt: Math.max(0, Number(s.backupReminder.remindedAt) || 0) }
      : { every: 10, count: 0, remindedAt: 0 };
    state.styleRef = typeof s.styleRef === 'string' ? s.styleRef : '';
    state.createVoice = ['female', 'male', 'off'].includes(s.createVoice) ? s.createVoice : '';
    state.excludeStyles = typeof s.excludeStyles === 'string' ? s.excludeStyles : '';
    if (typeof s.createLength === 'number' && s.createLength) state.createLength = s.createLength;
    state.styleRefStrength = [0.2, 0.5, 0.8].includes(s.styleRefStrength) ? s.styleRefStrength : 0.5;
  } catch {
    /* ignore */
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme === 'light' ? 'light' : 'dark';
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ volume: state.volume, shuffle: state.shuffle, repeat: state.repeat, libraryFilter: state.libraryFilter, createStyleCat: state.createStyleCat, remixStyleCat: state.remixStyleCat, exploreGenre: state.exploreGenre, exploreCat: state.exploreCat, exploreGenreByCat: state.exploreGenreByCat, aiEnabled: state.aiEnabled, remoteEnabled: state.remoteEnabled, remoteEngine: state.remoteEngine, remoteUrl: state.remoteUrl, theme: state.theme, autoExport: state.autoExport, metaOnlyBackup: state.metaOnlyBackup, customPresets: state.customPresets || [], editMemory: state.editMemory || {}, backupReminder: state.backupReminder || { every: 10, count: 0, remindedAt: 0 }, styleRef: state.styleRef || '', styleRefStrength: state.styleRefStrength || 0.5, createVoice: state.createVoice || '', excludeStyles: state.excludeStyles || '', createLength: state.createLength || 30 })
    );
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Audio-fingerprint extraction (the genreAI technique): four normalized
// features from the rendered audio itself — energy, dynamics, brightness
// (zero-crossing rate) and rhythmic density — so the taste engine can learn
// from how music SOUNDS, not just from its style label. Computed once per
// song at first play and cached on the record.
let featureCtx = null;
async function extractAudioFeatures(blob) {
  try {
    if (!featureCtx) featureCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await featureCtx.decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0);
    const win = Math.floor(buf.sampleRate * 0.046);
    const frames = Math.min(4000, Math.floor(data.length / win));
    if (frames < 4) return null;
    const rmsSeq = [];
    let zc = 0;
    let zcTot = 0;
    for (let f = 0; f < frames; f++) {
      const start = f * win;
      let sum = 0;
      for (let i = 2; i < win; i += 2) {
        const v = data[start + i];
        sum += v * v;
        if ((v >= 0) !== (data[start + i - 2] >= 0)) zc++;
        zcTot++;
      }
      rmsSeq.push(Math.sqrt(sum / (win / 2)));
    }
    const mean = rmsSeq.reduce((a, b) => a + b, 0) / rmsSeq.length || 1e-6;
    const sorted = [...rmsSeq].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    let onsets = 0;
    for (let f = 1; f < rmsSeq.length; f++) if (rmsSeq[f] > rmsSeq[f - 1] * 1.4 && rmsSeq[f] > mean) onsets++;
    return {
      e: Math.min(1, Math.log10(1 + mean * 12) / 1.2),
      d: Math.min(1, (p95 - p10) / (mean * 3)),
      b: Math.min(1, (zc / Math.max(1, zcTot)) * 6),
      r: Math.min(1, (onsets / frames) * 30),
    };
  } catch {
    return null;
  }
}

function styleById(id) {
  return STYLES.find((s) => s.id === id) || STYLES[0];
}

function coverStyle(seed, letter) {
  const { h1, h2, s, l } = coverFromSeed(seed);
  return {
    background: `radial-gradient(circle at 28% 22%, hsl(${h1} ${s}% ${l + 18}%), transparent 45%), conic-gradient(from ${seed % 360}deg at 62% 66%, hsl(${h1} ${s}% ${l}%), hsl(${h2} ${s}% ${l - 12}%), hsl(${h1} ${s}% ${l}%))`,
  };
}

function coverLetter(title) {
  return (title || '✦').trim().charAt(0).toUpperCase();
}

// `mode` optional: 'error' makes the toast visually distinct and keeps it on
// screen longer so a failed remote generation is actually noticed.
function toast(msg, mode = '') {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  els.toast.classList.toggle('error', mode === 'error');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), mode === 'error' ? 6000 : 2400);
}

// Turn a failure from the local MusicGen bridge (connection / timeout / server
// error / empty audio) into a short, human, actionable message that also names
// the URL that was touched, so the user knows what to fix.
function remoteProblem(err, url) {
  const m = (err && err.message) || String(err);
  const host = (url || DEFAULT_URL).replace(/\/+$/, '');
  const start = 'python server/musicgen_server.py';
  if (/timed?.?out|timedout|abort/i.test(m)) {
    return `The MusicGen server at ${host} is responding too slowly (${m}). It may still be loading its model or be very busy — start it with “${start}” and try again.`;
  }
  if (/empty/i.test(m)) {
    return `The MusicGen server at ${host} replied but sent no audio (${m}). It may still be loading its model — wait a moment, then hit Test connection in Settings.`;
  }
  if (/replied (\d{3})/i.test(m)) {
    return `The MusicGen server at ${host} returned an error (${m}). Restart it with “${start}”, then Test connection in Settings.`;
  }
  if (/failed to fetch|could not|connect|network|fetch/i.test(m)) {
    return `Couldn't reach the MusicGen server at ${host} (${m}). Make sure it's running — start it with “${start}”.`;
  }
  return `The MusicGen server at ${host} failed (${m}). Check the URL and hit Test connection in Settings.`;
}

function findSong(id) {
  return (
    state.songs.find((s) => s.id === id) ||
    state.exploreCache.find((s) => s.id === id) ||
    state.remixes.find((s) => s.id === id) ||
    state.incoming.find((s) => s.id === id) ||
    learnDemos.find((s) => s.id === id) ||
    null
  );
}

function currentSong() {
  return findSong(state.currentSongId);
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

// The “style · length” line under a card title, shared by cardHtml and
// renderCards so live updates never wipe the edited-length arrow.
function cardSubLabel(song) {
  // Honor a song's own style label (imports, sound effects) over the catalog.
  const style = song.styleLabel ? { label: song.styleLabel } : styleById(song.styleId);
  const len = song.edited && song.originalDuration && song.originalDuration > song.duration
    ? `${fmtTime(song.originalDuration)} → ${fmtTime(song.duration)}`
    : fmtTime(song.duration);
  return `${escapeHtml(style.label)} · ${len}`;
}

function cardHtml(song, { showDelete = false, discovery = false, showRemove = false, showEdit = false, take = null, showKeep = false, showAb = false } = {}) {
  const playing = song.id === state.currentSongId && !player.paused;
  const cover = coverStyle(song.seed, coverLetter(song.title));
  const plays = song.plays || 0;
  return `
    <div class="song-card${playing ? ' playing' : ''}${song.keptTake ? ' keeper' : ''}" data-id="${song.id}" data-discovery="${discovery}">
      <div class="cover" style="background:${cover.background}">
        <span class="cover-letter">${escapeHtml(coverLetter(song.title))}</span>
        ${playing ? '<i class="eq-big"><b></b><b></b><b></b><b></b></i>' : ''}
        ${take ? `<span class="take-badge" title="This song's place in its variation family">Take ${take.index} of ${take.total}</span>` : ''}
        ${song.keptTake ? '<span class="keeper-badge" title="Your favourite take of this family">★ Keeper</span>' : ''}
        <button class="cover-play" draggable="false" title="Play">▶</button>
        <button class="cover-save" draggable="false" title="Save to library">＋</button>
        <button class="cover-download" draggable="false" title="Download WAV">⤓</button>
        ${showDelete ? '<button class="cover-del" draggable="false" title="Delete">🗑</button>' : ''}
        ${showRemove ? '<button class="cover-remove" draggable="false" title="Remove from playlist">−</button>' : ''}
        ${showEdit ? '<button class="cover-edit" draggable="false" title="Trim & fade">✂</button>' : ''}
        ${showKeep ? `<button class="cover-keep" draggable="false" title="Keep this take — mark it as the favourite of the family">${song.keptTake ? '★' : '☆'}</button>` : ''}
        ${showAb ? '<button class="cover-ab" draggable="false" title="A/B compare — hear the takes of this family back-to-back">⇄</button>' : ''}
        <button class="cover-vary" draggable="false" title="Duplicate as variation (A/B)">≋</button>
      </div>
      <div class="card-meta">
        <b class="card-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</b>
        <span class="card-sub">${cardSubLabel(song)}</span>
        <span class="card-foot"><i class="heart${song.liked ? ' liked' : ''}">${song.liked ? '♥' : '♡'}</i><span class="foot-right"><span class="plays">▶ ${plays}</span><button class="share" title="Copy share link">⧉</button></span></span>
      </div>
    </div>`;
}

function bindCard(card, song, { onDelete, onRemove, onEdit } = {}) {
  // Drag a card onto the Up Next queue dialog to append it to the queue.
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    try { e.dataTransfer.setData('text/plain', `song:${song.id}`); } catch {}
    e.dataTransfer.effectAllowed = 'copy';
  });
  const play = () => {
    state.order = visibleOrder();
    playSong(song.id);
  };
  card.addEventListener('click', (e) => {
    if (e.target.closest('.cover-play')) {
      play();
      return;
    }
    if (e.target.closest('.cover-save')) {
      // Saved songs: ＋ now means "add to a playlist". Discovery tracks still
      // get saved to the library.
      if (state.songs.some((s) => s.id === song.id)) {
        openPlaylistPicker(song);
        return;
      }
      saveDiscovery(song);
      return;
    }
    if (e.target.closest('.cover-del')) {
      e.stopPropagation();
      deleteSong(song.id);
      return;
    }
    if (e.target.closest('.cover-remove')) {
      e.stopPropagation();
      if (onRemove) onRemove(song);
      return;
    }
    if (e.target.closest('.cover-edit')) {
      e.stopPropagation();
      if (onEdit) onEdit(song);
      return;
    }
    if (e.target.closest('.cover-vary')) {
      e.stopPropagation();
      duplicateAsVariation(song);
      return;
    }
    if (e.target.closest('.cover-download')) {
      e.stopPropagation();
      openDownloadMenu(song, e);
      return;
    }
    if (e.target.closest('.heart')) {
      toggleLike(song);
      return;
    }
    if (e.target.closest('.share')) {
      e.stopPropagation();
      shareSong(song);
      return;
    }
    if (e.target.closest('.cover-keep')) {
      e.stopPropagation();
      keepTake(song);
      return;
    }
    if (e.target.closest('.cover-ab')) {
      e.stopPropagation();
      openAbCompare(song);
      return;
    }
    play();
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function visibleOrder() {
  if (state.view === 'library') {
    return libraryFilteredSongs().map((s) => s.id);
  }
  if (state.view === 'explore') {
    return state.exploreCache.filter((s) => s.styleId === state.exploreGenre).map((s) => s.id);
  }
  if (state.view === 'remix') {
    return state.remixes.map((s) => s.id);
  }
  return [...state.songs].sort((a, b) => b.createdAt - a.createdAt).map((s) => s.id);
}

function renderView() {
  els.searchInput.value = state.search;
  const el = els.content;
  if (state.view === 'home') renderHome(el);
  else if (state.view === 'create') renderCreate(el);
  else if (state.view === 'remix') renderRemix(el);
  else if (state.view === 'library') renderLibrary(el);
  else if (state.view === 'explore') renderExplore(el);
  else if (state.view === 'learn') renderLearn(el);
  else if (state.view === 'workspace') renderWorkspace(el);
  else if (state.view === 'profile') renderProfile(el);
  else if (state.view === 'settings') renderSettings(el);
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.view));
}

function renderHome(el) {
  const recent = [...state.songs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  const chips = ['dance', 'lofi', 'synthwave', 'jazz'].map((id) => STYLES.find((s) => s.id === id).label);
  el.innerHTML = `
    <section class="hero">
      <div>
        <p class="kicker">YOUR PERSONAL STUDIO</p>
        <h1>What will you make today?</h1>
        <p class="hero-sub">Describe a song, pick a style, and get an original track — composed and mixed right in your browser.</p>
        <div class="hero-actions">
          <button class="cta" id="heroCreate">✦ Create a song</button>
          <div class="chip-row">${chips.map((c) => `<button class="chip" data-style="${c}">${c}</button>`).join('')}</div>
        </div>
      </div>
      <div class="hero-orb"></div>
    </section>
    ${recent.length ? `
      <section class="section">
        <div class="section-head"><h2>Tuned for you</h2></div>
        <div class="card-grid" id="forYouGrid">${
          (aiForYou(state.songs) || [])
            .map((r) => `<div class="foryou-item">${cardHtml(r.song)}<p class="foryou-reason" title="Why this pick">✦ ${escapeHtml(r.reason)}</p></div>`)
            .join('') || '<p class="settings-note">Play and like a few songs — the feed builds itself from your history.</p>'
        }</div>
      </section>
      <section class="section">
        <div class="section-head"><h2>Your latest creations</h2><button class="ghost" id="seeAll">See all →</button></div>
        <div class="card-grid" id="recentGrid">${recent.map((s) => cardHtml(s)).join('')}</div>
      </section>` : `
      <section class="empty-state">
        <div class="empty-icon">✦</div>
        <h2>No songs yet</h2>
        <p>Head to Create, write a prompt like “upbeat dance anthem with big synths”, and make your first track.</p>
        <button class="cta" id="emptyCreate">✦ Open the studio</button>
      </section>`}
  `;

  const createBtn = $('heroCreate') || $('emptyCreate');
  if (createBtn) createBtn.addEventListener('click', () => setView('create'));
  const seeAll = $('seeAll');
  if (seeAll) seeAll.addEventListener('click', () => setView('library'));
  document.querySelectorAll('.chip-row .chip').forEach((c) => {
    c.addEventListener('click', () => {
      setView('create');
      fillPrompt(`a ${c.dataset.style.toLowerCase()} track that`);
    });
  });
  document.querySelectorAll('#recentGrid .song-card').forEach((card) => {
    const song = state.songs.find((s) => s.id === card.dataset.id);
    if (song) bindCard(card, song);
  });
  document.querySelectorAll('#forYouGrid .song-card').forEach((card) => {
    const song = state.songs.find((s) => s.id === card.dataset.id);
    if (song) bindCard(card, song);
  });
}

function fillPrompt(text) {
  els.createPrompt.value = text;
  els.createPrompt.focus();
}

const SUGGESTIONS = [
  'an upbeat dance anthem with huge synth drops',
  'a melancholic lofi beat for a rainy night',
  'an epic synthwave chase through neon streets',
  'a smooth jazz piece with a walking bassline',
  'a dreamy ambient soundscape that slowly fades in',
  'a hard rock track with distorted guitars',
  'a chill reggaeton groove for summer evenings',
];

const CREATE_STAGES = [
  'Reading your prompt…',
  'Composing the chord progression…',
  'Laying down the drums…',
  'Writing the melody…',
  'Recording the vocal line…',
  'Mixing and mastering…',
  'Finalizing your song…',
];

function renderCreate(el) {
  const selected = state.createStyles || [];
  const hasRecordedVoice = memberHasRecordedVoice();
  el.innerHTML = `
    <section class="studio">
      <div class="studio-head">
        <p class="kicker">CREATE</p>
        <h1>Make something new</h1>
        <p class="hero-sub">Everything is generated locally — your prompts and songs never leave this device.</p>
      </div>
      <div class="studio-panel">
        <label class="field">
          <span>Song title</span>
          <input id="createTitle" placeholder="e.g. Neon Midnight" maxlength="60" />
        </label>
        <label class="field">
          <span>Describe your song</span>
          <textarea id="createPrompt" rows="3" placeholder="e.g. an upbeat dance anthem with big synth drops and a driving bassline…"></textarea>
          <div class="suggest-row">
            ${SUGGESTIONS.map((s) => `<button class="suggest" data-s="${s}">${s}</button>`).join('')}
            <button class="suggest" id="imgToMusic" title="Pick an image — its colors shape the style, mood and energy">🎨 From image</button>
          </div>
        </label>
        <details class="studio-fold">
          <summary>🎭 Scene presets <small>curated prompt + style starters</small></summary>
          <div class="field">
            <span>Genre scenes <small>curated presets — fills the prompt & picks a style</small></span>
            <input id="sceneSearch" class="scene-search" type="search" placeholder="Filter ${STYLES.filter((s) => s.category).length} scenes… (e.g. “drill”, “pop”)" autocomplete="off" />
            <div id="sceneGrid">${sceneButtonsHtml()}</div>
          </div>
        </details>
        <div class="field">
          <span>Styles <small>up to 2</small></span>
          <div id="createChipsBlock">${styleChipsBlockHtml('create')}</div>
        </div>
        <div class="field">
          <span>Song setup <small>length, tempo, takes per create</small></span>
          <div class="settings-row">
            <label class="field-inline">Length <small>full songs render a few minutes</small>
              <select id="createLength">
                <option value="30">Clip (≈30 s)</option>
                <option value="180"${state.createLength === 180 ? ' selected' : ''}>Full (≈3 min)</option>
                <option value="240"${state.createLength === 240 ? ' selected' : ''}>Long (≈4 min)</option>
              </select>
            </label>
            <label class="field-inline">Variations <small>distinct takes at once</small>
              <select id="createVariations">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
            </label>
            <label class="ai-toggle"><input type="checkbox" id="createCustomBpm" /><span>Set tempo (BPM)</span></label>
          </div>
          <div class="bpm-row" id="createBpmRow" hidden>
            <input type="range" id="createBpm" min="60" max="200" value="120" step="2" />
            <b id="createBpmLbl">120 BPM</b>
          </div>
        </div>
        <details class="studio-fold">
          <summary>⚙ Engine, voice &amp; import <small>AI engine, vocals, style reference, audio import</small></summary>
          ${aiPanelHtml()}
          <div class="field">
            <span>Already have audio? <small>import a file and treat it as a song — it joins your library, editor and exports</small></span>
            <button class="ghost" id="uploadBtn" type="button">⤒ Import audio file (WAV / MP3 / OGG)</button>
          </div>
          <div class="field">            <span>Voice <small>how the song sings — the engine adapts vocal styles to it</small></span>
            <div class="settings-row">
              <select id="createVoice" class="url-input" style="flex:1">
                <option value="">Random — style default</option>
                <option value="mine"${state.createVoice === 'mine' ? ' selected' : ''}>🎤 My recorded voice${hasRecordedVoice ? '' : ' (not recorded yet)'}</option>
                <option value="female"${state.createVoice === 'female' ? ' selected' : ''}>Female vocal</option>
                <option value="male"${state.createVoice === 'male' ? ' selected' : ''}>Male vocal</option>
                <option value="off"${state.createVoice === 'off' ? ' selected' : ''}>Instrumental — no vocals</option>
              </select>
              <button id="recordVoiceBtn" class="ghost" type="button" title="Record your own voice and sing with it">🎙 Record voice</button>
              <input id="excludeStyles" class="url-input" style="flex:1" placeholder="Exclude genres (comma-separated)" maxlength="120" value="${escapeHtml(state.excludeStyles || '')}" />
            </div>
          </div>
          <div class="field">
            <span>Style reference <small>ACE-Step — mimic the sound of one of your songs</small></span>
            <div class="settings-row">
              <select id="styleRefSelect" class="url-input">
                <option value="">None — prompt only</option>
                ${[...state.songs].sort((a, b) => b.createdAt - a.createdAt).map((s) => `<option value="${s.id}"${state.styleRef === s.id ? ' selected' : ''}>${escapeHtml(s.title)}</option>`).join('')}
              </select>
              <select id="styleRefStrength" class="url-input" style="max-width:11em">
                <option value="0.2"${state.styleRefStrength === 0.2 ? ' selected' : ''}>Subtle borrow</option>
                <option value="0.5"${state.styleRefStrength === 0.5 ? ' selected' : ''}>Balanced</option>
                <option value="0.8"${state.styleRefStrength === 0.8 ? ' selected' : ''}>Strong</option>
              </select>
            </div>
            <p class="settings-note" id="styleRefHint"></p>
          </div>
        </details>
        <details class="studio-fold">
          <summary>💥 Sound effects <small>instant one-shots & loops — click to render, ⇆ on the card for takes</small></summary>
          <div class="field">
            <div class="suggest-row">
              ${SFX_TYPES.map((t) => `<button class="suggest" data-sfx="${t.id}" title="${t.hint}">${t.label}</button>`).join('')}
            </div>
          </div>
        </details>
        <details class="studio-fold">
          <summary>🎤 Lyrics Studio <small>offline generator — drafts a starting point you can edit</small></summary>
          <div class="field">
            <div class="settings-row">
              <input id="lyrTheme" class="url-input" style="flex:2;min-width:150px" placeholder="Theme — e.g. chasing city lights" maxlength="80" />
              <input id="lyrKeywords" class="url-input" style="flex:1;min-width:120px" placeholder="Keywords (comma-separated)" maxlength="120" />
            </div>
            <div class="settings-row">
              <select id="lyrEmotion" class="url-input" style="flex:1">
                <option value="auto">Emotion: auto</option>
                <option value="uplifting">Uplifting</option>
                <option value="melancholic">Melancholic</option>
                <option value="romantic">Romantic</option>
                <option value="dark">Dark</option>
                <option value="party">Party</option>
                <option value="chill">Chill</option>
              </select>
              <select id="lyrStructure" class="url-input" style="flex:1">
                <option value="verse-chorus">Verse + Chorus</option>
                <option value="verse-chorus-bridge">Verse / Chorus / Bridge</option>
                <option value="verse-only">Verses only</option>
                <option value="aaba">A–A–B–A</option>
              </select>
              <button class="ghost" id="lyrWrite" type="button">✍ Write lyrics</button>
              <button class="ghost" id="lyrRandom" type="button" title="Pick a random theme and write">🎲 Surprise me</button>
            </div>
          </div>
          <label class="field">
            <span>Lyrics <small>optional · <span id="lyrCount">0</span>/5000</small></span>
            <textarea id="createLyrics" rows="4" placeholder="[Verse 1]&#10;…" maxlength="5000"></textarea>
          </label>
        </details>
        <button class="cta big" id="createBtn">✦ Create song</button>
      </div>
      <div class="generating" id="generating" hidden>
        <div class="gen-bar"><i id="genFill"></i></div>
        <p id="genStage">Reading your prompt…</p>
      </div>
      <section class="section" id="createdSection" hidden>
        <div class="section-head"><h2>Just created</h2></div>
        <div class="card-grid" id="createdGrid"></div>
      </section>
    </section>
  `;

  els.createTitle = $('createTitle');
  els.createPrompt = $('createPrompt');
  els.createLyrics = $('createLyrics');
  els.createBtn = $('createBtn');
  els.generating = $('generating');
  els.genFill = $('genFill');
  els.genStage = $('genStage');
  els.createdSection = $('createdSection');
  els.createdGrid = $('createdGrid');
  els.styleChips = [];
  els.createLength = $('createLength');
  if (els.createLength) els.createLength.addEventListener('change', () => { state.createLength = Number(els.createLength.value) || 30; });
  els.createCustomBpm = $('createCustomBpm');
  els.createBpm = $('createBpm');
  els.createBpmLbl = $('createBpmLbl');
  els.createBpmRow = $('createBpmRow');
  els.createVariations = $('createVariations');
  els.createCustomBpm.addEventListener('change', () => { els.createBpmRow.hidden = !els.createCustomBpm.checked; });
  els.createBpm.addEventListener('input', () => { els.createBpmLbl.textContent = `${els.createBpm.value} BPM`; });

  // Lyrics Studio: offline generator drafts tagged lyric sheets into the field.
  const lyrCount = $('lyrCount');
  const refreshLyrCount = () => { if (lyrCount) lyrCount.textContent = String(els.createLyrics.value.length); };
  els.createLyrics.addEventListener('input', refreshLyrCount);
  refreshLyrCount();
  const writeLyrics = (surprise) => {
    if (surprise) $('lyrTheme').value = randomTheme();
    const genre = (state.createStyles || []).map((id) => styleById(id).label).join(', ');
    const text = generateLyrics({
      theme: $('lyrTheme').value,
      keywords: $('lyrKeywords').value,
      emotion: $('lyrEmotion').value,
      structure: $('lyrStructure').value,
      genre,
    });
    els.createLyrics.value = text;
    refreshLyrCount();
    toast(surprise ? 'Fresh theme, fresh lyrics — edit anything you like.' : 'Lyrics drafted — edit anything you like.');
  };
  $('lyrWrite').addEventListener('click', () => writeLyrics(false));
  $('lyrRandom').addEventListener('click', () => writeLyrics(true));
  const voiceSel = $('createVoice');
  if (voiceSel) voiceSel.addEventListener('change', () => { state.createVoice = voiceSel.value; familySetVoice(voiceSel.value); saveSettings(); });
  const recBtn = $('recordVoiceBtn');
  if (recBtn) recBtn.addEventListener('click', openVoiceRecorder);
  const exclInput = $('excludeStyles');
  if (exclInput) exclInput.addEventListener('change', () => { state.excludeStyles = exclInput.value; saveSettings(); });

  // Import audio: any WAV/MP3/OGG the user already has becomes a library song.
  $('uploadBtn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*';
    inp.onchange = () => importAudioFile(inp.files && inp.files[0]);
    inp.click();
  });

  // SFX Studio: one click renders a fresh take of the effect (new seed each).
  el.querySelectorAll('[data-sfx]').forEach((b) => {
    b.addEventListener('click', () => makeSfx(b.dataset.sfx, b));
  });

  // Image → Music: the picture's palette shapes style, mood and energy.
  $('imgToMusic').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => applyImageToMusic(inp.files && inp.files[0]);
    inp.click();
  });

  // Style reference (ACE-Step only): pick a library song; its audio is uploaded
  // with each generation as a style guide.
  const styleRefSel = $('styleRefSelect');
  const styleRefStrength = $('styleRefStrength');
  const styleRefHint = $('styleRefHint');
  const refreshStyleRefHint = () => {
    if (!styleRefHint) return;
    if (!styleRefSel.value) {
      styleRefHint.textContent = 'Optional — with the ACE-Step engine, new songs borrow the sound and production feel of the chosen song.';
    } else if (state.remoteEngine !== 'acestep' || !state.remoteEnabled) {
      styleRefHint.textContent = '⚠ Style references need the ACE-Step server (Settings → Local AI servers) — ignoring the reference otherwise.';
    } else {
      const ref = findSong(styleRefSel.value);
      styleRefHint.textContent = ref ? `Next songs borrow the sound of “${ref.title}” (strength ${Math.round(state.styleRefStrength * 100)}%).` : '';
    }
  };
  if (styleRefSel) {
    styleRefSel.value = state.styleRef || '';
    styleRefSel.addEventListener('change', () => {
      state.styleRef = styleRefSel.value;
      saveSettings();
      refreshStyleRefHint();
    });
    styleRefStrength.value = String(state.styleRefStrength);
    styleRefStrength.addEventListener('change', () => {
      state.styleRefStrength = Number(styleRefStrength.value) || 0.5;
      saveSettings();
      refreshStyleRefHint();
    });
    refreshStyleRefHint();
  }

  document.querySelectorAll('.suggest').forEach((b) => {
    b.addEventListener('click', () => {
      // Only suggestion buttons carry data-s — other .suggest buttons (SFX
      // chips, image import) handle their own clicks and must not overwrite
      // the prompt with “undefined”.
      if (!b.dataset.s) return;
      els.createPrompt.value = b.dataset.s;
      els.createPrompt.focus();
    });
  });
  bindStyleChips('create');
  document.querySelectorAll('#sceneGrid .scene-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const scene = STYLES.find((s) => s.id === b.dataset.style);
      if (!scene) return;
      els.createPrompt.value = scene.scene || scene.label;
      state.createStyles = [scene.id];
      // jump the chips' category filter to the scene's family so the pick shows
      if (scene.category) {
        state.createStyleCat = scene.category;
        saveSettings();
        const block = $('createChipsBlock');
        if (block) {
          block.innerHTML = styleChipsBlockHtml('create');
          bindStyleChips('create');
        }
      }
      renderChips();
      els.createPrompt.focus();
      toast(`“${scene.label}” loaded — prompt filled, style selected.`);
    });
  });

  // Live filter for the genre-scene picker. Buttons and their groups are hidden
  // in place (no re-render), so the click bindings above stay attached.
  const sceneSearch = $('sceneSearch');
  if (sceneSearch) {
    sceneSearch.addEventListener('input', () => {
      const q = sceneSearch.value.trim().toLowerCase();
      document.querySelectorAll('#sceneGrid .scene-group').forEach((g) => {
        let visible = 0;
        g.querySelectorAll('.scene-btn').forEach((b) => {
          const show = !q || b.textContent.toLowerCase().includes(q);
          b.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        g.hidden = visible === 0;
      });
    });
  }
  els.createBtn.addEventListener('click', onCreate);
  renderAiPanel();

  // restore last created cards
  const just = state.justCreated || [];
  if (just.length) {
    els.createdSection.hidden = false;
    els.createdGrid.innerHTML = just.map((s) => cardHtml(s)).join('');
    document.querySelectorAll('#createdGrid .song-card').forEach((card) => {
      const song = state.songs.find((s) => s.id === card.dataset.id);
      if (song) bindCard(card, song);
    });
  }
}

function renderChips() {
  const sel = state.createStyles || [];
  els.styleChips.forEach((chip) => chip.classList.toggle('on', sel.includes(chip.dataset.style)));
}

// ---------------------------------------------------------------------------
// Style chips & genre scenes (curated preset prompts)
// ---------------------------------------------------------------------------

function chipBtn(s, selected) {
  return `<button class="chip style-chip${selected.includes(s.id) ? ' on' : ''}" data-style="${s.id}">${s.label}</button>`;
}

// Style chips grouped by category (the curated genre scenes first, then the rest
// of the library under "All genres").
function styleChipsHtml(selected = []) {
  const curated = STYLES.filter((s) => s.category);
  const plain = STYLES.filter((s) => !s.category);
  const cats = [];
  curated.forEach((s) => { if (!cats.includes(s.category)) cats.push(s.category); });
  const rows = cats.map(
    (c) =>
      `<div class="chip-group"><span class="chip-group-label">${escapeHtml(c)}</span><div class="chip-row style-chips">${curated
        .filter((s) => s.category === c)
        .map((s) => chipBtn(s, selected))
        .join('')}</div></div>`
  );
  rows.push(`<div class="chip-group"><span class="chip-group-label">All genres</span><div class="chip-row style-chips">${plain.map((s) => chipBtn(s, selected)).join('')}</div></div>`);
  return rows.join('');
}

// Category picker + style chips for a form ('create' | 'remix'): the tabs narrow
// the chip list to one curated scene family, or show everything grouped by
// category as before.
function styleChipsBlockHtml(kind) {
  const activeCat = state[kind === 'create' ? 'createStyleCat' : 'remixStyleCat'] || 'all';
  const sel = (kind === 'create' ? state.createStyles : state.remixStyles) || [];
  const cats = [];
  STYLES.forEach((s) => { if (s.category && !cats.includes(s.category)) cats.push(s.category); });
  const tabs =
    `<nav class="cat-tabs cat-tabs-chips">` +
    `<button class="sub-tab${activeCat === 'all' ? ' on' : ''}" data-cat="all">All</button>` +
    cats.map((c) => `<button class="sub-tab${activeCat === c ? ' on' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('') +
    `</nav>`;
  const chips =
    activeCat === 'all'
      ? styleChipsHtml(sel)
      : `<div class="chip-row style-chips">${STYLES.filter((s) => s.category === activeCat).map((s) => chipBtn(s, sel)).join('')}</div>`;
  return tabs + chips;
}

function bindStyleChips(kind) {
  const isCreate = kind === 'create';
  const catKey = isCreate ? 'createStyleCat' : 'remixStyleCat';
  const selKey = isCreate ? 'createStyles' : 'remixStyles';
  const block = $(isCreate ? 'createChipsBlock' : 'remixChipsBlock');
  if (!block) return;
  block.querySelectorAll('.cat-tabs .sub-tab').forEach((t) => {
    t.addEventListener('click', () => {
      state[catKey] = t.dataset.cat;
      saveSettings();
      block.innerHTML = styleChipsBlockHtml(kind);
      bindStyleChips(kind);
    });
  });
  const chips = [...block.querySelectorAll('.style-chip')];
  if (isCreate) els.styleChips = chips;
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.style;
      let sel = state[selKey] || [];
      if (sel.includes(id)) sel = sel.filter((x) => x !== id);
      else if (sel.length < 2) sel = [...sel, id];
      state[selKey] = sel;
      if (isCreate) renderChips();
      else block.querySelectorAll('.style-chip').forEach((c) => c.classList.toggle('on', sel.includes(c.dataset.style)));
    });
  });
}

// Per-genre AI affinity for ordering the scene picker. Uses the exact same
// scoring as the Profile view, so liking/skipping scenes re-ranks them here on
// next render too.
function sceneAffinityMap() {
  const m = new Map();
  try {
    const { rows } = aiProfile();
    rows.forEach((r) => m.set(r.id, r.score));
  } catch {
    /* model unavailable — fall back to title order */
  }
  return m;
}

// The curated scenes as buttons; clicking one loads its descriptive prompt and
// picks its style, so a genre prompt steers both the text and the parameters.
// Within each category the scenes are sorted by the AI taste model's predicted
// affinity (highest first, title order as a stable tiebreak), and once the model
// has learnt anything the single most-loved scene overall is starred.
function sceneButtonsHtml() {
  const curated = STYLES.filter((s) => s.category);
  const cats = [];
  curated.forEach((s) => { if (!cats.includes(s.category)) cats.push(s.category); });
  const aff = sceneAffinityMap();
  const trained = aiSampleCount() >= 6;
  // one star per category (its current favourite), like Explore — plus an
  // affinity % on every scene once the model has learned
  const faves = trained ? categoryFavourites(aff) : new Set();
  return cats
    .map(
      (c) =>
        `<div class="scene-group"><span class="chip-group-label">${escapeHtml(c)}</span><div class="scene-grid">${curated
          .filter((s) => s.category === c)
          .sort((a, b) => (aff.get(b.id) ?? 0.5) - (aff.get(a.id) ?? 0.5) || a.label.localeCompare(b.label))
          .map((s) => {
            const pct = trained ? ` <span class="aff-pct-chip">${Math.round((aff.get(s.id) ?? 0.5) * 100)}%</span>` : '';
            const star = faves.has(s.id) ? ' <span class="aff-star" title="AI favourite in this category">★</span>' : '';
            return `<button class="scene-btn${faves.has(s.id) && trained ? ' top-pick' : ''}" data-style="${s.id}" title="${escapeHtml(s.scene || s.label)}">${escapeHtml(s.label)}${pct}${star}</button>`;
          })
          .join('')}</div></div>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// AI taste engine panel
// ---------------------------------------------------------------------------

// Short human summary of every bias the model is currently applying.
function aiSteerBits(rec) {
  const bits = [`~${Math.round(rec.topStyle.bpm * (1 + rec.bpmBias))} BPM`];
  if (rec.mood) bits.push(`“${rec.mood}” mood`);
  if (rec.vocals === 'on') bits.push('with vocals');
  else if (rec.vocals === 'off') bits.push('instrumental');
  if (Math.abs(rec.densityBias) >= 0.05) bits.push(rec.densityBias > 0 ? 'dense' : 'sparse');
  return bits;
}

function renderAiPanel() {
  const status = $('aiStatus');
  const toggle = $('aiToggle');
  const reset = $('aiReset');
  if (!status || !toggle || !reset) return;
  const rec = aiRecommend();
  if (rec) {
    status.innerHTML = `Learned from <b>${rec.count}</b> interactions — suggests <b>${escapeHtml(rec.topStyle.label)}</b> · ${aiSteerBits(rec).join(' · ')}`;
  } else {
    status.textContent = aiSampleCount()
      ? `Learning… (${aiSampleCount()} interactions logged)`
      : 'Rate what you hear — likes, plays and skips train this model. It only steers when you don’t pick a style yourself.';
  }
  toggle.checked = state.aiEnabled !== false;
  toggle.onchange = () => {
    state.aiEnabled = toggle.checked;
    saveSettings();
    toast(state.aiEnabled ? 'AI suggestions on' : 'AI suggestions off');
  };
  reset.onclick = () => {
    if (!confirm('Reset the AI taste model? It will forget everything it has learned.')) return;
    aiReset();
    state.aiEnabled = true;
    saveSettings();
    renderAiPanel();
    toast('AI taste model reset.');
  };
}

function aiPanelHtml() {
  return `
    <div class="field ai-panel">
      <div class="ai-head"><span>AI taste engine</span><small>neural net · trains on-device from your listening</small></div>
      <div class="ai-row">
        <span class="ai-status" id="aiStatus"></span>
        <label class="ai-toggle"><input type="checkbox" id="aiToggle" ${state.aiEnabled !== false ? 'checked' : ''} /><span>Auto-suggest</span></label>
        <button class="mini-btn" id="aiReset" title="Forget everything the AI has learned">Reset</button>
      </div>
    </div>`;
}

// Voice recorder dialog: capture ~3s of the member's voice, show a live meter,
// analyze it into a vocal profile, and store it on their account. Their songs
// (and videos) then sing with this recording instead of the generic synth.
let voiceRecActive = false;
async function openVoiceRecorder() {
  if (voiceRecActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('This browser has no microphone access — try Chrome, Edge or Firefox.', 'error');
    return;
  }
  const who = familyActiveMember();
  voiceRecActive = true;
  const dlg = document.createElement('dialog');
  dlg.className = 'fam-dialog';
  dlg.id = 'voiceRecDlg';
  dlg.innerHTML = `
    <div class="fam-dialog-icon">🎙</div>
    <h2>Record your voice</h2>
    <p class="fam-hint">Hold a steady “ahh” for 3 seconds — that becomes the voice that sings your songs. It stays on this device, in <b>${escapeHtml(who ? who.name : 'your')}</b>'s account.</p>
    <div class="vrec-meter"><div id="vrecFill"></div></div>
    <p class="settings-note" id="vrecStatus">Ready when you are.</p>
    <div class="fam-actions">
      <button type="button" class="ghost" id="vrecDelete" ${memberHasRecordedVoice() ? '' : 'hidden'}>Remove recording</button>
      <button type="button" class="ghost" id="vrecClose">Close</button>
      <button type="button" class="cta" id="vrecStart">⏺ Record 3s</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.showModal();

  const fill = dlg.querySelector('#vrecFill');
  const status = dlg.querySelector('#vrecStatus');
  const startBtn = dlg.querySelector('#vrecStart');
  const close = () => { voiceRecActive = false; dlg.close(); dlg.remove(); refreshCreateIfVisible(); };
  dlg.querySelector('#vrecClose').onclick = close;
  dlg.querySelector('#vrecDelete').onclick = async () => {
    clearVoiceSample();
    await storeVoiceAudio(getActiveMemberId(), null);
    status.textContent = 'Recording removed — songs will use the synthesized voice again.';
    dlg.querySelector('#vrecDelete').hidden = true;
    state.createVoice = '';
    familySetVoice('');
    saveSettings();
  };
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    status.textContent = 'Recording… hold a steady “ahh” 🎤';
    try {
      const { blob } = await recordVoiceSample({ seconds: 3, onLevel: (v) => { if (fill) fill.style.width = `${Math.round(v * 100)}%`; } });
      status.textContent = 'Analyzing your voice…';
      const profile = await analyzeVoiceSample(blob);
      if (!profile.ok) {
        status.textContent = profile.reason === 'too-quiet'
          ? 'Too quiet — get closer to the mic and try again.'
          : 'No steady pitch found — try holding a longer “ahh”.';
        startBtn.disabled = false;
        return;
      }
      await storeVoiceAudio(getActiveMemberId(), blob);
      storeVoiceSample(getActiveMemberId(), profile);
      state.createVoice = 'mine';
      familySetVoice('mine');
      saveSettings();
      const vsel = $('createVoice');
      if (vsel) vsel.value = 'mine';
      status.textContent = describeVoiceProfile(profile);
      dlg.querySelector('#vrecDelete').hidden = false;
      startBtn.textContent = '⏺ Record again';
      startBtn.disabled = false;
      toast('Voice saved — pick “My recorded voice” in Create to sing with it.', 'success');
    } catch (err) {
      status.textContent = err && err.name === 'NotAllowedError'
        ? 'Microphone permission was denied — allow it in the browser and try again.'
        : `Recording failed: ${err && err.message ? err.message : err}`;
      startBtn.disabled = false;
    }
  };
}

function refreshCreateIfVisible() {
  if (state.view === 'create') renderView();
}

function getActiveMemberId() {
  return familyActiveMember() ? familyActiveMember().id : 'me';
}

async function onCreate() {
  if (state.creating) return;
  const prompt = els.createPrompt.value.trim();
  if (!prompt) {
    toast('Write a description for your song first.');
    els.createPrompt.focus();
    return;
  }
  const title = els.createTitle.value.trim() || suggestTitles(prompt, Date.now())[0];
  const voice = (state.createVoice || '') || null; // '' | off | female | male
  const exclTokens = (state.excludeStyles || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const excluded = (style) =>
    exclTokens.length > 0 &&
    exclTokens.some((t) => [style.label, style.id, style.category].join(' ').toLowerCase().includes(t));
  let styles = (state.createStyles || []).filter((id) => !excluded(styleById(id)));
  if ((state.createStyles || []).length && !styles.length) {
    toast('All picked styles are excluded — pick different ones or clear the exclusion list.', 'error');
    return;
  }
  styles = styles.length ? styles : null;
  if (!styles) {
    // A prompt that *names* a genre wins over the taste model's statistical
    // guess: the knowledge layer recognizes ~150 genre names (FMA's taxonomy
    // among them) that have no chip of their own — “drum & bass”, “bossa
    // nova”, “shoegaze”, … — and maps them onto the closest curated style.
    let mapped = styleForText(prompt, STYLES);
    if (mapped) {
      const mappedStyle = styleById(mapped);
      if (excluded(mappedStyle)) {
        mapped = null;
        toast(`“${mappedStyle.label}” is on your exclude list — using the AI suggestion instead.`);
      } else {
        styles = [mapped];
        toast(`Recognized “${styleById(mapped).label}” from your description.`);
      }
    }
  }
  if (!styles && state.aiEnabled !== false) {
    const ai = aiRecommend();
    if (ai) styles = ai.styleIds.filter((id) => !excluded(styleById(id)));
  }
  if (!styles) styles = ['pop'];
  const lyrics = els.createLyrics.value.trim();

  state.creating = true;
  els.createBtn.disabled = true;
  els.createBtn.textContent = 'Creating…';
  els.generating.hidden = false;
  els.genFill.style.width = '0%';

  const t0 = Date.now();
  const stageTimer = setInterval(() => {
    const stage = CREATE_STAGES[Math.floor((Date.now() - t0) / 700) % CREATE_STAGES.length];
    els.genStage.textContent = stage;
    els.genFill.style.width = `${Math.min(92, ((Date.now() - t0) / 4200) * 100)}%`;
  }, 120);

  // Custom mode: an explicit BPM overrides the AI suggestion; variations render
  // several distinct takes of the same input (each gets its own stable seed).
  const variations = Math.min(4, Math.max(1, Number((els.createVariations && els.createVariations.value) || 1)));
  const manualBPM = els.createCustomBpm && els.createCustomBpm.checked ? Number(els.createBpm.value) : null;
  const manualSteer = manualBPM
    ? { bpmBias: manualBPM / (styleById(styles[0]).bpm || 120) - 1, densityBias: 0, mood: null, vocals: null }
    : null;

  const made = [];
  for (let v = 0; v < variations; v++) {
    const seedOverride =
      variations > 1
        ? hashSeed(`${title}|${prompt}|${styles.join(',')}|${lyrics}|${(manualSteer && manualSteer.bpmBias) || 0}|${voice}|${state.createLength}|variation:${v}`)
        : undefined;
    const result = await generateSong({ title, prompt, styles, lyrics, steer: manualSteer, lengthSec: state.createLength, seedOverride, styleRefId: state.styleRef || null, voice });
    const song = {
      id: uid(),
      title: variations > 1 ? `${title} #${v + 1}` : title,
      prompt,
      styleId: result.styleId,
      styleLabel: result.styleLabel,
      lyrics,
      duration: result.duration,
      bpm: result.bpm,
      seed: result.seed,
      hasVocals: !!result.hasVocals,
      steer: result.steering,
      voice: voice || undefined,
      voiceSig: familyVoiceSig() ?? undefined,
      midiNotes: result.midiNotes || undefined,
      lengthSec: state.createLength,
      createdAt: Date.now(),
      plays: 0,
      liked: false,
    };
    await idbPut('audio', { id: song.id, blob: result.blob });
    await idbPut('songs', song);
    state.songs.push(song);
    made.push(song);
  }
  state.justCreated = [...made, ...(state.justCreated || [])].slice(0, 6);
  const song = made[0];
  if (made.length) {
    for (let i = 0; i < made.length; i++) noteNewSongForBackup();
    autoExportSongs(made); // fire-and-forget; failures toast, songs stay safe
  }

  // Keep the animation on screen long enough to feel like real generation
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, Math.max(0, 4200 - elapsed)));
  clearInterval(stageTimer);
  els.genStage.textContent = made.length > 1 ? 'Done — here are your songs.' : 'Done — here’s your song.';
  els.genFill.style.width = '100%';

  state.creating = false;
  els.createBtn.disabled = false;
  els.createBtn.textContent = '✦ Create song';

  // Reveal + play
  els.createdSection.hidden = false;
  els.createdGrid.innerHTML = state.justCreated.map((s) => cardHtml(s)).join('');
  document.querySelectorAll('#createdGrid .song-card').forEach((card) => {
    const s = state.songs.find((x) => x.id === card.dataset.id);
    if (s) bindCard(card, s);
  });
  setTimeout(() => {
    els.generating.hidden = true;
    els.createdSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 900);
  playSong(song.id);
  toast(made.length > 1 ? `Created ${made.length} variations of “${title}”.` : `Created “${title}”.`);
}

const REMIX_STAGES = [
  'Reading the link…',
  'Extracting a musical signature…',
  'Composing the chord progression…',
  'Laying down the drums…',
  'Writing the melody…',
  'Recording the vocal line…',
  'Mixing and mastering…',
  'Finalizing your remix…',
];

function videoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (/youtube|youtu\.be/.test(u.hostname)) {
      const m = url.match(/(?:v=|shorts\/|embed\/|\/)([\w-]{6,})/);
      return m ? m[1] : u.hostname;
    }
    if (u.hostname.includes('vimeo')) {
      const m = url.match(/vimeo\.com\/(\d+)/);
      return m ? m[1] : u.hostname;
    }
    return u.hostname;
  } catch {
    return 'link';
  }
}

function renderRemix(el) {
  const selected = state.remixStyles || [];
  const remixes = state.remixes;
  el.innerHTML = `
    <div class="studio">
      <div class="studio-head">
        <p class="kicker">REMIX</p>
        <h1>Remix any video</h1>
        <p class="hero-sub">Paste a link to any video and get an original track inspired by it. The URL becomes the seed — the video itself is never fetched or downloaded.</p>
      </div>
      <div class="studio-panel">
        <label class="field">
          <span>Video link</span>
          <input id="remixUrl" type="url" class="url-input" placeholder="https://www.youtube.com/watch?v=…" />
        </label>
        <label class="field">
          <span>Song title <small>optional</small></span>
          <input id="remixTitle" placeholder="e.g. Midnight Circuit" maxlength="60" />
        </label>
        <div class="field">
          <span>Styles <small>optional — up to 2</small></span>
          <div id="remixChipsBlock">${styleChipsBlockHtml('remix')}</div>
        </div>
        <label class="field">
          <span>Length <small>full remixes render a few minutes</small></span>
          <select id="remixLength">
            <option value="30">Clip (≈30 s)</option>
            <option value="180"${state.remixLength === 180 ? ' selected' : ''}>Full (≈3 min)</option>
            <option value="240"${state.remixLength === 240 ? ' selected' : ''}>Long (≈4 min)</option>
          </select>
        </label>
        ${aiPanelHtml()}
        <button class="cta big" id="remixBtn">⟳ Remix this video</button>
      </div>
      <div class="generating" id="remixGen" hidden>
        <div class="gen-bar"><i id="remixFill"></i></div>
        <p id="remixStage">Reading the link…</p>
      </div>
      <section class="section" id="remixSection" hidden>
        <div class="section-head"><h2>Latest remixes</h2><span class="view-count">Save with ＋ · download with ⤓</span></div>
        <div class="card-grid" id="remixGrid"></div>
      </section>
    </div>
  `;

  els.remixUrl = $('remixUrl');
  els.remixTitle = $('remixTitle');
  els.remixBtn = $('remixBtn');
  els.remixGen = $('remixGen');
  els.remixFill = $('remixFill');
  els.remixStage = $('remixStage');
  els.remixSection = $('remixSection');
  els.remixGrid = $('remixGrid');
  const remixLen = $('remixLength');
  if (remixLen) remixLen.addEventListener('change', () => { state.remixLength = Number(remixLen.value) || 30; });

  bindStyleChips('remix');
  els.remixBtn.addEventListener('click', onRemix);
  renderAiPanel();

  if (remixes.length) {
    els.remixSection.hidden = false;
    els.remixGrid.innerHTML = remixes.map((s) => cardHtml(s, { discovery: true })).join('');
    document.querySelectorAll('#remixGrid .song-card').forEach((card) => {
      const song = state.remixes.find((s) => s.id === card.dataset.id);
      if (song) bindCard(card, song);
    });
  }
}

async function onRemix() {
  if (state.creating) return;
  const url = els.remixUrl.value.trim();
  if (!url) {
    toast('Paste a video link first.');
    els.remixUrl.focus();
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    toast('That doesn’t look like a valid link.');
    els.remixUrl.focus();
    return;
  }

  const id = videoIdFromUrl(url);
  const title = els.remixTitle.value.trim() || `Remix of ${id}`;
  let styles = state.remixStyles || [];
  if (state.aiEnabled !== false && !styles.length) {
    const ai = aiRecommend();
    if (ai) styles = ai.styleIds;
  }
  const prompt = `a song inspired by ${url} (${id})`;
  const seed = hashSeed(url.toLowerCase());

  state.creating = true;
  els.remixBtn.disabled = true;
  els.remixBtn.textContent = 'Remixing…';
  els.remixGen.hidden = false;
  els.remixFill.style.width = '0%';

  const t0 = Date.now();
  const stageTimer = setInterval(() => {
    const stage = REMIX_STAGES[Math.floor((Date.now() - t0) / 650) % REMIX_STAGES.length];
    els.remixStage.textContent = stage;
    els.remixFill.style.width = `${Math.min(92, ((Date.now() - t0) / 4200) * 100)}%`;
  }, 120);

  const result = await generateSong({ title, prompt, styles, seedOverride: seed, lengthSec: state.remixLength });
  const song = {
    id: `remix-${seed}`,
    title,
    prompt,
    url,
    videoId: id,
    styleId: result.styleId,
    styleLabel: result.styleLabel,
    lyrics: '',
    duration: result.duration,
    bpm: result.bpm,
    seed,
    hasVocals: !!result.hasVocals,
    steer: result.steering,
    lengthSec: state.remixLength,
    createdAt: 0,
    plays: 0,
    liked: false,
    discovery: true,
  };
  state.remixes = [song, ...state.remixes.filter((s) => s.id !== song.id)].slice(0, 6);

  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, Math.max(0, 4200 - elapsed)));
  clearInterval(stageTimer);
  els.remixStage.textContent = 'Done — here’s your remix.';
  els.remixFill.style.width = '100%';

  state.creating = false;
  els.remixBtn.disabled = false;
  els.remixBtn.textContent = '⟳ Remix this video';

  els.remixSection.hidden = false;
  els.remixGrid.innerHTML = state.remixes.map((s) => cardHtml(s, { discovery: true })).join('');
  document.querySelectorAll('#remixGrid .song-card').forEach((card) => {
    const s = state.remixes.find((x) => x.id === card.dataset.id);
    if (s) bindCard(card, s);
  });
  setTimeout(() => {
    els.remixGen.hidden = true;
    els.remixSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 900);
  playSong(song.id);
  toast(`Remixed from ${id}.`);
}

// Songs matching the current Library filter (All / Liked / a scene category) + search.
function libraryFilteredSongs() {
  let list = state.songs;
  const cat = state.libraryFilter || 'all';
  if (cat === 'liked') list = list.filter((s) => s.liked);
  else if (cat !== 'all') list = list.filter((s) => styleById(s.styleId).category === cat);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((s) => [s.title, s.prompt, s.styleLabel, s.styleId].join(' ').toLowerCase().includes(q));
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

function renderLibrary(el) {
  // only surface categories that actually have saved songs, in STYLES order
  const cats = [];
  state.songs.forEach((s) => {
    const c = styleById(s.styleId).category;
    if (c && !cats.includes(c)) cats.push(c);
  });
  let active = state.libraryFilter || 'all';
  // The Playlists filter swaps the whole view for the playlist grid/detail.
  if (active === 'playlists') {
    renderPlaylistsView(el);
    return;
  }
  // a persisted filter for a category whose songs were all deleted falls back to All
  if (active !== 'all' && active !== 'liked' && active !== 'trash' && !cats.includes(active)) {
    active = 'all';
    state.libraryFilter = 'all';
    saveSettings();
  }
  // ♻ Recently deleted: soft-deleted songs, restorable for 30 days.
  if (active === 'trash') {
    const trash = [...(state.trash || [])].sort((a, b) => b.deletedAt - a.deletedAt);
    const daysLeft = (s) => Math.max(0, Math.ceil(30 - (Date.now() - s.deletedAt) / 864e5));
    el.innerHTML = `
      <div class="view-head">
        <div>
          <p class="kicker">LIBRARY</p>
          <h1>Recently deleted</h1>
        </div>
        <div class="sub-tabs lib-tabs">
          <button class="sub-tab" data-filter="all">← All songs</button>
          <button class="sub-tab on">♻ Recently deleted (${trash.length})</button>
        </div>
      </div>
      ${trash.length
        ? `<div class="trash-list">${trash
            .map(
              (s) => `
            <div class="trash-row" data-id="${s.id}">
              <span class="trash-cover" style="background:${coverStyle(s.seed || 0).background}">${(s.title || '?').charAt(0).toUpperCase()}</span>
              <span class="trash-name"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.styleLabel || '')} · ${fmtTime(s.duration || 0)} · gone in ${daysLeft(s)} day${daysLeft(s) === 1 ? '' : 's'}</small></span>
              <span class="trash-actions">
                <button class="ghost" data-restore="${s.id}">↺ Restore</button>
                <button class="ghost" data-purge="${s.id}" title="Delete forever">✕</button>
              </span>
            </div>`
            )
            .join('')}</div>`
        : `<div class="empty-state"><div class="empty-icon">♻</div><h2>Nothing deleted</h2><p>Songs you delete wait here for 30 days before they're gone for good.</p></div>`}
    `;
    el.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restoreSong(b.dataset.restore)));
    el.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', () => hardDeleteSong(b.dataset.purge)));
    el.querySelectorAll('.lib-tabs .sub-tab').forEach((b) => {
      if (b.dataset.filter === 'all') b.addEventListener('click', () => { state.libraryFilter = 'all'; saveSettings(); renderView(); });
    });
    return;
  }
  const list = libraryFilteredSongs();
  const countIn = (c) => state.songs.filter((s) => styleById(s.styleId).category === c).length;
  // most-produced genre within a category (ties go to the first seen)
  const categoryTopGenre = (c) => {
    const counts = {};
    state.songs.forEach((s) => {
      if (styleById(s.styleId).category === c) counts[s.styleId] = (counts[s.styleId] || 0) + 1;
    });
    let bestId = null;
    let best = 0;
    for (const id in counts) {
      if (counts[id] > best) { best = counts[id]; bestId = id; }
    }
    return bestId ? styleById(bestId).label : null;
  };

  // Variation families render as collapsible stacks: the original card on
  // top, its takes tucked beneath. A variation whose parent isn't in the
  // filtered list (deleted, or filtered out) shows as a normal flat card.
  const inList = new Set(list.map((s) => s.id));
  const entries = [];
  for (const s of list) {
    if (s.variationOf && inList.has(s.variationOf)) continue; // rendered inside its family
    const kids = variationChildren(s.id).filter((k) => inList.has(k.id));
    entries.push({ song: s, kids });
  }
  const familyCard = (song, index, total) =>
    cardHtml(song, { showDelete: true, showEdit: true, take: { index, total }, showKeep: true, showAb: true });
  const groupHtml = ({ song, kids }) => {
    const total = kids.length + 1;
    const expanded = !!(state.varExpanded && state.varExpanded[song.id]);
    return `
      <div class="var-group${expanded ? ' open' : ''}" data-group="${song.id}">
        ${familyCard(song, 1, total)}
        <button class="var-toggle" data-group="${song.id}" title="Show or hide the other takes of this song">${expanded ? '▾' : '▸'} ${total} takes</button>
        <div class="var-stack"${expanded ? '' : ' hidden'}>${kids.map((k, i) => familyCard(k, i + 2, total)).join('')}</div>
      </div>`;
  };
  const gridHtml = entries.length
    ? `<div class="card-grid" id="libGrid">${entries.map((e) => (e.kids.length ? groupHtml(e) : cardHtml(e.song, { showDelete: true, showEdit: true }))).join('')}</div>`
    : `<div class="empty-state">
        <div class="empty-icon">▤</div>
        <h2>${state.songs.length ? 'Nothing matches' : 'Your library is empty'}</h2>
        <p>${state.songs.length ? 'Try a different search or switch filters.' : 'Create your first song and it will show up here.'}</p>
      </div>`;

  el.innerHTML = `
    <div class="view-head">
      <div>
        <p class="kicker">LIBRARY</p>
        <h1>Your songs</h1>
      </div>
      <div class="sub-tabs lib-tabs">
        <button class="sub-tab${active === 'all' ? ' on' : ''}" data-filter="all">All (${state.songs.length})</button>
        <button class="sub-tab${active === 'liked' ? ' on' : ''}" data-filter="liked">♥ Liked (${state.songs.filter((s) => s.liked).length})</button>
        <button class="sub-tab${active === 'playlists' ? ' on' : ''}" data-filter="playlists">◫ Playlists (${state.playlists.length})</button>
        <button class="sub-tab${active === 'trash' ? ' on' : ''}" data-filter="trash" title="Soft-deleted songs, restorable for 30 days">♻ Recently deleted (${(state.trash || []).length})</button>
        ${cats.map((c) => {
          const top = categoryTopGenre(c);
          const label = top ? `${c} · ${top}` : c;
          return `<button class="sub-tab${active === c ? ' on' : ''}" data-filter="${escapeHtml(c)}" title="${escapeHtml(label)}">${escapeHtml(label)} (${countIn(c)})</button>`;
        }).join('')}
      </div>
    </div>
    ${gridHtml}
  `;  document.querySelectorAll('.lib-tabs .sub-tab').forEach((b) => {
    b.addEventListener('click', () => {
      state.libraryFilter = b.dataset.filter;
      saveSettings();
      history.replaceState(null, '', `#library=${b.dataset.filter}`);
      renderLibrary(el);
    });
  });

  document.querySelectorAll('#libGrid .song-card').forEach((card) => {
    const song = state.songs.find((s) => s.id === card.dataset.id);
    if (song) bindCard(card, song, { onEdit: (s) => openEditDialog(s) });
  });
  document.querySelectorAll('#libGrid .var-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.varExpanded = state.varExpanded || {};
      state.varExpanded[btn.dataset.group] = !state.varExpanded[btn.dataset.group];
      renderLibrary(el);
    });
  });
}

// ---------------------------------------------------------------------------
// Variation families — an original song plus the takes created from it via
// “duplicate as variation”. In the Library each family renders as one
// collapsible stack; any take can be crowned the keeper.
// ---------------------------------------------------------------------------

// Live takes of a family: everything that points at the parent id.
function variationChildren(songId) {
  return state.songs
    .filter((s) => s.variationOf === songId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// The family a song belongs to, following variationOf up to the original.
// Returns null for songs with no family.
function variationFamily(song) {
  let top = song;
  for (let i = 0; i < 10 && top.variationOf; i++) {
    const parent = state.songs.find((s) => s.id === top.variationOf);
    if (!parent) break; // parent deleted — treat this take as its own original
    top = parent;
  }
  const kids = variationChildren(top.id);
  return kids.length ? { top, kids } : null;
}

// Crown one take as the favourite of its family (or, if it already was the
// keeper, clear the crown). Persists to IndexedDB and refreshes the view.
async function keepTake(song) {
  const fam = variationFamily(song);
  const members = fam ? [fam.top, ...fam.kids] : [song];
  const wasKeeper = !!song.keptTake;
  for (const m of members) {
    m.keptTake = !wasKeeper && m.id === song.id;
    if (m.createdAt) await idbPut('songs', m);
  }
  renderView();
  toast(wasKeeper
    ? `Keeper mark removed — no favourite take in this family.`
    : `“${song.title}” marked as the keeper ★ — your favourite take of this family.`);
}

// ---------------------------------------------------------------------------
// A/B compare — play a variation family's takes back-to-back with instant
// switching. Switching keeps the playback position, so you hear every take
// over the same passage instead of restarting each one from zero.
// ---------------------------------------------------------------------------

// state.abCompare = { ids: [take ids in family order], pos: seconds } while
// the compare dialog is open; null otherwise.

function abTakeLabel(song, index) {
  return `Take ${index + 1}`;
}

// Peak data per take id, cached across dialog opens so reopening a family is
// instant. Values are { peaks, seconds } or null while a load is in flight.
const abWaves = new Map();

async function loadAbWaveform(song) {
  try {
    const blob = await ensureAudio(song);
    const fast = await readWavPeaks16(blob, 400);
    return fast || (await readWavPeaksDecoded(blob, 400));
  } catch (err) {
    console.warn('A/B waveform unavailable:', err);
    return null;
  }
}

// Draw one take's waveform: muted bars, the played portion tinted on the
// active take, and a position marker so you can see where each take is —
// all takes share the same playback position while comparing.
function drawAbWaveRow(canvas, data, dur, t, active) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 220;
  const h = canvas.clientHeight || 40;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement);
  const violet = cs.getPropertyValue('--violet').trim() || '#8b5cf6';
  const pink = cs.getPropertyValue('--pink').trim() || '#ec4899';
  const muted = cs.getPropertyValue('--muted').trim() || '#8f8fa8';
  const midY = h / 2;
  if (data && data.peaks && dur > 0) {
    const peaks = data.peaks;
    const n = peaks.length;
    for (let px = 0; px < w; px += 2) {
      const tt = (px / w) * dur;
      const amp = Math.max(1, peaks[Math.max(0, Math.min(n - 1, Math.floor((tt / dur) * n)))] * (midY - 3));
      const played = tt <= t;
      ctx.fillStyle = active && played ? pink : muted;
      ctx.globalAlpha = active ? (played ? 0.95 : 0.4) : 0.45;
      ctx.fillRect(px, midY - amp, 1.4, amp * 2);
    }
    ctx.globalAlpha = 1;
  } else {
    // Peaks still loading (or unavailable): flat baseline placeholder.
    ctx.fillStyle = muted;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(0, midY, w, 1);
    ctx.globalAlpha = 1;
  }
  if (dur > 0 && t > 0) {
    const x = Math.max(0, Math.min(w, (t / dur) * w));
    ctx.fillStyle = active ? violet : muted;
    ctx.globalAlpha = active ? 1 : 0.7;
    ctx.fillRect(x - 1, 0, 2, h);
    ctx.globalAlpha = 1;
  }
}

function drawAbWaves() {
  if (!state.abCompare || !els.abDialog || !els.abDialog.open) return;
  const pos = state.abCompare.pos || 0;
  els.abTakes.querySelectorAll('.ab-take').forEach((row) => {
    const id = row.dataset.ab;
    const song = findSong(id);
    const canvas = row.querySelector('.ab-wave');
    if (!song || !canvas) return;
    const active = id === state.currentSongId && !player.paused;
    const t = active ? (player.audio.currentTime || 0) : pos;
    drawAbWaveRow(canvas, abWaves.get(id), song.duration || 0, t, active);
    if (!abWaves.has(id)) {
      abWaves.set(id, null); // pending marker — one load per take
      loadAbWaveform(song).then((data) => {
        // On failure store a {peaks:null} sentinel: draw the placeholder but
        // don't retry at every playback tick (a corrupt blob would be hammered).
        abWaves.set(id, data || { peaks: null });
        if (state.abCompare && state.abCompare.ids.includes(id)) drawAbWaves();
      });
    }
  });
}

function openAbCompare(song) {
  const fam = variationFamily(song);
  const ids = fam ? [fam.top.id, ...fam.kids.map((k) => k.id)] : [song.id];
  state.abCompare = { ids, pos: 0 };
  // next/prev also cycle just the takes while comparing
  state.order = [...ids];
  els.abTitle.textContent = `A/B compare — ${fam ? fam.top.title : song.title}`;
  refreshAbDialog();
  els.abDialog.showModal();
  // If a family take is already playing, continue it; otherwise start take 1.
  if (!ids.includes(state.currentSongId) || player.paused) {
    const startId = ids.includes(state.currentSongId) ? state.currentSongId : ids[0];
    playSong(startId);
  }
  refreshAbDialog();
}

// Switch to take `id` continuing from the current playback position.
async function switchAbTake(id) {
  if (!state.abCompare || !state.abCompare.ids.includes(id)) return;
  // Snapshot the position first — whether playing (live time) or paused
  // (last known compare position).
  const pos = player.paused ? state.abCompare.pos : player.audio.currentTime || 0;
  state.abCompare.pos = pos;
  await playSong(id);
  // play() resolves once playback starts; if metadata hasn't parsed yet the
  // duration is still 0, so wait briefly rather than silently dropping the seek.
  let dur = player.duration || 0;
  for (let i = 0; !dur && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    dur = player.duration || 0;
  }
  const target = Math.min(pos, Math.max(0, dur - 0.25));
  if (target > 0.05) player.seek(target);
  refreshAbDialog();
}

function refreshAbDialog() {
  if (!state.abCompare || !els.abTakes) return;
  const { ids } = state.abCompare;
  els.abTakes.innerHTML = ids
    .map((id, i) => {
      const s = findSong(id);
      if (!s) return '';
      const playing = id === state.currentSongId && !player.paused;
      return `
        <button class="ab-take${playing ? ' playing' : ''}${s.keptTake ? ' keeper' : ''}" data-ab="${id}">
          <span class="ab-letter">${String.fromCharCode(65 + i)}</span>
          <span class="ab-label">
            <b>${abTakeLabel(s, i)}${s.keptTake ? ' <span class="ab-keeper">★</span>' : ''}</b>
            <small>${escapeHtml(s.styleLabel)} · ${fmtTime(s.duration)}${s.edited ? ' · ✂ edited' : ''}${playing ? ' · ▶ playing' : ''}</small>
          </span>
          <canvas class="ab-wave" aria-hidden="true"></canvas>
          <span class="ab-eq">${playing ? '❚❚' : '▶'}</span>
        </button>`;
    })
    .join('');
  els.abTakes.querySelectorAll('[data-ab]').forEach((btn) => {
    btn.addEventListener('click', () => switchAbTake(btn.dataset.ab));
  });
  drawAbWaves();
}

function closeAbCompare() {
  state.abCompare = null;
}

// ---------------------------------------------------------------------------
// Playlists — group saved songs into your own collections. Songs are always
// referenced by id, never copied, so playlists stay tiny and safe to edit.
// ---------------------------------------------------------------------------

let pickerSong = null; // song being added via the playlist picker dialog

function playlistById(id) {
  return state.playlists.find((p) => p.id === id) || null;
}

function playlistSongs(pl) {
  const map = new Map(state.songs.map((s) => [s.id, s]));
  return pl.songIds.map((id) => map.get(id)).filter(Boolean);
}

async function createPlaylist(name) {
  const clean = String(name).trim().slice(0, 60);
  if (!clean) return null;
  const pl = { id: uid(), name: clean, songIds: [], createdAt: Date.now() };
  state.playlists.unshift(pl);
  await idbPut('playlists', pl);
  return pl;
}

async function renamePlaylist(id, name) {
  const pl = playlistById(id);
  const clean = String(name).trim().slice(0, 60);
  if (!pl || !clean) return;
  pl.name = clean;
  await idbPut('playlists', pl);
}

async function deletePlaylist(id) {
  const pl = playlistById(id);
  if (!pl) return;
  if (!confirm(`Delete playlist “${pl.name}”? The songs themselves stay in your library.`)) return;
  state.playlists = state.playlists.filter((p) => p.id !== id);
  if (state.playlistViewId === id) state.playlistViewId = null;
  await idbDelete('playlists', id);
  renderLibrary(els.content);
  toast(`Playlist “${pl.name}” deleted.`);
}

async function setSongInPlaylist(pl, songId, inList) {
  const has = pl.songIds.includes(songId);
  if (inList && !has) pl.songIds.push(songId);
  else if (!inList && has) pl.songIds = pl.songIds.filter((x) => x !== songId);
  await idbPut('playlists', pl);
}

function openPlaylistPicker(song) {
  pickerSong = song;
  els.playlistPickerTitle.textContent = `Add “${song.title}” to a playlist`;
  const list = els.playlistPickerList;
  list.innerHTML = state.playlists.length
    ? state.playlists
        .map((pl) => {
          const on = pl.songIds.includes(song.id);
          return `<label class="pick-row"><input type="checkbox" data-pl="${pl.id}" ${on ? 'checked' : ''} /><span>${escapeHtml(pl.name)}</span><em>${playlistSongs(pl).length}</em></label>`;
        })
        .join('')
    : '<p class="pick-empty">No playlists yet — create one below.</p>';
  els.playlistPickerName.value = '';
  els.playlistPickerDialog.showModal();
  list.querySelectorAll('input[data-pl]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const pl = playlistById(cb.dataset.pl);
      if (!pl) return;
      await setSongInPlaylist(pl, song.id, cb.checked);
      toast(cb.checked ? `Added to “${pl.name}”.` : `Removed from “${pl.name}”.`);
    });
  });
}

function playlistCardHtml(pl) {
  const songs = playlistSongs(pl);
  const tiles = songs
    .slice(0, 4)
    .map((s) => `<span class="pl-tile" style="background:${coverStyle(s.seed, coverLetter(s.title)).background}"></span>`)
    .join('');
  const total = songs.reduce((a, s) => a + (s.duration || 0), 0);
  return `
    <div class="playlist-card" data-pl="${pl.id}">
      <div class="pl-cover">${tiles || '<span class="pl-tile pl-tile-empty">◫</span>'}</div>
      <div class="pl-meta">
        <b class="pl-name" title="${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</b>
        <span class="pl-sub">${songs.length} song${songs.length === 1 ? '' : 's'} · ${fmtTime(total)}</span>
      </div>
      <div class="pl-actions">
        <button class="mini-btn pl-play" title="Play playlist">▶</button>
        <button class="mini-btn pl-del" title="Delete playlist">🗑</button>
      </div>
    </div>`;
}

function renderPlaylistsView(el) {
  if (state.playlistViewId) {
    renderPlaylistDetail(el, state.playlistViewId);
    return;
  }
  renderPlaylistGrid(el);
}

function renderPlaylistGrid(el) {
  el.innerHTML = `
    <div class="view-head">
      <div>
        <p class="kicker">LIBRARY · PLAYLISTS</p>
        <h1>Your playlists</h1>
        <p class="hero-sub">Group your songs into collections — a road-trip mix, a workout set, anything. Playlists reference your library; they never copy or move songs.</p>
      </div>
      <div class="sub-tabs lib-tabs">
        <button class="sub-tab" data-filter="all">All (${state.songs.length})</button>
        <button class="sub-tab" data-filter="liked">♥ Liked (${state.songs.filter((s) => s.liked).length})</button>
        <button class="sub-tab on" data-filter="playlists">◫ Playlists (${state.playlists.length})</button>
      </div>
    </div>
    <button class="ghost" id="newPlaylistBtn">＋ New playlist</button>
    <div class="playlist-grid">
      ${state.playlists.length ? state.playlists.map(playlistCardHtml).join('') : `<div class="empty-state">
        <div class="empty-icon">◫</div>
        <h2>No playlists yet</h2>
        <p>Create one, then press ＋ on any song card to add it.</p>
      </div>`}
    </div>
  `;
  document.querySelectorAll('.lib-tabs .sub-tab').forEach((b) => {
    b.addEventListener('click', () => {
      state.libraryFilter = b.dataset.filter;
      saveSettings();
      renderLibrary(el);
    });
  });
  $('newPlaylistBtn').addEventListener('click', async () => {
    const name = prompt('Name your new playlist:');
    const pl = name ? await createPlaylist(name) : null;
    if (pl) renderPlaylistGrid(el);
  });
  document.querySelectorAll('.playlist-card').forEach((card) => {
    const pl = playlistById(card.dataset.pl);
    if (!pl) return;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.pl-del')) {
        e.stopPropagation();
        deletePlaylist(pl.id);
        return;
      }
      if (e.target.closest('.pl-play')) {
        e.stopPropagation();
        const songs = playlistSongs(pl);
        if (songs.length) {
          state.order = songs.map((s) => s.id);
          playSong(songs[0].id);
        }
        return;
      }
      state.playlistViewId = pl.id;
      renderPlaylistDetail(el, pl.id);
    });
  });
}

function renderPlaylistDetail(el, id) {
  const pl = playlistById(id);
  if (!pl) {
    state.playlistViewId = null;
    return renderPlaylistGrid(el);
  }
  const songs = playlistSongs(pl);
  const total = songs.reduce((a, s) => a + (s.duration || 0), 0);
  el.innerHTML = `
    <div class="view-head">
      <div>
        <button class="mini-btn" id="plBack">← Back to playlists</button>
        <p class="kicker">PLAYLIST</p>
        <h1>${escapeHtml(pl.name)}</h1>
        <p class="hero-sub">${songs.length} song${songs.length === 1 ? '' : 's'} · ${fmtTime(total)} · press − on a card to remove it (the song stays in your library). “🗂 Export to folder” saves the whole playlist as per-song .wav + .json files plus a playlist.json manifest.</p>
      </div>
      <div class="pl-detail-actions">
        <button class="cta" id="plPlayAll">▶ Play all</button>
        <button class="ghost" id="plExport">🗂 Export to folder</button>
        <button class="ghost" id="plRename">✎ Rename</button>
      </div>
    </div>
    ${songs.length ? `<div class="card-grid" id="plGrid">${songs.map((s) => cardHtml(s, { showRemove: true })).join('')}</div>` : `<div class="empty-state">
      <div class="empty-icon">◫</div>
      <h2>This playlist is empty</h2>
      <p>Go back to the library and press ＋ on any song card to add it here.</p>
    </div>`}
  `;
  $('plBack').addEventListener('click', () => {
    state.playlistViewId = null;
    renderLibrary(el);
  });
  $('plPlayAll').addEventListener('click', () => {
    if (!songs.length) return;
    state.order = songs.map((s) => s.id);
    playSong(songs[0].id);
  });
  $('plExport').addEventListener('click', () => exportPlaylist(pl));
  $('plRename').addEventListener('click', async () => {
    const name = prompt('Rename this playlist:', pl.name);
    if (name && name.trim()) {
      await renamePlaylist(pl.id, name);
      renderPlaylistDetail(el, pl.id);
    }
  });
  document.querySelectorAll('#plGrid .song-card').forEach((card) => {
    const song = songs.find((s) => s.id === card.dataset.id);
    if (song) {
      bindCard(card, song, {
        onRemove: async (s) => {
          await setSongInPlaylist(pl, s.id, false);
          toast(`Removed from “${pl.name}”.`);
          renderPlaylistDetail(el, pl.id);
        },
      });
    }
  });
}

// The manifest that makes an exported playlist folder self-describing: the
// playlist identity + song order, and each song's file stem so the folder can
// be re-assembled (and later re-imported) without guessing.
function playlistManifest(pl, songs) {
  return {
    app: 'music-for-studio',
    kind: 'playlist',
    version: 1,
    id: pl.id,
    name: pl.name,
    createdAt: pl.createdAt,
    songIds: pl.songIds,
    songs: songs.map((s) => ({ id: s.id, title: s.title, file: `${slugify(s.title)}-${s.id.slice(0, 8)}` })),
  };
}

// Write a whole playlist into a folder the user picks: every song as
// <title>-<id>.wav + <title>-<id>.json (the same per-song format the Workspace
// tab uses, so individual songs import normally) plus playlist.json.
async function exportPlaylist(pl) {
  const songs = playlistSongs(pl);
  if (!songs.length) {
    toast('This playlist is empty — add songs first.');
    return;
  }
  const manifest = playlistManifest(pl, songs);
  if (typeof window.showDirectoryPicker !== 'function') {
    // No File System Access API (Firefox/Safari): download each song + the
    // manifest individually so nothing is lost.
    toast('Folder export needs Chrome or Edge — downloading each song instead.', 'error');
    for (const song of songs) {
      const stem = `${slugify(song.title)}-${song.id.slice(0, 8)}`;
      downloadBlob(await ensureAudio(song), `${stem}.wav`);
      downloadBlob(new Blob([JSON.stringify(workspaceMeta(song), null, 2)], { type: 'application/json' }), `${stem}.json`);
    }
    downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'playlist.json');
    toast(`Downloaded “${pl.name}” — ${songs.length} song(s) + playlist.json.`);
    return;
  }
  let dir = null;
  try {
    dir = await window.showDirectoryPicker({ id: 'musicforstudio-playlist', mode: 'readwrite' });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled
    console.error(err);
    toast('Could not open the folder: ' + err.message);
    return;
  }
  try {
    await writeFileIn(dir, 'playlist.json', JSON.stringify(manifest, null, 2));
    for (const song of songs) {
      const stem = `${slugify(song.title)}-${song.id.slice(0, 8)}`;
      await writeFileIn(dir, `${stem}.wav`, await ensureAudio(song));
      await writeFileIn(dir, `${stem}.json`, JSON.stringify(workspaceMeta(song), null, 2));
    }
    toast(`Exported “${pl.name}” (${songs.length} song(s)) to your folder.`);
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Taste profile view — visualizes the AI model so you can watch it learn.
// ---------------------------------------------------------------------------

let profileTimer = null;
let exploreTimer = null;
let learnTimer = null;
const PROFILE_REFRESH = 2000; // live "watch it learn" refresh, ms

// Small legend line explaining the ★ (category favourite) and % (predicted
// affinity) shown on AI-ranked chips/scenes once the model has learnt enough.
function affLegendHtml() {
  return `<p class="aff-legend"><span class="aff-star">★</span> = this category's current AI favourite &nbsp;·&nbsp; <span class="aff-pct-chip">%</span> = predicted affinity, learned from your likes, plays &amp; skips</p>`;
}

function profileBarRow(r, i, topId) {
  const pct = Math.max(0, Math.min(100, Math.round(r.score * 100)));
  const evid =
    r.pos && r.neg ? `♥${r.pos} · ✕${r.neg}` : r.pos ? `♥${r.pos}` : r.neg ? `✕${r.neg}` : 'no direct feedback';
  return `
    <div class="profile-row${r.id === topId ? ' is-top' : ''}" data-id="${r.id}">
      <span class="aff-label">${escapeHtml(r.label)}${r.id === topId ? ' <span class="aff-star" title="Top predicted affinity">★</span>' : ''}</span>
      <div class="aff-track"><div class="aff-fill" data-idx="${i}" style="width:${pct}%"></div><span class="aff-pct">${pct}%</span></div>
      <span class="aff-evid">${evid}</span>
    </div>`;
}

// The “how your music sounds” panel: the fingerprint the engine learned from
// the actual audio (genreAI technique) + when you listen (MeloTune technique).
function soundPanelHtml() {
  const prof = aiSoundProfile();
  const ctx = aiContextStyle();
  const { bucket } = currentContext();
  const rows = [
    ['Energy', 'e'],
    ['Dynamics', 'd'],
    ['Brightness', 'b'],
    ['Rhythm density', 'r'],
  ];
  const bars = prof.confidence > 0
    ? rows
        .map(
          ([label, k]) => `
      <div class="sound-row">
        <span class="aff-label">${label}</span>
        <div class="aff-track"><div class="aff-fill" style="width:${Math.round((prof.liked[k] || 0) * 100)}%"></div></div>
        <span class="aff-evid">${Math.round((prof.delta[k] || 0) * 100) >= 3 ? '+' : ''}${Math.round((prof.delta[k] || 0) * 100)}% vs. library</span>
      </div>`
        )
        .join('')
    : '<p class="settings-note">Play and like a few songs — the engine starts reading the actual sound (energy, dynamics, brightness, rhythm), not just the genre label.</p>';
  return `
    <div class="sound-panel">
      <div class="ai-head"><span>🎵 Sound fingerprint</span><small>learned from your liked songs' actual audio · never leaves this device</small></div>
      ${bars}
      <p class="settings-note">⏰ ${ctx
        ? `In the ${ctx.bucket}s you keep coming back to <b>${escapeHtml(styleById(ctx.styleId).label)}</b> — new suggestions lean that way now.`
        : `No ${bucket} pattern yet — keep listening and the engine learns when you enjoy what.`}</p>
    </div>`;
}

function renderProfile(el) {
  const { rows, count } = aiProfile();
  const rec = aiRecommend();
  const topId = rows.length ? rows[0].id : null;
  el.innerHTML = `
    <div class="view-head">
      <div>
        <p class="kicker">YOUR TASTE PROFILE</p>
        <h1>What the AI has learned</h1>
        <p class="hero-sub">Predicted affinity for each genre, ranked — updated live as you ♥ like, play, download, and skip.</p>
      </div>
      <div class="profile-stat"><div class="profile-stat-num" id="profileTotal">${count}</div><div class="profile-stat-label">signals learned</div></div>
    </div>
    ${rec ? `<div class="ai-chip-row"><button class="chip on" id="profileChip" data-genre="${rec.topStyle.id}">AI suggests <b>${escapeHtml(rec.topStyle.label)}</b> · ${aiSteerBits(rec).join(' · ')}${rec.contextUsed ? ' · <span title="Chosen because of the time of day you listen">⏰ context</span>' : ''}</button></div>` : ''}
    ${count ? '' : '<p class="settings-note">No feedback yet — ♥ like, play through, or skip songs elsewhere and watch these bars start to take shape.</p>'}
    ${soundPanelHtml()}
    <div class="profile-list" id="profileList"></div>
  `;

  const list = $('profileList');
  list.innerHTML = rows.length ? rows.map((r, i) => profileBarRow(r, i, topId)).join('') : '<p class="settings-note">No genres loaded yet.</p>';
  const chip = $('profileChip');
  if (chip) {
    chip.addEventListener('click', () => {
      state.exploreGenre = chip.dataset.genre;
      saveSettings();
      if (!state.exploreCache.some((x) => x.styleId === state.exploreGenre)) buildExplore().then(() => setView('explore'));
      else setView('explore');
    });
  }

  // Watch the model learn: periodically refresh bar widths/evidence in place
  // (no re-render, so bars animate without the page jumping).
  clearInterval(profileTimer);
  profileTimer = setInterval(() => {
    if (state.view !== 'profile') {
      clearInterval(profileTimer);
      return;
    }
    refreshProfileBars();
  }, PROFILE_REFRESH);
}

function refreshProfileBars() {
  const { rows, count } = aiProfile();
  if (!rows.length) return;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const topId = rows[0].id;
  document.querySelectorAll('.profile-row').forEach((rowEl) => {
    const r = byId.get(rowEl.dataset.id);
    if (!r) return;
    const pct = Math.max(0, Math.min(100, Math.round(r.score * 100)));
    const fill = rowEl.querySelector('.aff-fill');
    if (fill) fill.style.width = pct + '%';
    const pctEl = rowEl.querySelector('.aff-pct');
    if (pctEl) pctEl.textContent = pct + '%';
    const evidEl = rowEl.querySelector('.aff-evid');
    if (evidEl) {
      evidEl.textContent =
        r.pos && r.neg ? `♥${r.pos} · ✕${r.neg}` : r.pos ? `♥${r.pos}` : r.neg ? `✕${r.neg}` : 'no direct feedback';
    }
    rowEl.classList.toggle('is-top', r.id === topId);
    rowEl.querySelector('.aff-star')?.remove();
    if (r.id === topId) rowEl.querySelector('.aff-label')?.insertAdjacentHTML('beforeend', ' <span class="aff-star" title="Top predicted affinity">★</span>');
  });
  const tot = $('profileTotal');
  if (tot) tot.textContent = count;
}

// --- Anchor chip-nav, shared by Settings / Learn / Workspace -----------------
// Chips jump to their section, the URL hash mirrors the current section while
// scrolling (so links like #settings=backups are shareable), and a scroll-spy
// keeps the active chip following the scroll. One spy per view key lives on
// #content; re-renders replace their own spy, never stack a second one.
// Extras: keyboard arrows/Home/End (roving tablist), a back-to-top chip, a
// per-section copy-link button in each panel head, a ⌕ search chip, and a
// scroll progress bar under the nav row.
function scrollContentTo(target, offset = 12) {
  const el = els.content;
  if (!el || !target) return;
  const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - offset;
  // Instant jumps: smooth scrolling is unreliable inside embedded previews.
  el.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
}

function anchorNavHtml(key, entries) {
  return `<nav class="settings-anchor-nav" aria-label="${key} sections">
    <div class="settings-anchor-chips" role="tablist" aria-label="Jump to section">
      ${entries.map(([id, label, badge]) => `<a class="settings-anchor" role="tab" aria-selected="false" href="#${key}=${id}" data-section="${id}" tabindex="-1">${escapeHtml(label)}${badge ? `<span class="chip-dot" title="${escapeHtml(badge.title || '')}"></span>` : ''}</a>`).join('')}
    </div>
    <button type="button" class="settings-anchor settings-anchor-search" data-navsearch="${key}" title="Find a section — type to jump">⌕</button>
    <button type="button" class="settings-anchor settings-anchor-top" data-navtop="${key}" title="Back to top">↑</button>
    <div class="anchor-progress" aria-hidden="true"><div class="anchor-progress-fill"></div></div>
  </nav>`;
}

// Collapsible-section state, persisted per view (own tiny key — not part of
// the main settings schema).
const COLLAPSED_KEY = 'mfs.collapsed.v1';
function loadCollapsedSet(view) {
  try {
    return new Set((JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}')[view]) || []);
  } catch {
    return new Set();
  }
}
function saveCollapsedSet(view, set) {
  let all = {};
  try { all = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}') || {}; } catch {}
  all[view] = [...set];
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(all));
}

// Small button for a section head: copies a deep link to that exact panel.
function copyLinkHtml(hashSuffix) {
  return `<button type="button" class="ghost-mini copy-link-btn" data-copylink="${escapeHtml(hashSuffix)}" title="Copy a link to this section">⧉ Link</button>`;
}

function wireCopyLinks(root) {
  root.querySelectorAll('[data-copylink]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const link = `${location.href.split('#')[0]}#${btn.dataset.copylink}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied — anyone opening it lands on this section.');
      } catch {
        // Clipboard can be blocked (permissions/insecure context) — surface the
        // link through the share box instead of failing silently.
        els.shareInput.value = link;
        els.shareInput.select?.();
        toast('Copy was blocked — the link is in the share box instead.');
      }
    });
  });
}

// Mini section-finder behind the ⌕ chip: type-to-filter over section labels +
// keywords; arrows/Enter/click jump. One dialog per invocation, removed on close.
function openSectionSearch(items, onJump) {
  document.querySelectorAll('.nav-search-dialog').forEach((d) => { try { d.close(); } catch {} d.remove(); });
  const dlg = document.createElement('dialog');
  dlg.className = 'nav-search-dialog';
  dlg.innerHTML = `
    <input class="nav-search-input" type="text" placeholder="Type a section name…" spellcheck="false" autocomplete="off" />
    <div class="nav-search-list" role="listbox"></div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector('.nav-search-input');
  const list = dlg.querySelector('.nav-search-list');
  // Explicit removal, not just close(): some embedded webviews never dispatch
  // the dialog `close` event, which would leak an invisible dialog per jump.
  const closeDlg = () => { try { dlg.close(); } catch {} dlg.remove(); };
  let matches = items;
  let sel = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    matches = q ? items.filter((it) => `${it.label} ${it.kw || ''}`.toLowerCase().includes(q)) : items.slice();
    if (sel >= matches.length) sel = Math.max(0, matches.length - 1);
    list.innerHTML = matches.length
      ? matches.map((it, i) => `
        <button type="button" role="option" aria-selected="${i === sel}" class="nav-search-item${i === sel ? ' sel' : ''}" data-id="${it.id}">
          ${escapeHtml(it.label)}${it.kw ? `<small>${escapeHtml(it.kw)}</small>` : ''}
        </button>`).join('')
      : '<p class="nav-search-empty">No section matches that.</p>';
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    closeDlg();
    onJump(b.dataset.id);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, matches.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (matches[sel]) { closeDlg(); onJump(matches[sel].id); } }
  });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  input.focus();
  render();
}

// key doubles as the hash namespace and the expected state.view name. Sections
// are found via sectionSel(id), or by default as #<key>-<id> (the Settings ids).
function wireAnchorNav(el, key, { defaultId, sectionSel, offset = 12, keywords = {}, extraSearch = [], collapsible = null } = {}) {
  // Only real section chips — the ⌕/↑ buttons share the chip styling but have
  // no data-section and must not jump anywhere.
  const anchors = [...el.querySelectorAll('.settings-anchor[data-section]')];
  if (!anchors.length) return;
  const sectionOf = (id) => (sectionSel ? sectionSel(id) : el.querySelector(`#${key}-${CSS.escape(id)}`));
  const sections = anchors.map((a) => sectionOf(a.dataset.section)).filter(Boolean);
  const idOf = (s) => s.dataset.anchorSection || (s.id || '').replace(new RegExp(`^${key}-`), '');
  const setActive = (id) => anchors.forEach((a) => {
    const on = a.dataset.section === id;
    a.classList.toggle('active', on);
    a.tabIndex = on ? 0 : -1; // roving tabindex: the active chip is the tab stop
    if (on) {
      a.setAttribute('aria-current', 'true');
      a.setAttribute('aria-selected', 'true');
    } else {
      a.removeAttribute('aria-current');
      a.setAttribute('aria-selected', 'false');
    }
  });
  // A collapsed target is expanded before jumping — never scroll to an
  // invisible body. With `collapsible`, clicking the ALREADY-ACTIVE chip
  // toggles its section's collapse instead of re-jumping.
  const expandIfCollapsed = (id) => {
    if (!collapsible) return;
    const sec = sectionOf(id);
    if (sec && collapsible.isCollapsed(sec)) collapsible.expand(sec, idOf(sec));
  };
  const jumpTo = (id) => {
    expandIfCollapsed(id);
    history.replaceState(null, '', `#${key}=${id}`);
    setActive(id);
    spyPausedUntil = Date.now() + 400;
    scrollContentTo(sectionOf(id), offset);
  };
  // After a chip jump the spy pauses briefly: sub-pixel scroll jitters (and
  // Learn's live hint refreshes shifting layout) would instantly stomp the
  // chip the user just clicked with the section ABOVE it.
  let spyPausedUntil = 0;
  anchors.forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (collapsible && a.classList.contains('active')) {
        const sec = sectionOf(a.dataset.section);
        if (sec) collapsible.toggle(sec, idOf(sec));
        return;
      }
      jumpTo(a.dataset.section);
    });
  });
  // Keyboard: the chips are one tab stop (roving tabindex); arrows move + jump,
  // Home/End go to the first/last section, Enter follows the active chip.
  const chips = anchors.filter((a) => sectionOf(a.dataset.section));
  const focusChip = (i) => {
    const c = chips[(i + chips.length) % chips.length];
    if (!c) return;
    c.focus({ preventScroll: true });
    jumpTo(c.dataset.section);
  };
  chips.forEach((chip, i) => {
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusChip(i + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusChip(i - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusChip(0); }
      else if (e.key === 'End') { e.preventDefault(); focusChip(chips.length - 1); }
    });
  });
  // ↑ Back to top: absolute top of the view; the spy re-anchors to the first chip.
  const topBtn = el.querySelector(`[data-navtop="${key}"]`);
  if (topBtn) {
    topBtn.addEventListener('click', () => {
      el.scrollTo({ top: 0, behavior: 'auto' });
      const first = chips[0]?.dataset.section;
      if (first) {
        history.replaceState(null, '', `#${key}=${first}`);
        setActive(first);
      }
      spyPausedUntil = Date.now() + 400;
    });
  }
  // ⌕ Section finder: jump straight to a section by name. Chip-less sections
  // (Settings appearance/autoexport) join via extraSearch so they're findable
  // too — the spy re-anchors to the nearest chip after the jump settles.
  const searchBtn = el.querySelector(`[data-navsearch="${key}"]`);
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      openSectionSearch(
        [
          ...chips.map((c) => ({ id: c.dataset.section, label: c.textContent.trim(), kw: keywords[c.dataset.section] || '' })),
          ...extraSearch.map(([id, label]) => ({ id, label, kw: keywords[id] || '' })),
        ],
        (id) => jumpTo(id)
      );
    });
  }
  // Deep link: #<key>=<id> lands (highlighted) on that section; unknown/absent -> default.
  const hashId = (location.hash.match(new RegExp(`[#&]${key}=([A-Za-z0-9_-]+)`)) || [])[1];
  if (hashId && sectionOf(hashId)) {
    expandIfCollapsed(hashId);
    setActive(hashId);
    spyPausedUntil = Date.now() + 400;
    setTimeout(() => scrollContentTo(sectionOf(hashId), offset), 50);
  } else {
    // Also gives views without a defaultId (Learn) their initial tab stop.
    setActive(defaultId || anchors[0].dataset.section);
  }
  // Scroll-spy: only chip-backed sections are tracked; at the very bottom the
  // last chip wins even if its heading never crosses the activation line.
  const spySections = sections.map((s) => ({ node: s, id: idOf(s) }));
  if (!spySections.length) return;
  const progressFill = el.querySelector('.anchor-progress-fill');
  const spy = () => {
    if (state.view !== key) {
      el.__spyCleanups?.[key]?.(); // view changed: this spy is stale, drop it
      return;
    }
    // Progress bar always tracks (even while the chip highlight is paused).
    if (progressFill) {
      const max = el.scrollHeight - el.clientHeight;
      progressFill.style.width = `${max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 100}%`;
    }
    if (Date.now() < spyPausedUntil) return; // settling a chip jump — don't stomp it
    let current = spySections[0].id;
    for (const s of spySections) {
      if (s.node.getBoundingClientRect().top - el.getBoundingClientRect().top <= 140 + offset) current = s.id;
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 2) {
      current = spySections[spySections.length - 1].id;
    }
    setActive(current);
    if (current !== (location.hash.match(new RegExp(`[#&]${key}=([A-Za-z0-9_-]+)`)) || [])[1]) {
      history.replaceState(null, '', `#${key}=${current}`);
    }
  };
  // Re-renders of this view must not stack spies: the previous render's
  // listener watches detached nodes and would keep rewriting the hash.
  el.__spyCleanups = el.__spyCleanups || {};
  el.__spyCleanups[key]?.();
  el.addEventListener('scroll', spy, { passive: true });
  el.__spyCleanups[key] = () => el.removeEventListener('scroll', spy);
  if (progressFill) {
    const max = el.scrollHeight - el.clientHeight;
    progressFill.style.width = `${max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 100}%`;
  }
  // Let callers (Learn prev/next) reuse the exact jump semantics.
  return { jumpTo };
}

// ---------------------------------------------------------------------------

function renderSettings(el) {
  // Chip badge: the backup reminder's own "due" rule, surfaced as a dot.
  const r = state.backupReminder || { every: 0, count: 0, remindedAt: 0 };
  const backupDue = r.every > 0 && r.count > 0 && r.count - r.remindedAt >= r.every;
  el.innerHTML = `
    <div class="studio">
      <div class="studio-head acc-head-row">
        <div>
          <p class="kicker">SETTINGS</p>
          <h1>Account & engine</h1>
          <p class="hero-sub">Manage your account and family libraries, choose what makes your music, and control the on-device learning model.</p>
        </div>
        ${accountSummaryHtml()}
      </div>
      ${anchorNavHtml('settings', [
        ['account', 'Account'],
        ['engine', 'Engine'],
        ['backups', 'Backups', backupDue ? { title: 'Backup reminder due' } : null],
        ['ai-servers', 'AI servers'],
        ['taste', 'AI taste'],
      ])}
      <div class="studio-panel">
        <div class="field ai-panel" id="settings-account"></div>

        <hr class="settings-hr" />

        <div class="field ai-panel" id="settings-engine">
          <div class="ai-head"><button type="button" class="collapse-chevron" data-collapse="settings-engine" title="Collapse or expand this section">▾</button><span>On-device engine</span><small>default — pure-JS DSP, fully offline</small>${copyLinkHtml('settings=engine')}</div>
          <p class="settings-note">Songs are composed and mixed in the browser with deterministic, sample-by-sample synthesis. Everything stays on this device — no server, no network.</p>
        </div>

        <div class="field ai-panel" id="settings-appearance">
          <div class="ai-head"><button type="button" class="collapse-chevron" data-collapse="settings-appearance" title="Collapse or expand this section">▾</button><span>Appearance</span><small>dark or light studio</small>${copyLinkHtml('settings=appearance')}</div>
          <label class="ai-toggle"><input type="checkbox" id="themeToggle" ${state.theme === 'light' ? 'checked' : ''} /><span>Light appearance</span></label>
          <p class="settings-note">Flip the studio between the dark and light look. Your choice is saved on this device.</p>
        </div>

        <div class="field ai-panel" id="settings-autoexport">
          <div class="ai-head"><button type="button" class="collapse-chevron" data-collapse="settings-autoexport" title="Collapse or expand this section">▾</button><span>Auto-export</span><small>save new songs to your Workspace folder</small>${copyLinkHtml('settings=autoexport')}</div>
          <label class="ai-toggle"><input type="checkbox" id="autoExportToggle" ${state.autoExport ? 'checked' : ''} /><span>Auto-export new songs</span></label>
          <p class="settings-note">Every song you create — or save from Explore, Remix, or a share link — is also written to your Workspace folder as <code>.wav</code> + <code>.json</code>, without asking again. Choose the folder once; if your browser restarts you may need to re-select it.</p>
          <div class="settings-row">
            <span class="settings-status" id="autoExportStatus"></span>
            <button class="ghost" id="autoExportFolder">Choose folder</button>
          </div>
        </div>

        <div class="field ai-panel" id="settings-backups">
          <div class="ai-head"><button type="button" class="collapse-chevron" data-collapse="settings-backups" title="Collapse or expand this section">▾</button><span>Backups</span><small>choose what a library backup contains</small>${copyLinkHtml('settings=backups')}</div>
          <label class="ai-toggle"><input type="checkbox" id="metaOnlyToggle" ${state.metaOnlyBackup ? 'checked' : ''} /><span>Metadata-only backups</span></label>
          <p class="settings-note">When on, a backup skips embedded audio — a tiny archive carrying each song's prompt, style, seed, lyrics and edits. Restoring re-renders every song exactly from its seed on first play. When off, backups embed the full WAV of every song (large, but restorable even if the engine ever changes).</p>
          <label class="field-inline">Remind me to back up after <small>0 turns the reminder off</small>
            <input type="number" id="backupReminderEvery" min="0" max="100" step="1" value="${(state.backupReminder && state.backupReminder.every) || 0}" style="width:5.5em" />
            new songs
          </label>
          <p class="settings-status" id="backupReminderStatus"></p>
        </div>

        <div class="field ai-panel" id="settings-ai-servers">
          <div class="ai-head"><button type="button" class="collapse-chevron" data-collapse="settings-ai-servers" title="Collapse or expand this section">▾</button><span>Local AI servers</span><small>open-source neural generation — MusicGen or ACE-Step</small>${copyLinkHtml('settings=ai-servers')}</div>
          <p class="settings-note">Run a real neural music model on your own machine and this app becomes its studio. Two open engines are supported, both fully local:</p>
          <div class="settings-row">
            <select id="remoteEngine" class="url-input">
              <option value="musicgen"${state.remoteEngine !== 'acestep' ? ' selected' : ''}>MusicGen (bundled wrapper — port 7860)</option>
              <option value="acestep"${state.remoteEngine === 'acestep' ? ' selected' : ''}>ACE-Step 1.5 (SOTA open model — port 8001)</option>
            </select>
          </div>
          <p class="settings-note" id="remoteEngineHint"></p>
          <label class="ai-toggle"><input type="checkbox" id="remoteToggle" ${state.remoteEnabled ? 'checked' : ''} /><span>Use the local server instead of the on-device engine</span></label>
          <div class="settings-row">
            <input id="remoteUrl" type="url" value="${escapeHtml(state.remoteUrl)}" class="url-input" spellcheck="false" />
            <button class="ghost" id="remoteTest">Test connection</button>
          </div>
          <p class="settings-status" id="remoteStatus"></p>
        </div>

        <hr class="settings-hr" />
        <div class="field ai-panel" id="settings-taste">
          <div class="ai-head"><button type="button" class="collapse-chevron" data-collapse="settings-taste" title="Collapse or expand this section">▾</button><span>AI taste engine</span><small>on-device learning model</small>${copyLinkHtml('settings=taste')}</div>
          <p class="settings-note" id="aiSummary"></p>
          <button class="mini-btn" id="settingsAiReset">Reset AI taste model</button>
        </div>
      </div>
    </div>
  `;

  // Account section (sign-in, profile, family members) lives in its own module.
  renderAccountSection($('settings-account'), {
    toast,
    repaint: () => renderView(),
    openVoiceRecorder,
  });

  // Collapsible panels: chevron in each head; the active chip toggles too.
  const collapsed = loadCollapsedSet('settings');
  el.querySelectorAll('.field.ai-panel[id]').forEach((sec) => {
    const id = sec.id.replace(/^settings-/, '');
    if (collapsed.has(id)) sec.classList.add('is-collapsed');
  });
  const collapsible = {
    isCollapsed: (sec) => sec.classList.contains('is-collapsed'),
    toggle: (sec, id) => {
      const on = sec.classList.toggle('is-collapsed');
      on ? collapsed.add(id) : collapsed.delete(id);
      saveCollapsedSet('settings', collapsed);
      const chev = sec.querySelector('.collapse-chevron');
      if (chev) chev.textContent = on ? '▸' : '▾';
    },
    expand: (sec, id) => {
      sec.classList.remove('is-collapsed');
      collapsed.delete(id);
      saveCollapsedSet('settings', collapsed);
      const chev = sec.querySelector('.collapse-chevron');
      if (chev) chev.textContent = '▾';
    },
  };
  // Anchor nav + hash deep links + scroll-spy, shared with Learn/Workspace.
  wireAnchorNav(el, 'settings', {
    defaultId: 'account',
    collapsible,
    keywords: {
      account: 'name email avatar voice family members sign out passcode lock',
      engine: 'on-device offline synthesis local javascript dsp',
      backups: 'backup restore reminder metadata audio json',
      'ai-servers': 'musicgen ace-step remote server url local',
      taste: 'profile affinity likes training ai learn',
      appearance: 'theme dark light mode color',
      autoexport: 'folder wav json new songs workspace',
    },
    extraSearch: [
      ['appearance', 'Appearance'],
      ['autoexport', 'Auto-export'],
    ],
  });
  // Chevron buttons toggle their section; state persists via the same set.
  el.querySelectorAll('[data-collapse]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = document.getElementById(btn.dataset.collapse);
      if (sec) collapsible.toggle(sec, btn.dataset.collapse.replace(/^settings-/, ''));
    });
  });
  wireCopyLinks(el);

  $('themeToggle').addEventListener('change', () => {
    state.theme = $('themeToggle').checked ? 'light' : 'dark';
    applyTheme();
    saveSettings();
    toast(state.theme === 'light' ? 'Light appearance on.' : 'Dark appearance on.');
  });

  $('metaOnlyToggle').addEventListener('change', () => {
    state.metaOnlyBackup = $('metaOnlyToggle').checked;
    saveSettings();
    toast(state.metaOnlyBackup
      ? 'Metadata-only backups on — backups will be small; audio re-renders from seeds on restore.'
      : 'Full backups on — backups will embed every song\'s audio.');
  });

  // Auto-backup reminder cadence (0 = off). Changes apply immediately.
  const reminderInput = $('backupReminderEvery');
  const reminderStatus = $('backupReminderStatus');
  const refreshReminderStatus = () => {
    const r = state.backupReminder || { every: 0, count: 0 };
    reminderStatus.textContent = r.every > 0
      ? `${r.count} new song${r.count === 1 ? '' : 's'} since the last backup — reminding every ${r.every}.`
      : 'Backup reminder is off.';
  };
  reminderInput.addEventListener('change', () => {
    const every = Math.max(0, Math.min(100, Math.round(Number(reminderInput.value) || 0)));
    reminderInput.value = every;
    state.backupReminder = state.backupReminder || { count: 0, remindedAt: 0 };
    state.backupReminder.every = every;
    saveSettings();
    refreshReminderStatus();
    refreshBackupBanner();
    toast(every > 0 ? `Backup reminder set — a banner appears after every ${every} new songs.` : 'Backup reminder off.');
  });
  refreshReminderStatus();

  const autoExportToggle = $('autoExportToggle');
  const autoExportStatus = $('autoExportStatus');
  const autoExportFolderBtn = $('autoExportFolder');
  const refreshAutoExport = async () => {
    const { handle, perm } = await workspaceFolderStatus();
    if (!state.autoExport) {
      autoExportStatus.textContent = handle ? `Folder: “${handle.name}” (auto-export off)` : 'No folder chosen.';
      return;
    }
    autoExportStatus.textContent =
      perm === 'granted' ? `Ready — new songs go to “${handle.name}”.` : `Folder “${handle.name}” needs re-selecting (browser restarted).`;
  };
  autoExportToggle.onchange = async () => {
    state.autoExport = autoExportToggle.checked;
    saveSettings();
    if (state.autoExport) {
      const { handle, perm } = await workspaceFolderStatus();
      if (!handle || perm !== 'granted') {
        const picked = await pickWorkspaceFolder();
        if (!picked) {
          state.autoExport = false;
          saveSettings();
          autoExportToggle.checked = false;
          refreshAutoExport();
          return;
        }
      }
      toast('Auto-export on — new songs will be written to your Workspace folder.');
    } else {
      toast('Auto-export off.');
    }
    refreshAutoExport();
  };
  autoExportFolderBtn.addEventListener('click', async () => {
    const picked = await pickWorkspaceFolder();
    if (picked) toast(`Workspace folder set to “${picked.name}”.`);
    refreshAutoExport();
  });
  refreshAutoExport();

  const toggle = $('remoteToggle');
  const url = $('remoteUrl');
  const testBtn = $('remoteTest');
  const status = $('remoteStatus');
  const engineSel = $('remoteEngine');
  const engineHint = $('remoteEngineHint');

  const ENGINE_HINTS = {
    musicgen: 'The bundled wrapper: <code>pip install -r server/requirements.txt && python server/musicgen_server.py</code> — Meta\'s MusicGen on port <b>7860</b>. Good on CPU, better with CUDA.',
    acestep: 'ACE-Step 1.5 — open-source commercial-grade music generation (DiT + planner LM): clone <code>github.com/ace-step/ACE-Step-1.5</code>, run <code>uv run acestep-api</code> — it serves on port <b>8001</b>. Needs a GPU (≥6 GB VRAM); ~2–10 s per song.',
  };
  const refreshEngineHint = () => {
    engineHint.innerHTML = ENGINE_HINTS[state.remoteEngine] || '';
  };
  refreshEngineHint();

  engineSel.addEventListener('change', () => {
    state.remoteEngine = engineSel.value;
    state.remoteUrl = engineSel.value === 'acestep' ? DEFAULT_ACESTEP_URL : DEFAULT_URL;
    url.value = state.remoteUrl;
    saveSettings();
    refreshEngineHint();
    toast(`Engine set to ${engineSel.value === 'acestep' ? 'ACE-Step 1.5' : 'MusicGen'} — make sure it\'s running, then test the connection.`);
  });

  const refreshStatus = () => {
    const rec = aiRecommend();
    $('aiSummary').textContent = rec
      ? `Learned from ${rec.count} interactions — currently suggests ${rec.topStyle.label} (${aiSteerBits(rec).join(', ')}). Liking, playing, and skipping songs keeps refining it.`
      : aiSampleCount()
      ? `Learning from ${aiSampleCount()} interactions…`
      : 'No feedback yet — like, play, and skip songs to teach it what you love.';
  };
  refreshStatus();

  toggle.onchange = () => {
    state.remoteEnabled = toggle.checked;
    saveSettings();
    if (toggle.checked) {
      status.textContent = 'Enabled — new songs will come from the local server. Trying a health check…';
      runTest();
    } else {
      status.textContent = 'Disabled — using the on-device engine.';
    }
    toast(state.remoteEnabled ? `Local ${state.remoteEngine === 'acestep' ? 'ACE-Step 1.5' : 'MusicGen'} server enabled` : 'Back to the on-device engine');
  };

  url.addEventListener('change', () => {
    state.remoteUrl = url.value.trim() || (state.remoteEngine === 'acestep' ? DEFAULT_ACESTEP_URL : DEFAULT_URL);
    saveSettings();
  });

  async function runTest() {
    status.textContent = 'Pinging…';
    testBtn.disabled = true;
    state.checkingServer = true;
    try {
      const info = await checkServer(state.remoteUrl, state.remoteEngine);
      status.textContent = `Connected: ${info.model} at ${info.url}.`;
      toast(`${state.remoteEngine === 'acestep' ? 'ACE-Step 1.5' : 'MusicGen'} server reachable ✓`);
    } catch (err) {
      status.textContent = `Connection failed: ${err.message}.`;
      toast(remoteProblem(err, state.remoteUrl), 'error');
      state.remoteEnabled = false;
      saveSettings();
      toggle.checked = false;
    } finally {
      testBtn.disabled = false;
      state.checkingServer = false;
    }
  }
  testBtn.addEventListener('click', () => runTest());

  $('settingsAiReset').addEventListener('click', () => {
    if (!confirm('Reset the AI taste model? It will forget everything it has learned.')) return;
    aiReset();
    refreshStatus();
    toast('AI taste model reset.');
  });
}

async function buildExplore() {
  const style = styleById(state.exploreGenre);
  const cards = [];
  for (let i = 0; i < 6; i++) {
    const seed = hashSeed(`explore:${style.id}:${i}`);
    const title = suggestTitles(`${style.label} ${['night drive', 'golden hour', 'city lights', 'open road', 'deep space', 'summer rain'][i]}`, seed)[0];
    cards.push({
      id: `disc-${seed}`,
      title,
      prompt: `a ${style.label.toLowerCase()} track, discovery ${i}`,
      styleId: style.id,
      styleLabel: style.label,
      lyrics: '',
      duration: 0,
      seed,
      createdAt: 0,
      plays: 0,
      liked: false,
      discovery: true,
    });
  }
  state.exploreCache = cards;
}

// The curated scene categories, in the order they first appear in STYLES.
function curatedCategories() {
  const seen = [];
  STYLES.forEach((s) => { if (s.category && !seen.includes(s.category)) seen.push(s.category); });
  return seen;
}

// The single most-loved scene per curated category (id set), for starring them
// in Explore. Uses the same scoring as the Profile/Create views.
function categoryFavourites(aff) {
  const fav = new Map(); // category -> { id, score }
  STYLES.forEach((s) => {
    if (!s.category) return;
    const sc = aff.get(s.id) ?? 0.5;
    const cur = fav.get(s.category);
    if (!cur || sc > cur.score) fav.set(s.category, { id: s.id, score: sc });
  });
  return new Set([...fav.values()].map((f) => f.id));
}

function renderExplore(el) {
  // If the last-selected genre doesn't belong to the active category (e.g. we
  // jumped here from a Profile suggestion), fall back to showing all genres
  // rather than rendering a filtered row that hides the chosen one.
  let activeCat = state.exploreCat || 'all';
  if (activeCat !== 'all' && !STYLES.some((s) => s.category === activeCat && s.id === state.exploreGenre)) {
    activeCat = 'all';
    state.exploreCat = 'all';
    saveSettings();
  }
  const pool = activeCat === 'all' ? STYLES : STYLES.filter((s) => s.category === activeCat);
  const style = styleById(state.exploreGenre);
  const cards = state.exploreCache.filter((c) => c.styleId === state.exploreGenre);
  const cats = curatedCategories();

  // Once the AI has enough feedback, surface predicted affinity on every chip
  // and star the most-loved scene within each curated category.
  const aff = sceneAffinityMap();
  const trained = aiSampleCount() >= 6;
  const faves = trained ? categoryFavourites(aff) : new Set();
  const chipHtml = (s) => {
    const pct = trained ? ` <span class="aff-pct-chip">${Math.round((aff.get(s.id) ?? 0.5) * 100)}%</span>` : '';
    const star = faves.has(s.id) ? ' <span class="aff-star" title="AI favourite in this category">★</span>' : '';
    return `<button class="chip${s.id === state.exploreGenre ? ' on' : ''}" data-style="${s.id}">${escapeHtml(s.label)}${pct}${star}</button>`;
  };
  el.innerHTML = `
    <div class="view-head">
      <div>
        <p class="kicker">EXPLORE</p>
        <h1>Discover sounds</h1>
        <p class="hero-sub">Sample tracks generated on the fly for each style. Play one, then save it with ＋.</p>
      </div>
    </div>
    <nav class="cat-tabs">
      <button class="sub-tab${activeCat === 'all' ? ' on' : ''}" data-cat="all">All genres</button>
      ${cats.map((c) => `<button class="sub-tab${activeCat === c ? ' on' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
    </nav>
    ${trained ? affLegendHtml() : ''}
    <div class="chip-row explore-chips">
      ${pool.map(chipHtml).join('')}
    </div>
    <div class="card-grid" id="exploreGrid">${cards.map((c) => cardHtml(c, { discovery: true })).join('')}</div>
  `;

  document.querySelectorAll('.cat-tabs .sub-tab').forEach((t) => {
    t.addEventListener('click', async () => {
      // remember the scene we're leaving, under its own category, so it comes back
      const prevCat = state.exploreCat || 'all';
      if (prevCat !== 'all' && state.exploreGenre) state.exploreGenreByCat[prevCat] = state.exploreGenre;

      state.exploreCat = t.dataset.cat;
      saveSettings();
      // 'all' has no deep link — swap the hash namespace out entirely. Category
      // names contain spaces/&: encode, so the read side can decode reliably.
      history.replaceState(null, '', t.dataset.cat === 'all' ? '#' : `#explore=${encodeURIComponent(t.dataset.cat)}`);
      if (state.exploreCat !== 'all') {
        const inner = STYLES.filter((s) => s.category === state.exploreCat);
        // restore this category's remembered scene if it still exists, else keep a
        // matching pick, else default to its first scene
        const remembered = state.exploreGenreByCat[state.exploreCat];
        const target =
          remembered && inner.some((s) => s.id === remembered)
            ? remembered
            : inner.some((s) => s.id === state.exploreGenre)
            ? state.exploreGenre
            : inner.length
            ? inner[0].id
            : 'dance';
        if (state.exploreGenre !== target) {
          state.exploreGenre = target;
          saveSettings();
          if (!state.exploreCache.some((x) => x.styleId === state.exploreGenre)) await buildExplore();
        }
      }
      renderExplore(el);
    });
  });

  document.querySelectorAll('.explore-chips .chip').forEach((c) => {
    c.addEventListener('click', async () => {
      state.exploreGenre = c.dataset.style;
      const activeCat = state.exploreCat || 'all';
      if (activeCat !== 'all') state.exploreGenreByCat[activeCat] = state.exploreGenre;
      saveSettings();
      if (!state.exploreCache.some((x) => x.styleId === state.exploreGenre)) await buildExplore();
      renderExplore(el);
    });
  });
  document.querySelectorAll('#exploreGrid .song-card').forEach((card) => {
    const song = state.exploreCache.find((s) => s.id === card.dataset.id);
    if (song) bindCard(card, song);
  });

  // Watch the AI learn in place: periodically refresh chip percentages/stars
  // without re-rendering (which would rebuild the discovery cards/audio). The
  // timer clears itself the moment the user leaves Explore, like Profile's.
  clearInterval(exploreTimer);
  exploreTimer = setInterval(() => {
    if (state.view !== 'explore') {
      clearInterval(exploreTimer);
      return;
    }
    refreshExploreChips();
  }, PROFILE_REFRESH);
}

function refreshExploreChips() {
  const aff = sceneAffinityMap();
  const trained = aiSampleCount() >= 6;
  const faves = trained ? categoryFavourites(aff) : new Set();

  // Keep the legend in sync with the trained state (appears only once the model
  // has enough signals to show meaningful percentages).
  const legend = document.querySelector('.aff-legend');
  if (trained && !legend) {
    document.querySelector('.explore-chips')?.insertAdjacentHTML('beforebegin', affLegendHtml());
  } else if (!trained && legend) {
    legend.remove();
  }

  document.querySelectorAll('.explore-chips .chip[data-style]').forEach((chip) => {
    const id = chip.dataset.style;
    // drop stale spans, keep the label text node
    chip.querySelectorAll('.aff-pct-chip, .aff-star').forEach((s) => s.remove());
    if (trained) {
      const pct = Math.round((aff.get(id) ?? 0.5) * 100);
      chip.insertAdjacentHTML('beforeend', ` <span class="aff-pct-chip">${pct}%</span>`);
      if (faves.has(id)) chip.insertAdjacentHTML('beforeend', ' <span class="aff-star" title="AI favourite in this category">★</span>');
    }
  });
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

// True when the user's prompt already names a mood (dark/bright/chill/epic) —
// the AI then leaves mood alone instead of overriding an explicit choice.
function promptHasMood(prompt) {
  const p = (prompt || '').toLowerCase();
  return Object.values(MOOD_WORDS).some((words) => words.some((w) => p.includes(w)));
}

// The single funnel for all production: route to the local MusicGen server when
// it's enabled (falling back to the on-device engine on any failure), otherwise
// use the pure-JS engine.
//
// Steering: when a song is being regenerated from its stored seed (share
// opens, remix replays, cached-audio misses) we pass its `steer` so the exact
// same AI biases used at creation are reproduced — keeping regeneration
// byte-identical. Otherwise the biases come from the live taste model. The
// chosen biases are returned on `result.steering` so they can be stored on the
// song (and later share link) to make that reproduction exact.
async function generateSong({ title, prompt, styles = [], lyrics = '', seedOverride, steer = null, lengthSec = 30, styleRefId = null, voice = null }) {
  const ai = steer != null ? steer : state.aiEnabled !== false ? aiRecommend() : null;
  const bpmBias = (ai && ai.bpmBias) || 0;
  const densityBias = (ai && ai.densityBias) || 0;
  // The Create form's voice picker wins over the taste engine's default:
  // 'female'/'male' shape the synthesized voice, 'mine' sings with the member's
  // recording, 'off' forces instrumental.
  let vocals = (ai && ai.vocals) || null;
  if (voice === 'off' || voice === 'female' || voice === 'male' || voice === 'mine') vocals = voice;
  // 'mine' only works when this member has a usable recorded voice; otherwise
  // fall back to the taste engine's/synth default instead of silently muting.
  let voiceSample = null;
  if (vocals === 'mine') {
    voiceSample = getVoiceSample();
    if (!voiceSample) {
      vocals = null;
      toast('No recorded voice on this account yet — using the style default. Use 🎙 Record voice to add one.');
    }
  }
  const mood = steer != null ? (ai && ai.mood) || null : ai && !promptHasMood(prompt) ? (ai.mood || null) : null;
  // Remote AI engines can't adopt the member's recording — 'mine' maps to a
  // plain vocal request there. The local engine gets the real sample.
  const steering = { bpmBias, densityBias, mood, vocals: vocals === 'female' || vocals === 'male' || vocals === 'mine' ? 'on' : vocals };

  // Sound-fingerprint hints (genreAI technique): if your liked music is
  // brighter/denser than average, the engine whispers that into the prompt.
  const soundHints = steer == null && ai && ai.soundHints ? ai.soundHints : null;
  const effPrompt = soundHints ? `${prompt}, ${soundHints}` : prompt;

  const seed = seedOverride != null ? seedOverride : hashSeed(`${title}|${effPrompt}|${styles.join(',')}|${lyrics}|${bpmBias}|${densityBias}|${mood}|${vocals}|${lengthSec}|${voiceSample ? `vm${voiceSample.f0},${voiceSample.bright},${voiceSample.breathy}` : ''}`);
  if (state.remoteEnabled) {
    try {
      const style = styleById(styles[0] || 'pop');
      const estBpm = Math.round((style.bpm || 120) + bpmBias * 20);
      // Structured prompt (genre framing + your words + instruments/production
      // + tempo/mood) — the knowledge layer makes both engines far more literal
      // about what you asked for than a bare phrase would.
      const remotePrompt = expandPrompt({ prompt: effPrompt, style, bpm: estBpm, mood, vocals });
      let blob;
      let reportedBpm = null;
      if (state.remoteEngine === 'acestep') {
        // Optional style transfer: upload a library song's audio as the
        // reference. If its audio is gone (metadata-only import), it is
        // re-rendered from the seed first — silently skipping on failure.
        let refBlob = null;
        const refId = styleRefId || state.styleRef || '';
        const refSong = refId ? findSong(refId) : null;
        if (refSong) {
          try {
            refBlob = await ensureAudio(refSong);
          } catch (err) {
            console.warn('Style reference unavailable — generating without it:', err);
          }
        }
        blob = await generateAceStep(remotePrompt, {
          url: state.remoteUrl,
          duration: Math.max(10, Math.min(lengthSec, 600)),
          seed,
          lyrics,
          bpm: estBpm,
          referenceBlob: refBlob,
          coverStrength: state.styleRefStrength || 0.5,
        });
        reportedBpm = blob.acestepMeta && Number(blob.acestepMeta.bpm) ? Number(blob.acestepMeta.bpm) : null;
      } else {
        blob = await generateRemote(remotePrompt, { url: state.remoteUrl, duration: Math.min(lengthSec, 32), seed });
      }
      const duration = (await wavDuration(blob)) || lengthSec;
      return {
        blob,
        duration,
        seed,
        styleId: style.id,
        styleLabel: style.label,
        bpm: reportedBpm, // ACE-Step reports the tempo its LM planned; MusicGen can't
        mood: null,
        hasVocals: !!(style.vocal || style.choir),
        steering,
      };
    } catch (err) {
      state.remoteEnabled = false;
      saveSettings();
      toast(`${remoteProblem(err, state.remoteUrl)} Using the on-device engine instead.`, 'error');
      // fall through to the local engine
    }
  }
  const result = await generateTrack({ title, prompt: effPrompt, styles, lyrics, seedOverride: seed, bpmBias, densityBias, mood, vocals, durationSec: lengthSec, voiceSig: familyVoiceSig(), voiceSample: vocals === 'mine' ? voiceSample : null });
  result.steering = steering;
  return result;
}

const blobCache = new WeakMap();

function ensureAudio(song) {
  if (!blobCache.has(song)) {
    blobCache.set(
      song,
      (async () => {
        const rec = await idbGet('audio', song.id);
        if (rec) return rec.blob;
        // SFX songs re-render deterministically from their stored params —
        // no seed needed, same (type, seed) always gives the same effect.
        if (song.source === 'sfx' && song.sfxType) {
          const { blob } = generateSfxWav({ type: song.sfxType, seed: song.sfxSeed });
          return blob;
        }
        if (!song.seed) {
          // Imported audio has no seed to re-render from — without stored
          // bytes there is nothing we can do.
          throw new Error('This imported song has no stored audio.');
        }
        const out = await generateSong({
          title: song.title,
          prompt: song.prompt,
          styles: [song.styleId],
          lyrics: song.lyrics,
          seedOverride: song.seed,
          steer: song.steer,
          voice: song.voice || null,
          lengthSec: song.lengthSec || 30,
        });
        const { blob, duration, bpm, hasVocals, midiNotes } = out;
        if (midiNotes) song.midiNotes = midiNotes; // cached for the MIDI exporter
        // A song edited with trim & fade no longer matches its seed — when the
        // stored audio is gone (e.g. a metadata-only import), re-apply the
        // recorded edit on top of the fresh render so the length and audio
        // stay exactly what the user saved.
        let finalBlob = blob;
        let finalDuration = duration;
        if (song.edit) {
          try {
            const edited = await renderEditedAudioFromBlob(blob, song.edit);
            finalBlob = edited.blob;
            finalDuration = edited.duration;
          } catch (err) {
            console.warn('Could not re-apply saved edit — using the full render:', err);
            song.edit = null; // don't retry a broken edit on every play
            song.edited = false;
          }
        }
        song.duration = finalDuration;
        song.bpm = bpm;
        song.hasVocals = !!hasVocals;
        song.steer = out.steering; // capture the biases used, so replays stay exact
        await idbPut('audio', { id: song.id, blob: finalBlob });
        if (!song.discovery) await idbPut('songs', song);
        return finalBlob;
      })()
    );
  }
  return blobCache.get(song);
}

async function playSong(id, { autoplay = true } = {}) {
  // AI feedback for whatever was playing before this
  const now = Date.now();
  if (state.aiPlayId && state.aiPlayId !== id) {
    const prev = findSong(state.aiPlayId);
    const elapsed = (now - state.aiPlayStart) / 1000;
    if (prev && !prev.liked) {
      if (elapsed >= 20) aiRecord(prev, 1, 1); // listened most of the way through
      else if (elapsed >= 2) aiRecord(prev, 0, 1); // skipped early
    }
  }
  state.aiPlayId = id;
  state.aiPlayStart = now;
  const song = findSong(id);
  if (!song) return;
  const blob = await ensureAudio(song);
  // Compute the audio fingerprint in the background (once per song) — the
  // taste engine uses it to learn from the actual sound, not just the label.
  // A failed decode sets a sentinel so we don't re-decode on every play.
  if (!song.audioFeatures && !song.featuresFailed) {
    extractAudioFeatures(blob)
      .then((f) => {
        if (f) {
          song.audioFeatures = f;
        } else {
          song.featuresFailed = true;
        }
        if (song.createdAt) idbPut('songs', song);
      })
      .catch(() => {});
  }
  if (state.currentObjectUrl) URL.revokeObjectURL(state.currentObjectUrl);
  const url = URL.createObjectURL(blob);
  state.currentObjectUrl = url;
  state.currentSongId = id;
  song.plays = (song.plays || 0) + 1;
  if (song.createdAt) idbPut('songs', song); // persist play count for saved songs
  renderNowPlaying();
  renderCards();
  await player.load(url, autoplay);
}

// Re-render the same prompt with a brand-new seed and save it as a variation
// next to the original — then set the play order to [original, variation] so
// the next/prev keys toggle straight between the two takes (A/B).
async function duplicateAsVariation(song) {
  if (!song || state.creating) return;
  // Sound effects DO branch: a variation is the same effect type with a new
  // seed — instant, deterministic, and fun to collect.
  if (song.source === 'sfx' && song.sfxType) {
    const sfxSeed = Math.floor(Math.random() * 2 ** 31);
    const { blob, duration } = generateSfxWav({ type: song.sfxType, seed: sfxSeed });
    const copy = {
      id: uid(),
      title: song.title,
      prompt: song.prompt,
      styleId: song.styleId,
      styleLabel: song.styleLabel,
      lyrics: '',
      duration,
      bpm: null,
      seed: null,
      source: 'sfx',
      sfxType: song.sfxType,
      sfxSeed,
      lengthSec: Math.ceil(duration),
      createdAt: Date.now(),
      plays: 0,
      liked: false,
      variationOf: song.id,
    };
    await idbPut('audio', { id: copy.id, blob });
    await idbPut('songs', copy);
    state.songs.unshift(copy);
    state.justCreated = [copy, ...(state.justCreated || [])].slice(0, 6);
    state.varExpanded = state.varExpanded || {};
    state.varExpanded[song.id] = true;
    noteNewSongForBackup();
    autoExportSongs([copy]);
    renderView();
    toast(`New take of the ${song.sfxType} effect — press play to hear it.`);
    return;
  }
  if (song.source === 'upload' || !song.seed) {
    toast('Variations re-render from a seed — imported audio can\'t branch. Use ✂ / ⤢ in the editor instead.');
    return;
  }
  state.creating = true;
  toast('Rendering a variation…');
  try {
    const variationSeed = hashSeed(`${song.seed}|variation:${Date.now()}`);
    const result = await generateSong({
      title: song.title,
      prompt: song.prompt,
      styles: [song.styleId],
      lyrics: song.lyrics || '',
      seedOverride: variationSeed,
      steer: song.steer,
      lengthSec: song.lengthSec || 30,
    });
    const made = {
      id: uid(),
      title: song.title,
      prompt: song.prompt,
      styleId: result.styleId,
      styleLabel: result.styleLabel,
      lyrics: song.lyrics || '',
      duration: result.duration,
      bpm: result.bpm,
      seed: result.seed,
      hasVocals: !!result.hasVocals,
      steer: result.steering,
      midiNotes: result.midiNotes || undefined,
      lengthSec: song.lengthSec || 30,
      createdAt: Date.now(),
      plays: 0,
      liked: false,
      variationOf: song.id, // links the A/B pair
    };
    await idbPut('audio', { id: made.id, blob: result.blob });
    await idbPut('songs', made);
    state.songs.push(made);
    state.justCreated = [made, ...(state.justCreated || [])].slice(0, 6);
    noteNewSongForBackup();
    autoExportSongs([made]); // fire-and-forget; failures toast
    // The new take appears inside the original's (now expanded) family stack.
    state.varExpanded = state.varExpanded || {};
    state.varExpanded[song.id] = true;
    renderView();
    // A/B loop: play the new take, and next/prev toggles back to the original.
    state.order = [song.id, made.id];
    playSong(made.id);
    toast(`Variation created — a new take of “${song.title}”. Press next/prev to A/B it against the original.`);
  } catch (err) {
    console.error(err);
    toast('Variation failed: ' + err.message);
  } finally {
    state.creating = false;
  }
}

function renderCards() {
  // re-render visible cards so playing state + heart + plays update
  const grids = document.querySelectorAll('.card-grid');
  grids.forEach((grid) => {
    const cards = [...grid.querySelectorAll('.song-card')];
    cards.forEach((card) => {
      const song = findSong(card.dataset.id);
      if (!song) return;
      card.classList.toggle('playing', song.id === state.currentSongId && !player.paused);
      const heart = card.querySelector('.heart');
      if (heart) {
        heart.textContent = song.liked ? '♥' : '♡';
        heart.classList.toggle('liked', !!song.liked);
      }
      const plays = card.querySelector('.plays');
      if (plays) plays.textContent = `▶ ${song.plays || 0}`;
      const sub = card.querySelector('.card-sub');
      if (sub && song.duration) {
        sub.textContent = cardSubLabel(song);
      }
      card.querySelectorAll('.eq-big').forEach((e) => e.remove());
      if (card.classList.contains('playing')) {
        card.querySelector('.cover').insertAdjacentHTML('beforeend', '<i class="eq-big"><b></b><b></b><b></b><b></b></i>');
      }
    });
  });
  renderLibraryCounts();
}

function renderLibraryCounts() {
  // no-op guard: counts are re-rendered by full view renders
}

function pickShuffled(order, currentId) {
  // Random pick that never repeats the current song (when there's a choice).
  if (order.length <= 1) return order[0];
  const pool = order.filter((id) => id !== currentId);
  const from = pool.length ? pool : order;
  return from[Math.floor(Math.random() * from.length)];
}

function nextTrack() {
  const order = state.order.length ? state.order : visibleOrder();
  if (!order.length) return;
  if (state.shuffle) {
    playSong(pickShuffled(order, state.currentSongId));
    return;
  }
  const idx = order.indexOf(state.currentSongId);
  const next = order[(idx + 1) % order.length];
  playSong(next);
}

function prevTrack() {
  if (player.audio.currentTime > 3) {
    player.seek(0);
    clearResumePosition(); // deliberate restart — don't restore the old spot
    return;
  }
  const order = state.order.length ? state.order : visibleOrder();
  if (!order.length) return;
  const idx = order.indexOf(state.currentSongId);
  playSong(order[(idx - 1 + order.length) % order.length]);
}

function toggleLike(song) {
  song.liked = !song.liked;
  if (song.liked) aiRecord(song, 1, 2); // a like is a strong positive signal
  if (song.createdAt) idbPut('songs', song);
  renderCards();
  renderNowPlaying();
}

async function deleteSong(id) {
  // Soft delete: the song hides from every view but stays recoverable for
  // 30 days from Library → ♻ Recently deleted.
  const song = findSong(id);
  if (!song) return;
  state.songs = state.songs.filter((s) => s.id !== id);
  state.justCreated = (state.justCreated || []).filter((s) => s.id !== id);
  if (state.currentSongId === id) {
    player.pause();
    state.currentSongId = null;
    renderNowPlaying();
  }
  song.deletedAt = Date.now();
  await idbPut('songs', song);
  state.trash = state.trash || [];
  state.trash.unshift(song);
  renderView();
  toast('Moved to Recently deleted — restore it within 30 days.');
}

async function restoreSong(id) {
  const song = (state.trash || []).find((s) => s.id === id);
  if (!song) return;
  delete song.deletedAt;
  await idbPut('songs', song);
  state.trash = state.trash.filter((s) => s.id !== id);
  state.songs.unshift(song);
  renderView();
  toast(`Restored “${song.title}”.`);
}

async function hardDeleteSong(id) {
  const song = (state.trash || []).find((s) => s.id === id);
  if (!song) return;
  if (!confirm(`Permanently delete “${song.title}”? This cannot be undone.`)) return;
  await idbDelete('songs', id);
  await idbDelete('audio', id);
  state.trash = state.trash.filter((s) => s.id !== id);
  renderView();
}

// Songs soft-deleted more than 30 days ago are purged on boot.
async function purgeExpiredTrash() {
  const cutoff = Date.now() - 30 * 864e5;
  const expired = (state.trash || []).filter((s) => s.deletedAt && s.deletedAt < cutoff);
  for (const s of expired) {
    await idbDelete('songs', s.id);
    await idbDelete('audio', s.id);
  }
  if (expired.length) state.trash = state.trash.filter((s) => !(s.deletedAt && s.deletedAt < cutoff));
}

// Render a sound effect as a real library song: deterministic from (type,
// seed), re-renderable without stored audio, downloadable/exportable.
let sfxCounter = 0;
async function makeSfx(type, btn) {
  if (state.creating) return;
  state.creating = true;
  if (btn) btn.disabled = true;
  try {
    const sfxSeed = Math.floor(Math.random() * 2 ** 31);
    const { blob, duration } = generateSfxWav({ type, seed: sfxSeed });
    sfxCounter += 1;
    const song = {
      id: uid(),
      title: `${type.charAt(0).toUpperCase() + type.slice(1)} effect #${sfxCounter}`,
      prompt: `Sound effect — ${type}`,
      styleId: 'pop',
      styleLabel: 'Sound Effect',
      lyrics: '',
      duration,
      bpm: null,
      seed: null,
      source: 'sfx',
      sfxType: type,
      sfxSeed,
      lengthSec: Math.ceil(duration),
      createdAt: Date.now(),
      plays: 0,
      liked: false,
    };
    await idbPut('audio', { id: song.id, blob });
    await idbPut('songs', song);
    state.songs.unshift(song);
    state.justCreated = [song, ...(state.justCreated || [])].slice(0, 6);
    noteNewSongForBackup();
    autoExportSongs([song]);
    // Refresh the “Just created” grid in place — a full re-render would wipe
    // whatever the user has typed into the Create form.
    if (els.createdSection && els.createdGrid && state.view === 'create') {
      els.createdSection.hidden = false;
      els.createdGrid.innerHTML = state.justCreated.map((s) => cardHtml(s)).join('');
      document.querySelectorAll('#createdGrid .song-card').forEach((card) => {
        const song2 = state.songs.find((x) => x.id === card.dataset.id);
        if (song2) bindCard(card, song2);
      });
    } else {
      renderView();
    }
    toast(`${song.title} rendered (${fmtTime(duration)}) — find it in “Just created”.`);
  } catch (err) {
    console.error(err);
    toast('SFX render failed: ' + err.message, 'error');
  } finally {
    state.creating = false;
    if (btn) btn.disabled = false;
  }
}

// Image → Music: sample the picture's palette and translate it into musical
// parameters — hue picks the style family, saturation the energy, brightness
// the mood. Purely local; the image never leaves the device.
async function applyImageToMusic(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) {
    toast('That file isn\'t an image.', 'error');
    return;
  }
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('could not read the image'));
      im.src = url;
    });
    const S = 48;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, S, S);
    URL.revokeObjectURL(url);
    const px = ctx.getImageData(0, 0, S, S).data;
    let sinSum = 0, cosSum = 0, satSum = 0, briSum = 0;
    const hueBuckets = new Set();
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      const sat = max === 0 ? 0 : d / max;
      let h = 0;
      if (d > 0.02) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
        sinSum += Math.sin((h * Math.PI) / 180);
        cosSum += Math.cos((h * Math.PI) / 180);
        hueBuckets.add(Math.floor(h / 30));
      }
      satSum += sat;
      briSum += l;
    }
    const n = px.length / 4;
    let hue = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const sat = satSum / n;
    const bri = briSum / n;
    const variety = hueBuckets.size;

    // Hue → style family.
    let styleId = 'pop';
    let moodWord = 'warm';
    if (sat < 0.12) {
      styleId = bri < 0.35 ? 'ambient' : 'classical';
      moodWord = bri < 0.35 ? 'dark' : 'calm';
    } else if (hue < 20 || hue >= 330) { styleId = 'rock'; moodWord = 'fiery'; }
    else if (hue < 45) { styleId = 'funk'; moodWord = 'sunny'; }
    else if (hue < 70) { styleId = 'house'; moodWord = 'bright'; }
    else if (hue < 160) { styleId = 'lofi'; moodWord = 'chill'; }
    else if (hue < 210) { styleId = 'synthwave'; moodWord = 'dreamy'; }
    else if (hue < 270) { styleId = 'techno'; moodWord = bri < 0.4 ? 'nocturnal' : 'electric'; }
    else { styleId = 'synthpop'; moodWord = 'dreamy'; }
    if (bri < 0.25 && sat >= 0.12) moodWord = 'dark';
    if (variety >= 5) moodWord = 'colorful';
    const style = styleById(styleId);
    const energy = Math.round(sat * 100);
    const words = `${moodWord}, ${energy < 25 ? 'mellow' : energy > 65 ? 'high-energy' : 'steady'} energy, ${variety >= 5 ? 'rich shifting colors' : 'a focused single-tone palette'} — inspired by the picture's palette`;

    // Fill the form in place: prompt suffix + style-chip highlight (no
    // re-render — that would wipe the user's in-progress typing).
    const promptEl = els.createPrompt;
    promptEl.value = promptEl.value.trim()
      ? `${promptEl.value.trim().replace(/[,\s]+$/, '')}, ${words}`
      : `a ${moodWord} track shaped by ${energy < 25 ? 'a muted' : 'a vivid'} image, ${words}`;
    if (!els.createTitle.value.trim()) els.createTitle.value = 'Palette Portrait';
    state.createStyles = [style.id];
    saveSettings();
    renderChips();
    toast(`🎨 Read the image: ${style.label}, ${moodWord} mood, ${energy}% saturation energy — tweak and create.`);
  } catch (err) {
    console.error(err);
    toast('Could not read that image: ' + err.message, 'error');
  }
}

// Import a user's own audio file (WAV/MP3/OGG/…) as a library song. Uploaded
// songs have no seed — they play, edit, export and back up like any other
// song, but variations/seed-renders are unavailable.
async function importAudioFile(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type || '') && !/\.(wav|mp3|ogg|m4a|flac|aac|opus)$/i.test(file.name)) {
    toast('That file doesn\'t look like audio.', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    toast('File is larger than 20 MB — trim it first and try again.', 'error');
    return;
  }
  toast('Importing audio…');
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let duration = 0;
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      duration = buf.duration;
    } finally {
      ctx.close().catch(() => {});
    }
    if (!duration || !isFinite(duration)) throw new Error('could not read the audio length');
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 60) || 'Imported song';
    const song = {
      id: uid(),
      title,
      prompt: `Imported audio — ${file.name}`,
      styleId: 'pop',
      styleLabel: styleById('pop').label,
      lyrics: '',
      duration,
      bpm: null,
      seed: null,
      source: 'upload',
      mime: file.type || 'audio/*',
      lengthSec: Math.round(duration),
      createdAt: Date.now(),
      plays: 0,
      liked: false,
    };
    await idbPut('audio', { id: song.id, blob: file });
    await idbPut('songs', song);
    state.songs.unshift(song);
    state.justCreated = [song, ...(state.justCreated || [])].slice(0, 6);
    noteNewSongForBackup();
    autoExportSongs([song]);
    renderView();
    toast(`Imported “${title}” (${fmtTime(duration)}) — it behaves like any other song.`);
  } catch (err) {
    console.error(err);
    toast('Import failed: ' + err.message, 'error');
  }
}

// Trigger a browser download for a blob under the given filename.
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Filesystem-safe version of a song title, for download filenames.
function safeTitle(title) {
  return (
    String(title)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 80) || 'song'
  );
}

async function downloadSong(song) {
  toast('Preparing download…');
  try {
    const blob = await ensureAudio(song);
    const filename = `${safeTitle(song.title)} - ${song.styleLabel}.wav`;
    downloadBlob(blob, filename);
    aiRecord(song, 1, 1); // downloading = strong signal it was enjoyed
    toast(`Downloading ${filename}`);
  } catch (err) {
    console.error(err);
    toast('Download failed: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Download menu (WAV / MP3 / MP4) + the MP3/MP4 encoders
// ---------------------------------------------------------------------------

// The song the download menu is currently attached to, or null when closed.
let menuSong = null;

function openDownloadMenu(song, e) {
  menuSong = song;
  const menu = els.downloadMenu;
  menu.hidden = false;
  const btn = e.target.closest('.cover-download');
  const r = btn ? btn.getBoundingClientRect() : { left: e.clientX, top: e.clientY };
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
  let y = r.bottom + 6;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function closeDownloadMenu() {
  els.downloadMenu.hidden = true;
  menuSong = null;
}

// Export the song as a multi-track Standard MIDI File (chords, bass, drums,
// lead, vocals). Engine songs carry their note log from the render; older
// songs are re-rendered once from their seed to collect it.
async function downloadMidi(song) {
  try {
    let notes = song.midiNotes;
    if ((!notes || !notes.length) && !song.seed) {
      toast('MIDI export needs an engine-generated song — imported audio and sound effects have no notes to write.', 'error');
      return;
    }
    if (!notes || !notes.length) {
      toast('Collecting the notes — rendering the song once…');
      // Local engine on purpose: the remote AI produces different audio and
      // no note data, while the local render reproduces the song exactly.
      const out = await rederiveLocally(song);
      notes = out.midiNotes || [];
      if (notes.length) {
        song.midiNotes = notes;
        await idbPut('songs', song);
      }
    }
    if (!notes.length) {
      toast('No note data available for this song.', 'error');
      return;
    }
    const midi = notesToMidi(notes, song.bpm || 120);
    downloadBlob(new Blob([midi], { type: 'audio/midi' }), `${safeTitle(song.title)} - ${song.styleLabel}.mid`);
    toast(`Downloading ${safeTitle(song.title)} - ${song.styleLabel}.mid (${notes.length} notes).`);
  } catch (err) {
    console.error(err);
    toast('MIDI export failed: ' + err.message, 'error');
  }
}

// Deterministically re-render an engine song on the LOCAL engine — same seed,
// same steering, same voice — so derived versions (instrumental, MIDI note
// collection) reproduce the exact synthesis character even when a remote AI
// engine is enabled (which produces different audio and no note data).
async function rederiveLocally(song, { vocals = null } = {}) {
  const st = song.steer || {};
  const effVocals = vocals || song.voice || st.vocals || null;
  // 'mine' songs must re-render with the member's actual recording; if the
  // recording is gone the engine falls back to the synthesized voice.
  const voiceSample = effVocals === 'mine' ? getVoiceSample() : null;
  return generateTrack({
    title: song.title,
    prompt: song.prompt,
    styles: [song.styleId],
    lyrics: song.lyrics || '',
    seedOverride: song.seed,
    bpmBias: st.bpmBias || 0,
    densityBias: st.densityBias || 0,
    voiceSig: song.voiceSig ?? null,
    mood: st.mood || null,
    vocals: effVocals,
    durationSec: song.lengthSec || 30,
    voiceSample,
  });
}

// ♪ Instrumental: derive a karaoke backing track — the same seed re-rendered
// with all vocal layers stripped. Better than “vocal removal”: nothing is
// subtracted from the mix, so the instrumental is studio-clean.
async function makeInstrumental(song) {
  if (!song) return;
  if (song.source === 'upload' || song.source === 'sfx' || !song.seed) {
    toast('Instrumentals derive from the engine\'s seed — imported audio and sound effects can\'t be stripped.', 'error');
    return;
  }
  toast('Rendering the instrumental version…');
  try {
    const out = await rederiveLocally(song, { vocals: 'off' });
    const copy = {
      id: uid(),
      title: `${song.title} (Instrumental)`,
      prompt: song.prompt,
      styleId: song.styleId,
      styleLabel: song.styleLabel,
      lyrics: '',
      duration: out.duration,
      bpm: out.bpm,
      seed: out.seed,
      hasVocals: false,
      steer: song.steer,
      voice: 'off',
      midiNotes: out.midiNotes || undefined,
      lengthSec: song.lengthSec || 30,
      createdAt: Date.now(),
      plays: 0,
      liked: false,
      variationOf: song.id,
    };
    await idbPut('audio', { id: copy.id, blob: out.blob });
    await idbPut('songs', copy);
    state.songs.unshift(copy);
    state.justCreated = [copy, ...(state.justCreated || [])].slice(0, 6);
    state.varExpanded = state.varExpanded || {};
    state.varExpanded[song.id] = true;
    noteNewSongForBackup();
    autoExportSongs([copy]);
    renderView();
    toast(`Instrumental ready — “${copy.title}”. Sing over it!`);
  } catch (err) {
    console.error(err);
    toast('Instrumental failed: ' + err.message, 'error');
  }
}

// Self-issued ownership certificate (brev.ai-style “license download”, honest
// edition): attests the track was generated locally with no third-party
// material. Engine-generated songs only — imported audio may carry rights.
function downloadLicense(song) {
  if (song.source === 'upload') {
    toast('Certificates are for songs generated here — imported audio may carry third-party rights.', 'error');
    return;
  }
  const esc = (s) => escapeHtml(String(s ?? ''));
  const cover = coverStyle(song.seed || 0);
  const created = song.createdAt ? new Date(song.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(song.title)} — Ownership Certificate</title>
<style>
  body{font-family:Georgia,serif;color:#1c1c2c;background:#f6f5fb;margin:0;padding:40px}
  .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #dcdce8;border-radius:16px;padding:48px 56px;box-shadow:0 10px 40px rgba(20,20,40,.08)}
  .band{height:8px;border-radius:4px;background:${cover.background.replace(/;/g, '')};margin-bottom:34px}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:.5px}
  .sub{color:#63637c;font-size:13px;margin:0 0 30px}
  p{line-height:1.65;font-size:14.5px}
  table{width:100%;border-collapse:collapse;margin:26px 0;font-size:13.5px}
  td{padding:8px 4px;border-bottom:1px solid #eee}
  td:first-child{color:#63637c;width:38%}
  .foot{margin-top:34px;font-size:12px;color:#63637c;display:flex;justify-content:space-between}
  @media print{body{background:#fff;padding:0}.card{border:none;box-shadow:none}}
</style></head><body><div class="card">
  <div class="band"></div>
  <h1>Ownership Certificate</h1>
  <p class="sub">MusicForStudio · full commercial rights · royalty-free</p>
  <p>This certificate attests that the musical recording</p>
  <p style="font-size:20px;margin:6px 0"><b>“${esc(song.title)}”</b></p>
  <p>was generated on the owner's own device by <b>MusicForStudio</b>, a local
  procedural music engine. The work was composed and rendered entirely
  offline: it contains <b>no third-party audio, samples, stems, or recordings</b>,
  and no external service contributed to its creation. The owner holds full
  rights to use, publish, monetize, and distribute the recording, including
  commercial use on platforms such as YouTube, Spotify, and TikTok.</p>
  <table>
    <tr><td>Title</td><td>${esc(song.title)}</td></tr>
    <tr><td>Style</td><td>${esc(song.styleLabel)}</td></tr>
    <tr><td>Duration</td><td>${fmtTime(song.duration || 0)}</td></tr>
    <tr><td>Tempo</td><td>${song.bpm ? song.bpm + ' BPM' : '—'}</td></tr>
    <tr><td>Composition seed</td><td><code>${esc(song.seed ?? '—')}</code></td></tr>
    <tr><td>Created</td><td>${created}</td></tr>
  </table>
  <p>The seed above uniquely determines the composition: re-entering it
  reproduces the exact same recording, proving provenance.</p>
  <div class="foot"><span>Issued by MusicForStudio · ${new Date().toISOString().slice(0, 10)}</span><span>✦ fully local · fully yours</span></div>
</div></body></html>`;
  downloadBlob(new Blob([html], { type: 'text/html' }), `${safeTitle(song.title)} - license.html`);
  toast(`License certificate for “${song.title}” downloaded — print it or attach it to platform requests.`);
}

// Render the song's procedural cover art to a 512×512 PNG download — handy
// for video thumbnails, playlist art and feed posts.
function downloadCoverPng(song) {
  try {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const { h1, h2, s, l } = coverFromSeed(song.seed || 0);
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, `hsl(${h1} ${s}% ${l + 16}%)`);
    grad.addColorStop(1, `hsl(${h2} ${s}% ${l - 8}%)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const glow = ctx.createRadialGradient(size * 0.3, size * 0.25, 0, size * 0.3, size * 0.25, size * 0.7);
    glow.addColorStop(0, 'rgba(255,255,255,0.35)');
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);
    // Big letter, matching the in-app card
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `800 ${size * 0.42}px system-ui, sans-serif`;
    ctx.fillText((song.title || '✦').charAt(0).toUpperCase(), size / 2, size * 0.48);
    ctx.shadowBlur = 0;
    // Title + style strip at the bottom
    ctx.font = `700 ${size * 0.055}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(song.title || 'Untitled', size / 2, size * 0.84);
    ctx.font = `500 ${size * 0.038}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(`${song.styleLabel || ''}${song.bpm ? ` · ${song.bpm} BPM` : ''} · ✦ MusicForStudio`, size / 2, size * 0.905);
    canvas.toBlob((blob) => {
      if (!blob) {
        toast('Could not render the cover.', 'error');
        return;
      }
      downloadBlob(blob, `${safeTitle(song.title)} - cover.png`);
      toast(`Downloading ${safeTitle(song.title)} - cover.png`);
    }, 'image/png');
  } catch (err) {
    console.error(err);
    toast('Cover export failed: ' + err.message, 'error');
  }
}

// Convert a decoded Float32 channel to 16-bit PCM samples for the MP3 encoder.
function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

const LAME_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

// Instant MP3 via the vendored lamejs encoder (public/vendor/lame.min.js, MIT).
async function downloadMp3(song) {
  if (typeof lamejs === 'undefined') {
    toast('MP3 encoder not loaded — downloading the WAV instead.', 'error');
    return downloadSong(song);
  }
  toast('Encoding MP3…');
  try {
    const blob = await ensureAudio(song);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    if (!LAME_SAMPLE_RATES.includes(buf.sampleRate)) {
      toast(`MP3 can't encode ${buf.sampleRate} Hz audio — downloading the WAV instead.`, 'error');
      return downloadSong(song);
    }
    const channels = Math.min(2, buf.numberOfChannels);
    const left = toInt16(buf.getChannelData(0));
    const right = channels > 1 ? toInt16(buf.getChannelData(1)) : null;
    const enc = new lamejs.Mp3Encoder(channels, buf.sampleRate, channels > 1 ? 192 : 128);
    const chunks = [];
    const BLOCK = 1152; // one MPEG frame
    for (let i = 0; i < left.length; i += BLOCK) {
      const l = left.subarray(i, i + BLOCK);
      const r = right ? right.subarray(i, i + BLOCK) : undefined;
      const part = enc.encodeBuffer(l, r);
      if (part.length) chunks.push(new Uint8Array(part));
    }
    const tail = enc.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    const mp3 = new Blob(chunks, { type: 'audio/mpeg' });
    const filename = `${safeTitle(song.title)} - ${song.styleLabel}.mp3`;
    downloadBlob(mp3, filename);
    aiRecord(song, 1, 1); // downloading = strong signal it was enjoyed
    toast(`Downloading ${filename}`);
  } catch (err) {
    console.error(err);
    toast('MP3 download failed: ' + err.message);
  }
}

// Best MediaRecorder MIME type for a video export, or null if unsupported.
function pickVideoMime() {
  const candidates = [
    'video/mp4;codecs="avc1.424028,mp4a.40.2"',
    'video/mp4',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

// Draw one frame of the exported video: seeded cover-gradient backdrop, the
// song title, a live spectrum analyser, and a progress line. Kept allocation-
// light (one gradient per region, reused across bars) because this runs at 30fps
// for the whole song.
function drawVideoFrame(c, W, H, { t, pct, freq, song, h1, h2, s, l }) {
  // Backdrop: vertical gradient between the cover's two seed hues, slowly drifting.
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `hsl(${h1 + t * 4} ${s}% ${Math.min(30, l - 18)}%)`);
  g.addColorStop(1, `hsl(${h2 + t * 2} ${s}% ${Math.max(6, l - 30)}%)`);
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  // Soft drifting glow behind the title.
  const gx = W * (0.5 + 0.25 * Math.sin(t * 0.15));
  const glow = c.createRadialGradient(gx, H * 0.32, 0, gx, H * 0.32, W * 0.65);
  glow.addColorStop(0, `hsla(${h1} ${s}% ${l}% / 0.4)`);
  glow.addColorStop(1, 'transparent');
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);

  // Title, shrunk to fit.
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.shadowColor = 'rgba(0,0,0,0.5)';
  c.shadowBlur = 18;
  let fs = 64;
  c.font = `700 ${fs}px system-ui, sans-serif`;
  let title = song.title || 'Untitled';
  while (c.measureText(title).width > W - 160 && fs > 24) {
    fs -= 2;
    c.font = `700 ${fs}px system-ui, sans-serif`;
  }
  c.fillStyle = 'rgba(255,255,255,0.94)';
  c.fillText(title, W / 2, H * 0.26);
  c.shadowBlur = 0;
  const st = styleById(song.styleId);
  c.font = '500 26px system-ui, sans-serif';
  c.fillStyle = 'rgba(255,255,255,0.72)';
  c.fillText(`${st.label}${song.bpm ? ` · ${song.bpm} BPM` : ''}`, W / 2, H * 0.26 + fs * 0.9 + 12);

  // Creator credit — the family member whose voice and library made this.
  const creator = familyMemberById(song.memberId);
  if (creator) {
    c.textAlign = 'right';
    c.font = '600 22px system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fillText(`♪ by ${creator.name}`, W - 34, H - 40);
    c.textAlign = 'center';
  }

  // Mirrored spectrum bars — one shared gradient in canvas space, so every bar
  // picks the right violet→pink→amber colour for its own height.
  const bars = 72;
  const barW = W / bars;
  const midY = H * 0.62;
  const maxH = H * 0.5;
  const step = Math.max(1, Math.floor(freq.length / bars));
  const grad = c.createLinearGradient(0, midY - maxH, 0, midY + maxH);
  grad.addColorStop(0, '#8b5cf6');
  grad.addColorStop(0.5, '#ec4899');
  grad.addColorStop(1, '#f59e0b');
  c.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    let v = 0;
    for (let j = 0; j < step; j++) v = Math.max(v, freq[i * step + j]);
    const bh = Math.max(3, (v / 255) * maxH);
    const x = i * barW + barW / 2;
    c.fillRect(x - barW * 0.27, midY - bh, Math.max(1.5, barW * 0.55), bh * 2);
  }

  // Progress line + watermark.
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.fillRect(40, H - 30, W - 80, 3);
  c.fillStyle = '#f59e0b';
  c.fillRect(40, H - 30, (W - 80) * pct, 3);
  c.font = '500 18px system-ui, sans-serif';
  c.fillStyle = 'rgba(255,255,255,0.45)';
  c.textAlign = 'right';
  c.fillText('✦ MusicForStudio', W - 40, H - 60);
}

// Real-time video export: the song plays silently through an AudioContext while
// a canvas visualizer is recorded via MediaRecorder (MP4 on Chrome/Safari,
// WebM on Firefox). Takes about as long as the song — the dialog shows progress.
let videoSource = null;
let videoCancelled = false;
let videoTimer = 0; // setInterval id driving the progress + canvas during a video export
let videoCanvas = null; // exposed for diagnostics; the recording canvas

async function downloadVideo(song) {
  const mime = pickVideoMime();
  if (!mime) {
    toast('Video recording is not supported in this browser — downloading the WAV instead.', 'error');
    return downloadSong(song);
  }
  const ext = mime.indexOf('video/mp4') === 0 ? 'mp4' : 'webm';
  let blob;
  try {
    blob = await ensureAudio(song);
  } catch (err) {
    toast('Could not load the song: ' + err.message, 'error');
    return;
  }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch (err) {
    ctx.close();
    toast('Could not decode the audio: ' + err.message, 'error');
    return;
  }
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const vctx = canvas.getContext('2d');

  const source = ctx.createBufferSource();
  source.buffer = buf;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.82;
  const dest = ctx.createMediaStreamDestination();
  source.connect(analyser);
  analyser.connect(dest);

  const vStream = canvas.captureStream(30);
  const stream = new MediaStream([...dest.stream.getAudioTracks(), ...vStream.getVideoTracks()]);
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    stream.getTracks().forEach((tr) => tr.stop());
    ctx.close();
    clearInterval(videoTimer);
    els.videoDialog.close();
    const wasCancelled = videoCancelled;
    videoCancelled = false;
    videoSource = null;
    if (wasCancelled) return;
    const video = new Blob(chunks, { type: mime });
    const filename = `${safeTitle(song.title)} - ${song.styleLabel}.${ext}`;
    downloadBlob(video, filename);
    aiRecord(song, 1, 1); // exporting a video = strong signal it was enjoyed
    toast(`Downloading ${filename} (${fmtTime(buf.duration)})`);
  };
  recorder.onerror = (e) => {
    console.error('Video recorder error:', e.error);
    toast('Video encode failed: ' + ((e.error && e.error.message) || 'unknown error'), 'error');
    videoCancelled = true;
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  };

  videoSource = source;
  videoCancelled = false;
  els.videoTitle.textContent = song.title;
  els.videoNote.textContent =
    `Encoding ${ext.toUpperCase()} in real time — this takes about as long as the song (${fmtTime(buf.duration)}). It runs silently; your player keeps playing.`;
  els.videoFill.style.width = '0%';
  els.videoStatus.textContent = `0:00 / ${fmtTime(buf.duration)}`;
  els.videoDialog.showModal();

  const freq = new Uint8Array(analyser.frequencyBinCount);
  const started = ctx.currentTime;
  const { h1, h2, s, l } = coverFromSeed(song.seed);
  // A 30fps interval (matching the canvas.captureStream rate) drives both the
  // progress bar and the visualizer. rAF would be smoother, but it is throttled
  // to zero in backgrounded tabs — the interval degrades to ~1fps there instead
  // of freezing the progress and the recording frame entirely.
  const draw = () => {
    const t = ctx.currentTime - started;
    const pct = Math.min(1, t / buf.duration);
    els.videoFill.style.width = `${Math.round(pct * 100)}%`;
    els.videoStatus.textContent = `${fmtTime(t)} / ${fmtTime(buf.duration)}`;
    analyser.getByteFrequencyData(freq);
    drawVideoFrame(vctx, W, H, { t, pct, freq, song, h1, h2, s, l });
  };
  videoCanvas = canvas;
  videoTimer = setInterval(draw, 33);

  recorder.start(500);
  source.start();
  source.onended = () => {
    clearInterval(videoTimer);
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, 300);
  };
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function shareLinkFor(song) {
  const st = song.steer;
  const g =
    st && (st.bpmBias || st.densityBias || st.mood || st.vocals)
      ? { b: st.bpmBias || 0, d: st.densityBias || 0, m: st.mood || null, v: st.vocals || null }
      : undefined;
  const data = {
    t: song.title,
    p: song.prompt,
    s: song.styleId ? [song.styleId] : [],
    l: song.lyrics || '',
    k: song.seed,
    n: song.lengthSec || 30,
    g,
  };
  const base = location.href.split('#')[0];
  return `${base}#s=${b64urlEncode(JSON.stringify(data))}`;
}

function shareSong(song) {
  aiRecord(song, 1, 1); // sharing = strong signal it was enjoyed
  const link = shareLinkFor(song);
  els.shareInput.value = link;
  els.shareInput.select();
  els.shareDialogTitle.textContent = 'Share this song';
  els.shareNote.textContent = 'Anyone who opens this link can regenerate the exact same track in MusicForStudio — nothing is uploaded or stored.';
  QRCode.toCanvas(els.shareQr, link, {
    width: 200,
    margin: 1,
    color: { dark: '#0b0b12', light: '#ffffff' },
  }).catch((err) => console.error('QR render failed', err));
  els.shareDialog.showModal();
  toast('Share link ready — copy it or scan the QR code.');
}

async function copyShareLink() {
  const text = els.shareInput.value;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      els.shareInput.select();
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
  }
  toast(ok ? 'Link copied to clipboard.' : 'Select the link and press Ctrl+C.');
}

function parseShareHash() {
  const m = location.hash.match(/[#&]s=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const d = JSON.parse(b64urlDecode(m[1]));
    if (!d || typeof d.t !== 'string' || !d.t || typeof d.p !== 'string' || d.k == null) return null;
    const styleId = (Array.isArray(d.s) ? d.s.find((x) => STYLES.some((st) => st.id === x)) : null) || 'pop';
    return {
      id: `shared-${d.k}`,
      title: String(d.t).slice(0, 80),
      prompt: String(d.p),
      styleId,
      styleLabel: styleById(styleId).label,
      lyrics: typeof d.l === 'string' ? d.l : '',
      lengthSec: d.n ? Number(d.n) : 30,
      seed: d.k,
      steer:
        d.g && typeof d.g === 'object'
          ? { bpmBias: d.g.b || 0, densityBias: d.g.d || 0, mood: d.g.m || null, vocals: d.g.v || null }
          : undefined,
      duration: 0,
      createdAt: 0,
      plays: 0,
      liked: false,
      discovery: true,
    };
  } catch {
    return null;
  }
}

function openIncoming(song) {
  state.incoming = [song];
  els.incomingCard.innerHTML = cardHtml(song, { discovery: true });
  const card = els.incomingCard.querySelector('.song-card');
  if (card) bindCard(card, song);
  els.incomingDialog.showModal();
}

async function saveDiscovery(song) {
  if (state.songs.some((s) => s.prompt === song.prompt && s.title === song.title)) {
    toast('Already in your library.');
    return;
  }
  const blob = await ensureAudio(song);
  aiRecord(song, 1, 1); // saving to the library = it was enjoyed
  const saved = { ...song, id: uid(), createdAt: Date.now(), discovery: false };
  await idbPut('audio', { id: saved.id, blob });
  await idbPut('songs', saved);
  state.songs.push(saved);
  state.justCreated = [saved, ...(state.justCreated || [])].slice(0, 6);
  noteNewSongForBackup();
  autoExportSongs([saved]); // fire-and-forget; failures toast, songs stay safe
  toast(`Saved “${saved.title}” to your library.`);
  renderView();
}

// ---------------------------------------------------------------------------
// Workspace — turn the in-browser library into real files on disk, and back.
// ---------------------------------------------------------------------------

function slugify(name) {
  return (
    String(name)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'song'
  );
}

// The portable metadata sidecar written next to each exported .wav.
function workspaceMeta(song) {
  return {
    app: 'music-for-studio',
    version: 1,
    id: song.id,
    title: song.title,
    prompt: song.prompt,
    styleId: song.styleId,
    lyrics: song.lyrics || '',
    duration: song.duration,
    bpm: song.bpm,
    seed: song.seed,
    hasVocals: !!song.hasVocals,
    steer: song.steer || null,
    voice: song.voice || null,
    source: song.source || null,
    mime: song.mime || null,
    sfxType: song.sfxType || null,
    sfxSeed: typeof song.sfxSeed === 'number' ? song.sfxSeed : null,
    lengthSec: song.lengthSec || 30,
    createdAt: song.createdAt,
    plays: song.plays || 0,
    liked: !!song.liked,
    // Trim & fade edits: recorded so an import (even metadata-only, where the
    // audio re-renders from the seed) can reproduce the edited version.
    edited: !!song.edited,
    edit: song.edit || null,
    originalDuration: song.originalDuration || null,
    // Variation family link + keeper pick, so exports keep families together.
    variationOf: song.variationOf || null,
    keptTake: !!song.keptTake,
  };
}

async function writeFileIn(dir, name, data) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

// The chosen Workspace folder handle, persisted in IndexedDB (structured-clone
// safe) under the fixed key 'workspaceFolder'.
const WORKSPACE_FOLDER_KEY = 'workspaceFolder';

async function getWorkspaceFolder() {
  const rec = await idbGet('meta', WORKSPACE_FOLDER_KEY);
  return rec ? rec.handle : null;
}

async function setWorkspaceFolder(handle) {
  await idbPut('meta', { key: WORKSPACE_FOLDER_KEY, handle });
}

async function pickWorkspaceFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    toast('Auto-export to a folder needs Chrome or Edge.', 'error');
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'musicforstudio-workspace', mode: 'readwrite' });
    await setWorkspaceFolder(handle);
    return handle;
  } catch (err) {
    if (err && err.name === 'AbortError') return null; // user cancelled
    console.error(err);
    toast('Could not open the folder: ' + err.message);
    return null;
  }
}

// Current Workspace folder + its read/write permission ('granted' | 'prompt' |
// 'denied' | 'none'). A pick grants the session; after a browser restart Chrome
// needs a re-grant via a fresh pick or requestPermission (user gesture).
async function workspaceFolderStatus() {
  const handle = await getWorkspaceFolder();
  if (!handle) return { handle: null, perm: 'none' };
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    return { handle, perm };
  } catch {
    return { handle, perm: 'denied' };
  }
}

// Write every song in `songs` to the Workspace folder as .wav + .json, without
// any further prompting. Never throws to the caller: failures surface as a
// toast, and the song always stays safe in the library.
async function autoExportSongs(songs) {
  if (!Array.isArray(songs) || !songs.length || state.autoExport !== true) return;
  const { handle, perm } = await workspaceFolderStatus();
  if (!handle) {
    toast('Auto-export is on, but no folder is chosen — pick one in Settings.', 'error');
    return;
  }
  if (perm !== 'granted') {
    state.autoExport = false;
    saveSettings();
    toast('Auto-export needs its folder re-selected (browser restarted) — re-enable it in Settings. The song is safe in your library.', 'error');
    return;
  }
  try {
    let n = 0;
    for (const song of songs) {
      const stem = `${slugify(song.title)}-${song.id.slice(0, 8)}`;
      const blob = await ensureAudio(song);
      await writeFileIn(handle, `${stem}.wav`, blob);
      await writeFileIn(handle, `${stem}.json`, JSON.stringify(workspaceMeta(song), null, 2));
      n++;
    }
    toast(`Auto-exported ${n} song${n === 1 ? '' : 's'} to your Workspace folder.`);
  } catch (err) {
    console.error(err);
    toast('Auto-export failed: ' + err.message + ' (the song is safe in your library).', 'error');
  }
}

// ---------------------------------------------------------------------------
// Single-file backup — the whole library in one .json: every song (audio
// embedded as base64, so edits and imports are preserved) plus your playlists.
// ---------------------------------------------------------------------------

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/wav' });
}

// Hex SHA-256 of a string, used to sign backups so a restore can detect a
// corrupted or hand-edited archive.
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Auto-backup reminder — a persistent banner after every N new songs so a
// fresh checkout of your taste never lives only in one browser profile.
// ---------------------------------------------------------------------------

// Called wherever a new song lands in the library (create, variation,
// discovery save). Counts it and shows the banner once the threshold hits.
function noteNewSongForBackup() {
  const r = state.backupReminder || (state.backupReminder = { every: 10, count: 0, remindedAt: 0 });
  r.count++;
  saveSettings();
  refreshBackupBanner();
}

function refreshBackupBanner() {
  const banner = els.backupBanner;
  if (!banner) return;
  const r = state.backupReminder || { every: 0, count: 0, remindedAt: 0 };
  const due = r.every > 0 && r.count > 0 && r.count - r.remindedAt >= r.every;
  banner.hidden = !due;
  if (due) {
    els.backupBannerText.textContent =
      `${r.count} new song${r.count === 1 ? '' : 's'} since your last backup — save a copy so nothing lives in one place.`;
  }
}

async function backupLibrary() {
  const songs = [...state.songs].sort((a, b) => b.createdAt - a.createdAt);
  if (!songs.length) {
    toast('Your library is empty — nothing to back up.');
    return;
  }
  const metaOnly = !!state.metaOnlyBackup;
  toast(metaOnly ? 'Building metadata-only backup…' : 'Building backup — embedding audio, this can take a moment…');
  try {
    const items = [];
    let withAudio = 0;
    for (const song of songs) {
      let audioB64 = null;
      if (!metaOnly) {
        try {
          audioB64 = await blobToB64(await ensureAudio(song));
          withAudio++;
        } catch (err) {
          console.warn('Backup: no audio for', song.id, err);
        }
      }
      items.push({ meta: workspaceMeta(song), audioB64, audioMime: audioB64 ? 'audio/wav' : null });
    }
    const archive = {
      app: 'music-for-studio',
      kind: 'library-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      // 'embedded' = every song carries its WAV; 'none' = metadata-only, every
      // song re-renders exactly from its seed on first play after a restore.
      audio: metaOnly ? 'none' : withAudio === songs.length ? 'embedded' : 'partial',
      // Integrity checksum: the SHA-256 of the songs array, verified on restore
      // so a truncated or hand-edited file is caught before anything is written.
      checksum: await sha256Hex(JSON.stringify(items)),
      // A snapshot of the user's studio preferences, so a restore brings back
      // more than songs — appearance, the on-device taste model toggle, and the
      // optional local MusicGen bridge.
      settings: {
        theme: state.theme,
        aiEnabled: !!state.aiEnabled,
        remoteEnabled: !!state.remoteEnabled,
        remoteUrl: typeof state.remoteUrl === 'string' ? state.remoteUrl : '',
      },
      songs: items,
      playlists: state.playlists.map((p) => ({ id: p.id, name: p.name, songIds: p.songIds, createdAt: p.createdAt })),
    };
    const name = `music-for-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    downloadBlob(new Blob([JSON.stringify(archive)], { type: 'application/json' }), name);
    // A successful backup resets the reminder counter.
    state.backupReminder = state.backupReminder || { every: 10, count: 0, remindedAt: 0 };
    state.backupReminder.count = 0;
    state.backupReminder.remindedAt = 0;
    saveSettings();
    refreshBackupBanner();
    const mode = metaOnly ? 'metadata-only' : 'with audio';
    toast(`Backup saved (${mode}) — ${songs.length} song(s) + ${state.playlists.length} playlist(s).`);
  } catch (err) {
    console.error(err);
    toast('Backup failed: ' + err.message);
  }
}

async function restoreLibrary(file) {
  let archive = null;
  try {
    archive = JSON.parse(await file.text());
  } catch {
    toast('That file is not a valid backup.');
    return;
  }
  if (!archive || archive.app !== 'music-for-studio' || !Array.isArray(archive.songs)) {
    toast('That file is not a MusicForStudio backup.');
    return;
  }
  // Integrity check: re-hash the songs array and compare with the archive's
  // stored checksum. A mismatch means the file was truncated or edited — the
  // restore can still proceed, but the report says so loudly.
  let checksumOk = null;
  if (typeof archive.checksum === 'string' && archive.checksum) {
    try {
      checksumOk = (await sha256Hex(JSON.stringify(archive.songs))) === archive.checksum;
    } catch {
      checksumOk = null; // subtle.crypto unavailable — skip silently
    }
  }
  // Apply the saved studio settings (theme, AI model, remote MusicGen bridge)
  // from the backup first, so the environment matches before songs are shown.
  const s = archive.settings;
  if (s && typeof s === 'object') {
    if (typeof s.theme === 'string') state.theme = s.theme === 'light' ? 'light' : 'dark';
    if (typeof s.aiEnabled === 'boolean') state.aiEnabled = s.aiEnabled;
    if (typeof s.remoteEnabled === 'boolean') state.remoteEnabled = s.remoteEnabled;
    if (typeof s.remoteUrl === 'string' && s.remoteUrl) state.remoteUrl = s.remoteUrl;
    applyTheme();
    saveSettings();
    aiInit(); // the taste-model toggle changed → (re)load with the new setting
  }
  // Per-song results for the restore report: everything that happened to
  // every song in the archive, good or bad, with the reason when not.
  const results = [];
  let added = 0;
  let updated = 0;
  let noAudio = 0;
  for (const item of archive.songs) {
    const meta = item && item.meta;
    if (!meta || typeof meta.id !== 'string' || !meta.title) {
      results.push({ title: (meta && meta.title) || '(unnamed entry)', status: 'failed', detail: 'invalid metadata' });
      continue;
    }
    try {
      const song = await importedSong(meta, '', null);
      let blob = null;
      if (item.audioB64) {
        try {
          blob = b64ToBlob(item.audioB64, item.audioMime || 'audio/wav');
        } catch (err) {
          console.warn('Restore: bad audio for', song.id, err);
        }
      }
      const existing = state.songs.find((s) => s.id === song.id);
      if (existing) {
        Object.assign(existing, song);
        updated++;
      } else {
        state.songs.push(song);
        added++;
      }
      await idbPut('songs', song);
      if (blob) {
        await idbPut('audio', { id: song.id, blob });
        results.push({ title: song.title, status: 'ok', detail: existing ? 'updated in place, audio included' : 'restored with audio' });
      } else {
        noAudio++;
        results.push({ title: song.title, status: 'noaudio', detail: existing ? 'updated in place — audio re-renders from seed on first play' : 'metadata only — audio re-renders from seed on first play' });
      }
    } catch (err) {
      console.error('Restore failed for', meta.title, err);
      results.push({ title: meta.title, status: 'failed', detail: err && err.message ? err.message : 'unknown error' });
    }
  }
  let plAdded = 0;
  let plUpdated = 0;
  for (const p of archive.playlists || []) {
    if (!p || typeof p.id !== 'string' || !p.name) continue;
    const pl = {
      id: p.id,
      name: String(p.name).slice(0, 60),
      songIds: Array.isArray(p.songIds) ? p.songIds.filter((x) => typeof x === 'string') : [],
      createdAt: Number(p.createdAt) || Date.now(),
    };
    const existing = state.playlists.find((x) => x.id === pl.id);
    if (existing) {
      Object.assign(existing, pl);
      plUpdated++;
    } else {
      state.playlists.unshift(pl);
      plAdded++;
    }
    await idbPut('playlists', pl);
  }
  const parts = [`${added} added`, `${updated} updated`];
  if (plAdded || plUpdated) parts.push(`${plAdded + plUpdated} playlist(s)`);
  if (noAudio) parts.push(`${noAudio} metadata-only (audio re-renders on first play)`);
  toast(`Backup restored — ${parts.join(', ')}.`);
  showRestoreReport({ parts, plAdded, plUpdated, checksumOk, results });
  renderView();
}

// A full per-song report of a restore: what succeeded, what came back without
// audio, what failed and why — plus the archive's checksum verdict.
function showRestoreReport({ parts, plAdded, plUpdated, checksumOk, results }) {
  if (!els.restoreReportDialog) return;
  const rows = results || [];
  const okN = rows.filter((r) => r.status === 'ok').length;
  const noaudioN = rows.filter((r) => r.status === 'noaudio').length;
  const failedN = rows.filter((r) => r.status === 'failed').length;
  els.restoreReportSummary.innerHTML = `
    <b>${parts.join(' · ')}</b><br />
    ${checksumOk === true ? '<span class="restore-checksum ok">✓ Checksum verified — the archive is intact.</span>' : ''}
    ${checksumOk === false ? '<span class="restore-checksum fail">⚠ Checksum mismatch — this file was truncated or edited. Songs were restored anyway; double-check them.</span>' : ''}
    ${checksumOk == null ? '<span class="restore-checksum">Checksum: not recorded in this archive (older backup format).</span>' : ''}
    ${rows.length ? `<br />${okN} with audio · ${noaudioN} metadata-only · ${failedN} failed` : ''}
  `;
  els.restoreReportList.innerHTML = rows.length
    ? rows
        .map(
          (r) => `
      <div class="restore-row ${r.status}">
        <span class="restore-icon">${r.status === 'ok' ? '✓' : r.status === 'noaudio' ? '♪' : '✕'}</span>
        <b>${escapeHtml(r.title)}</b>
        <span class="restore-detail">${escapeHtml(r.detail)}</span>
      </div>`
        )
        .join('')
    : '<p class="settings-note">No songs were in this backup.</p>';
  els.restoreReportDialog.showModal();
}

function workspaceReadmeText() {
  return `MusicForStudio workspace
==========================

Each exported song is stored as a pair of files:

  <title>-<id>.wav   the generated audio
  <title>-<id>.json  the song metadata (title, prompt, style, seed, lyrics, ...)

Import them back anytime from the Workspace tab. A .json alone is enough to
restore a song - its audio is re-rendered deterministically from the seed on
first play. A .wav alone is imported as audio under a best-effort title.
`;
}

async function exportWorkspace() {
  const songs = [...state.songs].sort((a, b) => b.createdAt - a.createdAt);
  if (!songs.length) {
    toast('Your library is empty — create or save a song first.');
    return;
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    // No File System Access API (Firefox/Safari): download each song's
    // .wav + .json individually so nothing is lost.
    toast('Folder export needs Chrome or Edge — downloading each song instead.', 'error');
    let n = 0;
    for (const song of songs) {
      const stem = `${slugify(song.title)}-${song.id.slice(0, 8)}`;
      downloadBlob(await ensureAudio(song), `${stem}.wav`);
      downloadBlob(new Blob([JSON.stringify(workspaceMeta(song), null, 2)], { type: 'application/json' }), `${stem}.json`);
      n++;
    }
    toast(`Downloaded ${n} song(s) as .wav + .json files.`);
    return;
  }
  let dir = null;
  try {
    dir = await window.showDirectoryPicker({ id: 'musicforstudio-workspace', mode: 'readwrite' });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled the picker
    console.error(err);
    toast('Could not open the folder: ' + err.message);
    return;
  }
  try {
    await writeFileIn(dir, 'workspace-README.txt', workspaceReadmeText());
    for (const song of songs) {
      const stem = `${slugify(song.title)}-${song.id.slice(0, 8)}`;
      await writeFileIn(dir, `${stem}.wav`, await ensureAudio(song));
      await writeFileIn(dir, `${stem}.json`, JSON.stringify(workspaceMeta(song), null, 2));
    }
    toast(`Exported ${songs.length} song(s) to your folder.`);
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + err.message);
  }
}

// Rebuild a song object from an exported .json sidecar (or, for an audio-only
// file, from the filename stem alone). `blob` is the matching .wav if present.
async function importedSong(meta, stem, blob) {
  if (meta && typeof meta === 'object' && typeof meta.id === 'string' && meta.id && typeof meta.title === 'string' && meta.title) {
    const styleId = STYLES.some((s) => s.id === meta.styleId) ? meta.styleId : 'pop';
    return {
      id: meta.id,
      title: String(meta.title).slice(0, 80) || 'Imported track',
      prompt: typeof meta.prompt === 'string' ? meta.prompt : '',
      styleId,
      styleLabel: styleById(styleId).label,
      lyrics: typeof meta.lyrics === 'string' ? meta.lyrics : '',
      duration: Number(meta.duration) || 0,
      bpm: meta.bpm != null ? Number(meta.bpm) : null,
      seed: meta.source === 'upload' || meta.source === 'sfx' ? null : typeof meta.seed === 'number' ? meta.seed : hashSeed(stem),
      hasVocals: !!meta.hasVocals,
      steer: meta.steer || null,
      voice: meta.voice || null,
      source: meta.source || null,
      mime: meta.mime || null,
      sfxType: meta.sfxType || null,
      sfxSeed: typeof meta.sfxSeed === 'number' ? meta.sfxSeed : null,
      lengthSec: Number(meta.lengthSec) || 30,
      createdAt: Number(meta.createdAt) || Date.now(),
      plays: Number(meta.plays) || 0,
      liked: !!meta.liked,
      edited: !!meta.edited || !!meta.edit,
      edit: meta.edit && typeof meta.edit === 'object'
        ? {
            start: Math.max(0, Number(meta.edit.start) || 0),
            end: Math.max(0.01, Number(meta.edit.end) || 0),
            fadeIn: Math.max(0, Number(meta.edit.fadeIn) || 0),
            fadeOut: Math.max(0, Number(meta.edit.fadeOut) || 0),
          }
        : null,
      originalDuration: Number(meta.originalDuration) || null,
      variationOf: typeof meta.variationOf === 'string' ? meta.variationOf : null,
      keptTake: !!meta.keptTake,
      discovery: false,
    };
  }
  // Audio-only file (or a JSON without id/title): best-effort track.
  const styleId = 'pop';
  return {
    id: uid(),
    title: stem.split('-').slice(0, -1).join(' ').trim() || 'Imported track',
    prompt: '',
    styleId,
    styleLabel: styleById(styleId).label,
    lyrics: '',
    duration: blob ? await wavDuration(blob) : 0,
    bpm: null,
    seed: hashSeed(stem),
    hasVocals: false,
    steer: null,
    lengthSec: 30,
    createdAt: Date.now(),
    plays: 0,
    liked: false,
    discovery: false,
  };
}

async function importWorkspaceFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const jsons = [];
  const wavs = [];
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.json')) jsons.push(f);
    else if (n.endsWith('.wav')) wavs.push(f);
  }
  if (!jsons.length && !wavs.length) {
    toast('No .wav or .json files selected.');
    return;
  }
  const stemOf = (n) => n.replace(/\.(json|wav)$/i, '');
  const pairs = new Map();
  for (const j of jsons) {
    const s = stemOf(j.name);
    const p = pairs.get(s) || {};
    p.json = j;
    pairs.set(s, p);
  }
  for (const w of wavs) {
    const s = stemOf(w.name);
    const p = pairs.get(s) || {};
    p.wav = w;
    pairs.set(s, p);
  }

  let added = 0;
  let updated = 0;
  let metaOnly = 0;
  let failed = 0;
  for (const [stem, pair] of pairs) {
    try {
      let meta = null;
      if (pair.json) {
        try {
          meta = JSON.parse(await pair.json.text());
        } catch {
          failed++;
          continue;
        }
      }
      let blob = null;
      if (pair.wav) {
        const buf = await pair.wav.arrayBuffer();
        if (buf.byteLength > 44) blob = new Blob([buf], { type: 'audio/wav' }); // guard: a text file renamed to .wav
      }
      const song = await importedSong(meta, stem, blob);
      const existing = state.songs.find((s) => s.id === song.id);
      if (existing) {
        Object.assign(existing, song);
        updated++;
      } else {
        state.songs.push(song);
        added++;
      }
      await idbPut('songs', song);
      if (blob) {
        await idbPut('audio', { id: song.id, blob });
      } else if (meta) {
        metaOnly++; // metadata-only import: audio re-renders from the seed on first play
      }
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (metaOnly) parts.push(`${metaOnly} metadata-only (audio re-renders on first play)`);
  if (failed) parts.push(`${failed} failed`);
  toast(`Import finished — ${parts.join(', ') || 'nothing imported'}.`);
  renderView();
}

function renderWorkspace(el) {
  // Chip badge: the backup reminder's own "due" rule, surfaced as a dot.
  const r = state.backupReminder || { every: 0, count: 0, remindedAt: 0 };
  const backupDue = r.every > 0 && r.count > 0 && r.count - r.remindedAt >= r.every;
  const total = state.songs.length;
  const totalSec = state.songs.reduce((a, s) => a + (s.duration || 0), 0);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const durLabel = totalSec ? `${hrs ? hrs + 'h ' : ''}${mins}m` : '—';
  const dirPick = typeof window.showDirectoryPicker === 'function';
  el.innerHTML = `
    <div class="view-head">
      <p class="kicker">WORKSPACE</p>
      <h1>Your music, as files</h1>
      <p class="hero-sub">Export your whole library to a real folder on your computer — every song as a <b>.wav</b> plus a <b>.json</b> carrying its prompt, style, seed and lyrics — and import it back anytime, even in another browser or on another machine.</p>
    </div>      ${anchorNavHtml('workspace', [
      ['export', 'Export & import'],
      ['backup', 'Backup & restore', backupDue ? { title: 'Backup reminder due' } : null],
    ])}
    <div class="stat-row">
      <div class="stat-box"><b>${total}</b><span>songs saved</span></div>
      <div class="stat-box"><b>${durLabel}</b><span>total music</span></div>
      <div class="stat-box"><b>${dirPick ? 'folder' : 'files'}</b><span>export mode</span></div>
    </div>
    <div class="field ai-panel workspace-section" id="workspace-export">
      <div class="ai-head"><span>Export & import</span><small>your music as real files</small>${copyLinkHtml('workspace=export')}</div>
      <div class="workspace-actions">
        <button class="cta" id="wsExport">🗂 Export library to a folder</button>
        <label class="ghost ws-import-btn">📂 Import .wav / .json files<input type="file" id="wsImport" accept=".wav,.json" multiple hidden /></label>
      </div>
      <p class="folder-note">${dirPick ? 'Choose a folder — each song is written as <code>title-id.wav</code> + <code>title-id.json</code>, plus a <code>workspace-README.txt</code> explaining the format.' : 'Folder export needs Chrome or Edge — on this browser each song is downloaded individually instead. Pick a destination folder and let the browser save the files there.'}</p>
      ${state.autoExport ? '<p class="folder-note">⚡ Auto-export is on — every new song is also written to this folder automatically.</p>' : ''}
      <p class="folder-note">Import accepts the exported files in any combination: a <code>.json</code> alone restores the song (its audio is re-rendered from the seed on first play), a <code>.wav</code> alone imports the audio under a best-effort title. Re-importing an existing song updates it in place.</p>
    </div>
    <div class="field ai-panel workspace-section" id="workspace-backup">
      <div class="ai-head"><span>Backup & restore</span><small>one file with everything</small>${copyLinkHtml('workspace=backup')}</div>
      <div class="backup-row">
        <button class="ghost" id="wsBackup">⭳ Backup library (.json)</button>
        <label class="ghost ws-import-btn">⭱ Restore from backup<input type="file" id="wsRestore" accept=".json,application/json" hidden /></label>
      </div>
      <p class="folder-note">A <b>backup</b> is one self-contained file: ${state.metaOnlyBackup ? 'metadata only (tiny) — every song\'s prompt, style, seed, lyrics and edits, with audio re-rendered exactly from its seed on first play after a restore' : 'every song with its audio embedded (so edits and imports are preserved)'} — plus your playlists. Restores are checksum-verified and come with a per-song report. Change the mode in Settings → Backups.</p>
    </div>
    ${total ? '' : `<div class="empty-state">
      <div class="empty-icon">🗂</div>
      <h2>Nothing to export yet</h2>
      <p>Create or save a song and it will appear here as a real file.</p>
    </div>`}
  `;
  // Anchor chips + hash deep links (#workspace=export|backup) + scroll-spy.
  wireAnchorNav(el, 'workspace', { defaultId: 'export' });
  wireCopyLinks(el);
  $('wsExport').addEventListener('click', exportWorkspace);
  $('wsBackup').addEventListener('click', backupLibrary);
  const inp = $('wsImport');
  inp.addEventListener('change', () => {
    importWorkspaceFiles(inp.files);
    inp.value = '';
  });
  const restore = $('wsRestore');
  restore.addEventListener('change', () => {
    if (restore.files && restore.files[0]) restoreLibrary(restore.files[0]);
    restore.value = '';
  });
}

// ---------------------------------------------------------------------------
// Learn — bite-size lessons about how the music is made, each with a playable
// example rendered live by the on-device engine.
// ---------------------------------------------------------------------------

const LESSONS = [
  {
    id: 'structure',
    title: 'Song structure',
    tagline: 'Every track is a loop that breathes.',
    body: 'Songs are built from repeating sections: an intro, verse/chorus loops, a breakdown and an outro. The engine arranges your prompt into a full-length form — Clips stay a tight single loop, while Full/Long songs expand into verses, choruses and a final outro. Listen for how the energy rises when the drums and vocals come in.',
    examples: [{ title: 'A full arrangement', prompt: 'bright and uplifting', styleId: 'upbeatpop' }],
  },
  {
    id: 'drums',
    title: 'Beats & drums',
    tagline: 'The groove is a pattern on a 16-step grid.',
    body: 'Each style steps to its own beat: four-on-the-floor (a kick every beat — house, techno), boom-bap (swung kick/snare — hip-hop), trap (rolling hats, half-time feel), skank (reggae), double-bass (metal) and dnb breaks. Hats swing, and the snare lands where the style wants it. Hear the difference:',
    examples: [
      { title: 'Four-on-the-floor', prompt: 'steady dancefloor groove', styleId: 'deephouse' },
      { title: 'Boom-bap', prompt: 'laid-back dusty groove', styleId: 'boombap' },
    ],
  },
  {
    id: 'chords',
    title: 'Chords & harmony',
    tagline: 'The mood lives in the harmony.',
    body: 'Each style picks a scale mode (major, minor, dorian…) and a chord progression. Seventh chords add colour and tension — you will hear them in Smooth R&B. Dark styles sit on minor harmony with sparse pads; bright pop stays on major triads. Play both and feel the difference.',
    examples: [
      { title: 'Seventh chords', prompt: 'warm and sultry', styleId: 'smoothrnb' },
      { title: 'Dark minor', prompt: 'cold and spacious', styleId: 'darkambient' },
    ],
  },
  {
    id: 'melody',
    title: 'Melody & lead',
    tagline: 'The hook is a pentatonic line with echo.',
    body: 'Leads are built from the pentatonic scale — five notes that always sound good together — played over the chords and sent through a delay for space. Synthwave lives on its wide, echoing leads. The melody is derived from your seed, so every prompt gets its own hook.',
    examples: [{ title: 'Echoing lead', prompt: 'neon night drive', styleId: 'synthwave' }],
  },
  {
    id: 'bass',
    title: 'Bass',
    tagline: 'The bass is the glue between drums and chords.',
    body: 'Styles choose how the bass behaves: Deep House rides a warm sine sub-bass locked to the kick; Trap pushes a heavy 808-style bass; Classic Rock distorts and leans forward. A bassline that follows the root of each chord is what makes the low end feel musical instead of muddy.',
    examples: [
      { title: 'Sub-bass', prompt: 'deep and hypnotic', styleId: 'deephouse' },
      { title: 'Heavy 808', prompt: 'dark and menacing', styleId: 'trap' },
    ],
  },
  {
    id: 'vocals',
    title: 'Vocals',
    tagline: 'Some styles sing, some stay instrumental.',
    body: 'Vocal styles add a sung syllable line after the first loop, synthesized in the browser — formant-filtered, with a pitch scoop into each note, swelling vibrato and breathy air. Other styles (ambient, classical, most electronic) stay instrumental or add sustained choir pads instead.',
    examples: [
      { title: 'With vocals', prompt: 'bright and energetic', styleId: 'upbeatpop' },
      { title: 'Instrumental', prompt: 'neon night drive', styleId: 'synthwave' },
    ],
  },
  {
    id: 'mood',
    title: 'Mood & tempo',
    tagline: 'One word can change the whole feel.',
    body: 'Mood keywords in your prompt (“dark”, “chill”, “epic”, “tense”…) nudge the tempo and density on top of the style’s own BPM. Same style, different mood word — different energy. Two takes of the same Cinematic Ambient style, one dark and one epic:',
    examples: [
      { title: '“dark”', prompt: 'dark and minimal', styleId: 'cinematicambient' },
      { title: '“epic”', prompt: 'epic and cinematic', styleId: 'cinematicambient' },
    ],
  },
  {
    id: 'texture',
    title: 'Texture & atmosphere',
    tagline: 'Crackle, space and reverb make it feel real.',
    body: 'Lo-fi and indie scenes add seeded vinyl crackle; pads wash through a Schroeder reverb; delay throws echoes across the mix. These textures turn a dry synth line into something you want on headphones. Chillhop is the classic example — hear the crackle under the beat.',
    examples: [{ title: 'Vinyl crackle', prompt: 'rainy window, warm coffee', styleId: 'chillhop' }],
  },
  {
    id: 'prompts',
    title: 'Writing prompts',
    tagline: 'Describe the feeling, not the gear.',
    body: 'Good prompts name a mood and a scene (“sunset drive”, “rainy night in Tokyo”) rather than technical details. Mood words shift the tempo, and the scenes in Create fill in an exact descriptive prompt for you. The seed is hashed from title + prompt + styles + lyrics, so the same words always give you the same song.',
    examples: [{ title: 'Describe the scene', prompt: 'golden hour on the coast', styleId: 'citypop' }],
  },
  {
    id: 'seeds',
    title: 'Seeds & determinism',
    tagline: 'Same input, same song — every time.',
    body: 'Everything you type is hashed into a seed that drives the whole render, so the same prompt, title, styles and lyrics reproduce the exact same track, byte for byte. That is what makes share links work: anyone who opens one regenerates your song locally, with no uploads. Play this example, then play it again — it is identical.',
    examples: [{ title: 'Deterministic', prompt: 'play me twice — the same', styleId: 'lofi' }],
  },
];

// Short per-lesson noun used in personalized hints ("hear the {topic} behind it").
const LESSON_TOPICS = {
  structure: 'arrangement',
  drums: 'groove',
  chords: 'harmony',
  melody: 'melody',
  bass: 'bassline',
  vocals: 'vocal line',
  mood: 'mood shifts',
  texture: 'atmosphere',
  prompts: 'prompt craft',
  seeds: 'same-song guarantee',
};

// A personalized one-liner for a lesson, from the user's library + AI profile:
//  - never-tried example styles get "You've never tried X — hear the ... here"
//  - once everything is familiar, point at the example style they enjoy most
// No hints at all until the user has some history, so a fresh visitor sees a
// calm page instead of ten "you've never tried" lines.
function lessonHint(lesson) {
  const tried = new Set(state.songs.map((s) => s.styleId));
  const { rows } = aiProfile();
  const aff = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) if (r.tot > 0) tried.add(r.id); // played/liked/skipped/downloaded
  if (!tried.size) return '';
  const trained = aiSampleCount() >= 6;
  const topic = LESSON_TOPICS[lesson.id] || 'sound';

  const fresh = lesson.examples.filter((ex) => !tried.has(ex.styleId));
  if (fresh.length) {
    const ex = fresh[0];
    const st = styleById(ex.styleId);
    // Only quote a percentage when the model has real evidence on this style;
    // otherwise it's just the ~50% baseline and reads as noise.
    const r = aff.get(ex.styleId);
    const pct = trained && r && r.tot > 0 ? Math.round((r.score || 0.5) * 100) : null;
    return pct != null
      ? `💡 You've never tried ${st.label} — the AI predicts ${pct}% affinity. Hear the ${topic}.`
      : `💡 You've never tried ${st.label} — hear the ${topic} here.`;
  }

  const liked = lesson.examples
    .map((ex) => ({ ex, r: aff.get(ex.styleId) }))
    .filter(({ ex, r }) => r && r.tot > 0 && r.pos >= r.neg && r.pos > 0)
    .sort((a, b) => b.r.score - a.r.score);
  if (liked.length) {
    const { ex, r } = liked[0];
    const st = styleById(ex.styleId);
    return `💡 You're into ${st.label} (${Math.round(r.score * 100)}%) — hear the ${topic} behind it.`;
  }
  return '';
}

function exampleButtonsHtml(lesson) {
  return lesson.examples
    .map(
      (ex, i) => `
        <button class="example-btn" data-example="${lesson.id}:${i}">
          <span class="example-title">▶ ${escapeHtml(ex.title)}</span>
          <span class="example-chip">${escapeHtml(styleById(ex.styleId).label)}</span>
        </button>`
    )
    .join('');
}

function renderLearn(el) {
  el.innerHTML = `
    <div class="view-head">
      <p class="kicker">LEARN</p>
      <h1>How the music is made</h1>
      <p class="hero-sub">Short lessons about the craft behind every track. Each example is generated live by the on-device engine, so you can hear exactly what the lesson is about — it renders in a couple of seconds, then replays instantly.</p>
    </div>
    ${anchorNavHtml('learn', LESSONS.map((l) => [l.id, l.title]))}
    <div class="lesson-grid">
      ${LESSONS.map(
        (l, i) => {
          const hint = lessonHint(l);
          return `
        <section class="lesson-card" data-lesson="${l.id}" data-anchor-section="${l.id}">
          <div class="lesson-head">
            <span class="lesson-num">${String(i + 1).padStart(2, '0')}</span>
            <div>
              <h2>${escapeHtml(l.title)}</h2>
              <p class="lesson-tag">${escapeHtml(l.tagline)}</p>
            </div>
            <button class="ghost-mini lesson-share" data-share="${l.id}" title="Share this lesson">⧉ Share</button>
            ${copyLinkHtml(`learn=${l.id}`)}
          </div>
          <div class="lesson-nav-row">
            <button class="ghost-mini" data-lesson-prev="${l.id}"${i === 0 ? ' disabled title="This is the first lesson"' : ' title="Previous lesson"'}>← ${i > 0 ? escapeHtml(LESSONS[i - 1].title) : ''}</button>
            <button class="ghost-mini" data-lesson-next="${l.id}"${i === LESSONS.length - 1 ? ' disabled title="This is the last lesson"' : ' title="Next lesson"'}>${i < LESSONS.length - 1 ? escapeHtml(LESSONS[i + 1].title) : ''} →</button>
          </div>
          <p class="lesson-body">${escapeHtml(l.body)}</p>
          ${hint ? `<p class="lesson-hint">${hint}</p>` : ''}
          <div class="lesson-examples">${exampleButtonsHtml(l)}</div>
        </section>`;
        }
      ).join('')}
    </div>
  `;
  el.querySelectorAll('[data-example]').forEach((btn) => {
    btn.addEventListener('click', () => playLessonExample(btn.dataset.example, btn));
  });
  // Anchor chips + hash deep links (#learn=<lesson-id>) + scroll-spy, same
  // pattern as Settings; lessons have no #ids, so map chips via data attribute.
  // Taglines feed the ⌕ section finder (e.g. typing "groove" finds the drums lesson).
  const learnNav = wireAnchorNav(el, 'learn', {
    sectionSel: (id) => el.querySelector(`.lesson-card[data-anchor-section="${CSS.escape(id)}"]`),
    keywords: Object.fromEntries(LESSONS.map((l) => [l.id, l.tagline])),
  });
  wireCopyLinks(el);
  // Prev/next: same jump semantics as the chips (hash + highlight + scroll).
  el.querySelectorAll('[data-lesson-prev], [data-lesson-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = LESSONS.findIndex((l) => l.id === btn.dataset.lessonPrev || l.id === btn.dataset.lessonNext);
      const target = btn.dataset.lessonPrev ? LESSONS[i - 1] : LESSONS[i + 1];
      if (target) learnNav.jumpTo(target.id);
    });
  });
  el.querySelectorAll('.lesson-share').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lesson = LESSONS.find((l) => l.id === btn.dataset.share);
      if (lesson) shareLesson(lesson);
    });
  });

  // Watch the hints learn in place (same pattern as Explore's affinity chips):
  // as songs are created/liked and the model trains, hints update live without
  // re-rendering the grid (which would drop the currently-playing demo).
  clearInterval(learnTimer);
  learnTimer = setInterval(() => {
    if (state.view !== 'learn') {
      clearInterval(learnTimer);
      return;
    }
    refreshLearnHints();
  }, PROFILE_REFRESH);
}

function refreshLearnHints() {
  document.querySelectorAll('.lesson-card[data-lesson]').forEach((card) => {
    const lesson = LESSONS.find((l) => l.id === card.dataset.lesson);
    if (!lesson) return;
    const hint = lessonHint(lesson);
    let el = card.querySelector('.lesson-hint');
    const examples = card.querySelector('.lesson-examples');
    if (hint) {
      if (!el) {
        el = document.createElement('p');
        el.className = 'lesson-hint';
        examples.insertAdjacentElement('beforebegin', el);
      }
      el.textContent = hint;
    } else if (el) {
      el.remove();
    }
  });
}

// A lesson share link: `#lesson=<id>` — anyone opening it lands straight on
// the Learn tab with that lesson highlighted. No data is uploaded; the link
// is just an identifier the app already ships with.
function shareLesson(lesson) {
  const link = `${location.href.split('#')[0]}#lesson=${lesson.id}`;
  els.shareInput.value = link;
  els.shareInput.select();
  els.shareDialogTitle.textContent = 'Share this lesson';
  els.shareNote.textContent = 'Anyone who opens this link lands straight on this lesson in MusicForStudio — nothing is uploaded or stored.';
  QRCode.toCanvas(els.shareQr, link, {
    width: 200,
    margin: 1,
    color: { dark: '#0b0b12', light: '#ffffff' },
  }).catch((err) => console.error('QR render failed', err));
  els.shareDialog.showModal();
  toast('Lesson link ready — copy it or scan the QR code.');
}

// Render + play one lesson example: a fixed-style, fixed-seed Clip rendered
// straight from the engine (no AI steering, no remote server), cached in memory
// so replaying it is instant. Demos live only in `learnDemos` — never saved.
async function playLessonExample(key, btn) {
  const [lid, i] = key.split(':');
  const lesson = LESSONS.find((l) => l.id === lid);
  const ex = lesson && lesson.examples[Number(i)];
  if (!ex) return;
  const demoId = `learn-${lesson.id}-${i}`;
  // Already rendered once? Replay instantly from the in-memory cache.
  const cached = learnDemos.find((d) => d.id === demoId);
  if (cached) {
    state.order = [cached.id];
    playSong(cached.id);
    return;
  }
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '▶ Rendering…';
  try {
    const result = await generateTrack({
      title: ex.title,
      prompt: ex.prompt,
      styles: [ex.styleId],
      lyrics: '',
      seedOverride: hashSeed(`${lesson.id}:${i}`),
      durationSec: 26,
    });
    const demo = {
      id: demoId,
      title: ex.title,
      prompt: ex.prompt,
      styleId: result.styleId,
      styleLabel: result.styleLabel,
      lyrics: '',
      duration: result.duration,
      bpm: result.bpm,
      seed: result.seed,
      hasVocals: result.hasVocals,
      steer: null,
      lengthSec: 26,
      createdAt: 0, // 0 => never persisted to IndexedDB
      plays: 0,
      liked: false,
      discovery: true,
    };
    const idx = learnDemos.findIndex((d) => d.id === demo.id);
    if (idx >= 0) learnDemos.splice(idx, 1);
    learnDemos.push(demo);
    blobCache.set(demo, Promise.resolve(result.blob));
    state.order = [demo.id];
    playSong(demo.id);
  } catch (err) {
    console.error(err);
    toast('Could not render the example: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------------------------------------------------------------------------
// Audio editor — trim & fade a saved song. Fully offline DSP applied to the
// rendered WAV; the edited audio replaces the song's blob, while the seed
// stays untouched (share links still reproduce the unedited version).
// ---------------------------------------------------------------------------

let editSong = null; // song being edited
const EDIT_FADE_MAX = 10; // seconds cap for fades

function editSec(v, maxSec) {
  return (v / 1000) * maxSec;
}

function currentEditOpts() {
  const dur = editSong ? editSong.duration || 0 : 0;
  const fadeMax = Math.min(EDIT_FADE_MAX, dur / 2);
  return {
    start: editSec(+els.editStart.value, dur),
    end: editSec(+els.editEnd.value, dur),
    fadeIn: editSec(+els.editFadeIn.value, fadeMax),
    fadeOut: editSec(+els.editFadeOut.value, fadeMax),
  };
}

// One-click presets: each computes trim/fade values for the song's duration,
// populates the sliders, and previews immediately so the user can hear the
// result and decide whether to commit with “Apply edit”.
const EDIT_PRESETS = {
  clip: { label: 'Make it a clip (30s)', run: (dur) => ({ start: 0, end: Math.min(30, dur), fadeIn: 0, fadeOut: 0 }) },
  outro: { label: 'Fade to silence outro', run: (dur) => ({ start: 0, end: dur, fadeIn: 0, fadeOut: Math.min(5, dur / 2) }) },
  intro: { label: 'Soft intro', run: (dur) => ({ start: 0, end: dur, fadeIn: Math.min(3, dur / 2), fadeOut: 0 }) },
  drop: { label: 'Drop the intro', run: (dur) => ({ start: Math.min(10, dur * 0.6), end: dur, fadeIn: 0, fadeOut: 0 }) },
  fadequick: { label: 'Quick fade out (2s)', run: (dur) => ({ start: 0, end: dur, fadeIn: 0, fadeOut: Math.min(2, dur / 2) }) },
  fadeslow: { label: 'Slow fade out (8s)', run: (dur) => ({ start: 0, end: dur, fadeIn: 0, fadeOut: Math.min(8, dur / 2) }) },
  fadeboth: { label: 'Fade in & out', run: (dur) => ({ start: 0, end: dur, fadeIn: Math.min(2, dur / 2), fadeOut: Math.min(5, dur / 2) }) },
};

function applyEditPreset(id) {
  const preset = EDIT_PRESETS[id];
  if (!preset || !editSong) return;
  const dur = editSong.duration || 0;
  if (dur <= 0) {
    toast('This song has no duration yet — play it once first.');
    return;
  }
  const o = preset.run(dur);
  const fadeMax = Math.min(EDIT_FADE_MAX, dur / 2);
  const set = (el, sec, max) => {
    el.value = Math.round((Math.max(0, Math.min(sec, max)) / max) * 1000);
  };
  set(els.editStart, o.start, dur);
  set(els.editEnd, Math.max(o.start + 0.01, o.end), dur);
  set(els.editFadeIn, o.fadeIn, fadeMax);
  set(els.editFadeOut, o.fadeOut, fadeMax);
  updateEditLabels();
  toast(`Preset “${preset.label}” loaded — previewing it now. Press “✂ Apply edit” to save.`);
  previewEdit();
}

// ---------------------------------------------------------------------------
// Waveform preview — a peak display of the song so you can see exactly what
// you're trimming. Loaded on dialog open, redrawn live as the sliders move.
// ---------------------------------------------------------------------------

let editWaveData = null; // { peaks: Float32Array, seconds } for the current edit

// Fast path: our engine (and the Workspace exports) write plain 16-bit PCM
// WAVs, so peaks can be read straight off the bytes without an AudioContext.
function readWavPeaks16(blob, buckets = 500) {
  return blob.arrayBuffer().then((buf) => {
    const dv = new DataView(buf);
    if (dv.byteLength < 44 || dv.getUint32(0, true) !== 0x46464952) return null;
    let off = 12;
    let numCh = 1;
    let sr = 44100;
    let bits = 16;
    let dataOffset = -1;
    while (off + 8 <= dv.byteLength) {
      const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
      const size = dv.getUint32(off + 4, true);
      if (id === 'fmt ') {
        numCh = dv.getUint16(off + 10, true);
        sr = dv.getUint32(off + 12, true);
        bits = dv.getUint16(off + 22, true);
      } else if (id === 'data') {
        dataOffset = off + 8;
        break;
      }
      off += 8 + size + (size % 2); // chunks are word-aligned
    }
    if (dataOffset < 0 || bits !== 16 || numCh < 1) return null;
    const bytesPerSample = 2;
    const frames = Math.floor((buf.byteLength - dataOffset) / (numCh * bytesPerSample));
    if (frames <= 0) return null;
    const peaks = new Float32Array(buckets);
    const samplesPerBucket = Math.max(1, Math.floor(frames / buckets));
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = dataOffset + b * samplesPerBucket * numCh * bytesPerSample;
      const end = Math.min(buf.byteLength - 1, start + samplesPerBucket * numCh * bytesPerSample);
      for (let o = start; o < end; o += numCh * bytesPerSample) {
        const a = Math.abs(dv.getInt16(o, true) / 32768);
        if (a > max) max = a;
      }
      peaks[b] = max;
    }
    return { peaks, seconds: frames / sr };
  });
}

// Slow path: any other valid WAV (e.g. 24-bit or odd chunk layout) decodes via
// an AudioContext. The context is shared and left suspended — decode works on
// suspended contexts and we never need to start it just for a preview.
let editorDecodeCtx = null;
async function readWavPeaksDecoded(blob, buckets = 500) {
  if (!editorDecodeCtx) {
    editorDecodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  const buf = await editorDecodeCtx.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  const peaks = new Float32Array(buckets);
  const perBucket = Math.max(1, Math.floor(data.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    for (let i = b * perBucket; i < Math.min(data.length, (b + 1) * perBucket); i++) {
      const a = Math.abs(data[i]);
      if (a > max) max = a;
    }
    peaks[b] = max;
  }
  return { peaks, seconds: buf.duration };
}

async function loadEditWaveform() {
  try {
    const blob = await ensureAudio(editSong);
    const fast = await readWavPeaks16(blob);
    return fast || (await readWavPeaksDecoded(blob));
  } catch (err) {
    console.warn('Waveform unavailable:', err);
    return null;
  }
}

// Zoom state: ×1 shows the whole song; higher zoom shows a window of the song
// centered on editZoomCenter (a 0..1 fraction), so fine cuts on one section of
// a long song stay possible without losing the overview.
let editZoom = 1;
let editZoomCenter = 0.5;

// The visible time window [w0, w1] at the current zoom.
function editWindow(dur) {
  const span = dur / editZoom;
  let w0 = editZoomCenter * dur - span / 2;
  w0 = Math.max(0, Math.min(Math.max(0, dur - span), w0));
  return [w0, w0 + span];
}

function drawEditWave() {
  const canvas = els.editWave;
  if (!canvas || !editWaveData) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 92;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const dur = (editSong && editSong.duration) || editWaveData.seconds || 1;
  const [w0, w1] = editWindow(dur);
  const span = Math.max(0.001, w1 - w0);
  const xOf = (t) => ((t - w0) / span) * w; // song time → canvas x
  const startSec = editSec(+els.editStart.value, dur);
  const endSec = editSec(+els.editEnd.value, dur);
  const x0 = xOf(startSec);
  const x1 = xOf(endSec);

  // Theme-aware colors from the CSS variables.
  const cs = getComputedStyle(document.documentElement);
  const violet = cs.getPropertyValue('--violet').trim() || '#8b5cf6';
  const pink = cs.getPropertyValue('--pink').trim() || '#ec4899';
  const muted = cs.getPropertyValue('--muted').trim() || '#8f8fa8';

  // Kept region highlight (the part that survives the trim), clipped to view.
  const cx0 = Math.max(0, x0);
  const cx1 = Math.min(w, x1);
  ctx.fillStyle = 'rgba(139, 92, 246, 0.22)';
  if (cx1 > cx0) ctx.fillRect(cx0, 0, cx1 - cx0, h);
  // Peaks: one bar per pixel column, sampled at that column's song time, so
  // zooming in reveals the sample-accurate shape of just that section.
  const labelH = 14; // reserved strip at the bottom for time labels
  const waveH = h - labelH;
  const midY = waveH / 2;
  const peaks = editWaveData.peaks;
  const n = peaks.length;
  for (let px = 0; px < w; px++) {
    const t = w0 + ((px + 0.5) / w) * span;
    const amp = Math.max(1, peaks[Math.max(0, Math.min(n - 1, Math.floor((t / dur) * n)))] * (waveH / 2 - 4));
    const inSel = px >= cx0 && px < cx1;
    ctx.fillStyle = inSel ? pink : muted;
    ctx.globalAlpha = inSel ? 0.9 : 0.45;
    ctx.fillRect(px, midY - amp, 1, amp * 2);
    ctx.globalAlpha = 1;
  }
  // Fade regions drawn as shaded ramps over the waveform, so the fade *shape*
  // is visible, not just the trim points.
  if (editSong && dur > 0) {
    const fadeMax = Math.min(EDIT_FADE_MAX, dur / 2);
    const fadeInSec = editSec(+els.editFadeIn.value, fadeMax);
    const fadeOutSec = editSec(+els.editFadeOut.value, fadeMax);
    const fiW = (fadeInSec / span) * w;
    const foW = (fadeOutSec / span) * w;
    if (fiW > 1) {
      const grad = ctx.createLinearGradient(x0, 0, x0 + fiW, 0);
      grad.addColorStop(0, 'rgba(236, 72, 153, 0.45)');
      grad.addColorStop(1, 'rgba(236, 72, 153, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x0, 0, fiW, waveH);
    }
    if (foW > 1) {
      const grad = ctx.createLinearGradient(x1 - foW, 0, x1, 0);
      grad.addColorStop(0, 'rgba(236, 72, 153, 0)');
      grad.addColorStop(1, 'rgba(236, 72, 153, 0.45)');
      ctx.fillStyle = grad;
      ctx.fillRect(x1 - foW, 0, foW, waveH);
    }
  }
  // Trim handles (kept on-canvas even when scrolled out of the zoom window).
  ctx.fillStyle = violet;
  ctx.fillRect(Math.max(0, Math.min(w, x0)) - 1, 0, 2.5, waveH);
  ctx.fillRect(Math.max(0, Math.min(w, x1)) - 1, 0, 2.5, waveH);
  // Time labels along the bottom for the *visible* window (0:00, 0:30, …).
  if (dur > 0) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => span / s <= 8) || 300;
    ctx.fillStyle = muted;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.85;
    for (let t = Math.ceil(w0 / step) * step; t <= w1; t += step) {
      const x = Math.min(w - 12, Math.max(12, xOf(t)));
      ctx.fillText(fmtTime(t), x, h - 3);
    }
    ctx.globalAlpha = 1;
  }
}

// Click / drag directly on the waveform to set the trim start or end — the
// handle nearest the pointer follows it, so fine cuts don't need the sliders.
// Times map through the current zoom window.
function bindEditWaveDrag() {
  const canvas = els.editWave;
  if (!canvas) return;
  let dragging = null; // 'start' | 'end'
  const secFromEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const dur = (editSong && editSong.duration) || editWaveData?.seconds || 0;
    const [w0, w1] = editWindow(dur);
    return { x, sec: dur ? w0 + (x / rect.width) * (w1 - w0) : 0, dur };
  };
  const apply = (e) => {
    if (!dragging || !editSong || !editWaveData) return;
    const { sec, dur } = secFromEvent(e);
    if (dur <= 0) return;
    const startEl = els.editStart;
    const endEl = els.editEnd;
    if (dragging === 'start') {
      const maxStart = editSec(+endEl.value, dur) - 0.01;
      startEl.value = Math.round((Math.max(0, Math.min(sec, maxStart)) / dur) * 1000);
    } else {
      const minEnd = editSec(+startEl.value, dur) + 0.01;
      endEl.value = Math.round((Math.max(minEnd, Math.min(sec, dur)) / dur) * 1000);
    }
    updateEditLabels();
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!editSong || !editWaveData) return;
    const { x } = secFromEvent(e);
    const rect = canvas.getBoundingClientRect();
    const dur = (editSong && editSong.duration) || editWaveData.seconds || 1;
    const [w0, w1] = editWindow(dur);
    const span = w1 - w0;
    const x0 = ((editSec(+els.editStart.value, dur) - w0) / span) * rect.width;
    const x1 = ((editSec(+els.editEnd.value, dur) - w0) / span) * rect.width;
    dragging = Math.abs(x - x0) <= Math.abs(x - x1) ? 'start' : 'end';
    canvas.setPointerCapture(e.pointerId);
    apply(e);
  });
  canvas.addEventListener('pointermove', apply);
  // After a drag, keep the zoom window centered on the (new) selection so the
  // section being fine-tuned stays in view.
  const stop = () => {
    if (dragging && editSong && editWaveData) {
      const dur = editSong.duration || editWaveData.seconds || 0;
      if (dur > 0) {
        editZoomCenter = (editSec(+els.editStart.value, dur) + editSec(+els.editEnd.value, dur)) / 2 / dur;
        drawEditWave();
      }
    }
    dragging = null;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
}

// ---------------------------------------------------------------------------
// Custom presets — the user's own slider combinations, saved under a name and
// offered as one-click chips next to the built-ins. Start/end are stored as a
// fraction of the song (so they make sense on any length); fades in seconds.
// ---------------------------------------------------------------------------

function renderEditCustomPresets() {
  const wrap = els.editCustomPresets;
  if (!wrap) return;
  const presets = state.customPresets || [];
  wrap.innerHTML = presets
    .map(
      (p, i) => `
      <button class="preset-chip preset-custom" data-custom="${i}" title="Apply “${escapeHtml(p.name)}”">★ ${escapeHtml(p.name)}<span class="preset-del" data-del="${i}" title="Delete this preset">✕</span></button>`
    )
    .join('');
  wrap.style.display = presets.length ? '' : 'none';
  wrap.querySelectorAll('.preset-chip').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('.preset-del')) return;
      applyCustomPreset(Number(btn.dataset.custom));
    });
  });
  wrap.querySelectorAll('.preset-del').forEach((del) => {
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = state.customPresets[Number(del.dataset.del)];
      state.customPresets.splice(Number(del.dataset.del), 1);
      saveSettings();
      renderEditCustomPresets();
      toast(`Deleted preset “${p ? p.name : ''}”.`);
    });
  });
}

function applyCustomPreset(i) {
  const p = (state.customPresets || [])[i];
  if (!p || !editSong) return;
  const dur = editSong.duration || 0;
  if (dur <= 0) {
    toast('This song has no duration yet — play it once first.');
    return;
  }
  const fadeMax = Math.min(EDIT_FADE_MAX, dur / 2);
  els.editStart.value = Math.round(p.startFrac * 1000);
  els.editEnd.value = Math.max(Math.round(p.startFrac * 1000) + 1, Math.round(p.endFrac * 1000));
  els.editFadeIn.value = Math.round((Math.min(p.fadeInSec, fadeMax) / fadeMax) * 1000) || 0;
  els.editFadeOut.value = Math.round((Math.min(p.fadeOutSec, fadeMax) / fadeMax) * 1000) || 0;
  updateEditLabels();
  toast(`Preset “${p.name}” loaded — previewing it now. Press “✂ Apply edit” to save.`);
  previewEdit();
}

function saveCurrentAsPreset() {
  if (!editSong) return;
  const name = (els.editPresetName.value || '').trim();
  if (!name) {
    toast('Give the preset a name first.');
    els.editPresetName.focus();
    return;
  }
  const dur = editSong.duration || 0;
  const fadeMax = Math.min(EDIT_FADE_MAX, dur / 2) || 1;
  const preset = {
    name: name.slice(0, 40),
    startFrac: +els.editStart.value / 1000,
    endFrac: +els.editEnd.value / 1000,
    fadeInSec: +editSec(+els.editFadeIn.value, fadeMax).toFixed(2),
    fadeOutSec: +editSec(+els.editFadeOut.value, fadeMax).toFixed(2),
  };
  const existing = state.customPresets.findIndex((p) => p.name.toLowerCase() === preset.name.toLowerCase());
  if (existing >= 0) state.customPresets[existing] = preset;
  else state.customPresets.push(preset);
  saveSettings();
  els.editPresetName.value = '';
  renderEditCustomPresets();
  toast(`Preset “${preset.name}” saved${existing >= 0 ? ' (updated)' : ''} — it now shows as a chip for every song.`);
}

// Per-song editor memory: slider positions + zoom, captured whenever the
// dialog closes, so reopening the same song puts everything back as you left it.
function saveEditMemory() {
  if (!editSong) return;
  state.editMemory[editSong.id] = {
    start: +els.editStart.value,
    end: +els.editEnd.value,
    fadeIn: +els.editFadeIn.value,
    fadeOut: +els.editFadeOut.value,
    zoom: editZoom,
  };
  saveSettings();
}

function updateEditLabels() {
  const dur = editSong ? editSong.duration || 0 : 0;
  const fadeMax = Math.min(EDIT_FADE_MAX, dur / 2);
  els.editStartLbl.textContent = fmtTime(editSec(+els.editStart.value, dur));
  els.editEndLbl.textContent = fmtTime(editSec(+els.editEnd.value, dur));
  els.editFadeInLbl.textContent = `${editSec(+els.editFadeIn.value, fadeMax).toFixed(1)}s`;
  els.editFadeOutLbl.textContent = `${editSec(+els.editFadeOut.value, fadeMax).toFixed(1)}s`;
  drawEditWave(); // keep the waveform's kept-region highlight in sync
}

function openEditDialog(song) {
  editSong = song;
  editWaveData = null;
  els.editNote.textContent = `Trim the start/end and shape the fades for “${song.title}” (${fmtTime(song.duration || 0)}). The edited WAV replaces this song's audio in your library — the original seed is untouched, so share links still reproduce the unedited version.`;
  // Restore this song's remembered sliders + zoom (or clean defaults).
  const mem = state.editMemory[song.id];
  if (mem) {
    els.editStart.value = mem.start;
    els.editEnd.value = mem.end;
    els.editFadeIn.value = mem.fadeIn;
    els.editFadeOut.value = mem.fadeOut;
    editZoom = Math.max(1, Math.min(16, +mem.zoom || 1));
  } else {
    els.editStart.value = 0;
    els.editEnd.value = 1000;
    els.editFadeIn.value = 0;
    els.editFadeOut.value = 0;
    editZoom = 1;
  }
  editZoomCenter = 0.5;
  if (els.editZoom) {
    els.editZoom.value = editZoom;
    els.editZoomLbl.textContent = `×${editZoom}`;
  }
  renderEditCustomPresets();
  updateEditLabels();
  els.editDialog.showModal();
  // Load the waveform (fast 16-bit read, decode fallback) and draw it once ready.
  loadEditWaveform().then((data) => {
    editWaveData = data;
    drawEditWave();
  });
}

// Trim a WAV blob to [start, end] seconds and apply fade in/out envelopes.
// Pure sample math — no WebAudio rendering nodes, so it works in any browser.
// Used both by the editor (preview/apply) and by ensureAudio, which re-applies
// a saved edit after re-rendering a song from its seed.
async function renderEditedAudioFromBlob(blob, opts) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const sr = buf.sampleRate;
    const ch = buf.numberOfChannels;
    // Clamp to the *actual* decoded audio — a song whose stored WAV doesn't
    // match its metadata duration (e.g. an edited or hand-imported file) must
    // never produce an out-of-range trim.
    const realDur = buf.length / sr;
    const startSec = Math.max(0, Math.min(opts.start, realDur));
    const endSec = Math.max(startSec + 0.01, Math.min(opts.end, realDur));
    const startI = Math.floor(startSec * sr);
    const endI = Math.min(buf.length, Math.floor(endSec * sr));
    const len = Math.max(1, endI - startI);
    const fadeInN = Math.min(Math.floor(opts.fadeIn * sr), len);
    const fadeOutN = Math.min(Math.floor(opts.fadeOut * sr), len);
    const out = ctx.createBuffer(ch, len, sr);
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < len; i++) {
        let v = src[startI + i];
        if (fadeInN > 0 && i < fadeInN) v *= i / fadeInN;
        if (fadeOutN > 0 && i >= len - fadeOutN) v *= (len - i) / fadeOutN;
        dst[i] = v;
      }
    }
    return { blob: audioBufferToWav(out), duration: len / sr };
  } finally {
    ctx.close().catch(() => {});
  }
}

async function renderEditedAudio(song, opts) {
  const blob = await ensureAudio(song);
  return renderEditedAudioFromBlob(blob, opts);
}

async function previewEdit() {
  if (!editSong) return;
  try {
    const opts = currentEditOpts();
    state.preEditOrder = state.order; // restored when the dialog closes
    const result = await renderEditedAudio(editSong, opts);
    const demo = {
      id: `edit-preview-${editSong.id}`,
      title: `${editSong.title} (preview)`,
      prompt: editSong.prompt,
      styleId: editSong.styleId,
      styleLabel: editSong.styleLabel,
      lyrics: '',
      duration: result.duration,
      bpm: editSong.bpm,
      seed: editSong.seed,
      hasVocals: editSong.hasVocals,
      steer: null,
      lengthSec: 30,
      createdAt: 0,
      plays: 0,
      liked: false,
      discovery: true,
    };
    const idx = learnDemos.findIndex((d) => d.id === demo.id);
    if (idx >= 0) learnDemos.splice(idx, 1);
    learnDemos.push(demo);
    blobCache.set(demo, Promise.resolve(result.blob));
    state.order = [demo.id];
    playSong(demo.id);
    toast('Previewing the edit — press “✂ Apply edit” to save it.');
  } catch (err) {
    console.error(err);
    toast('Preview failed: ' + err.message);
  }
}

// Loop the current audio back onto itself with a short equal-power crossfade
// at the seam — the extend path for imported audio (and pre-edited songs),
// which can't be re-rendered from a seed.
async function loopExtendAudio(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const sr = buf.sampleRate;
    const ch = buf.numberOfChannels;
    const len = buf.length;
    const xLen = Math.min(Math.floor(0.25 * sr), Math.floor(len / 4));
    const outLen = 2 * len - xLen;
    const out = ctx.createBuffer(ch, outLen, sr);
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < outLen; i++) {
        if (i < len - xLen) dst[i] = src[i];
        else if (i < len) {
          const j = i - (len - xLen);
          const t = j / xLen;
          dst[i] = src[i] * (1 - t) + src[j] * t;
        } else dst[i] = src[i - (len - xLen)];
      }
    }
    return { blob: audioBufferToWav(out), duration: outLen / sr };
  } finally {
    ctx.close().catch(() => {});
  }
}

// Remove [start,end] from the audio and join the parts with 15 ms anti-click
// fades — an honest, local take on "replace section".
async function cutSectionAudio(blob, { start, end }) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const sr = buf.sampleRate;
    const ch = buf.numberOfChannels;
    const realDur = buf.length / sr;
    const startI = Math.max(0, Math.min(Math.floor(start * sr), buf.length - 1));
    const endI = Math.max(startI + 1, Math.min(Math.floor(end * sr), buf.length));
    const fN = Math.min(Math.floor(0.015 * sr), startI, buf.length - endI);
    const outLen = startI + (buf.length - endI);
    const out = ctx.createBuffer(ch, outLen, sr);
    for (let c = 0; c < ch; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < startI; i++) {
        let v = src[i];
        if (fN > 0 && i >= startI - fN) v *= (startI - i) / fN;
        dst[i] = v;
      }
      for (let i = endI; i < buf.length; i++) {
        let v = src[i];
        if (fN > 0 && i < endI + fN) v *= (i - endI) / fN;
        dst[startI + (i - endI)] = v;
      }
    }
    return { blob: audioBufferToWav(out), duration: outLen / sr };
  } finally {
    ctx.close().catch(() => {});
  }
}

// ⤢ Extend ×2: engine songs re-render at double length with the same seed
// (the arrangement grows — more loops, same character). Imported or already
// edited songs loop-extend the stored audio instead.
async function extendSong() {
  if (!editSong || state.creating) return;
  const song = editSong;
  const btn = els.editExtend;
  btn.disabled = true;
  btn.textContent = 'Extending…';
  try {
    let blob, dur;
    if (song.seed && !song.source && !song.edited) {
      const base = Math.min(600, Math.max(60, (song.lengthSec || song.duration || 30) * 2));
      const r = await generateSong({
        title: song.title,
        prompt: song.prompt,
        styles: [song.styleId],
        lyrics: song.lyrics || '',
        seedOverride: song.seed,
        steer: song.steer,
        voice: song.voice || null,
        lengthSec: base,
      });
      blob = r.blob;
      dur = r.duration;
    } else {
      const r = await loopExtendAudio(await ensureAudio(song));
      blob = r.blob;
      dur = r.duration;
    }
    await idbPut('audio', { id: song.id, blob });
    song.duration = dur;
    song.edit = null;
    song.edited = false;
    song.originalDuration = null;
    await idbPut('songs', song);
    if (blobCache.has(song)) blobCache.delete(song);
    abWaves.delete(song.id);
    els.editDialog.close(); // the 'close' listener captures memory + queue
    if (state.currentSongId === song.id) playSong(song.id);
    renderView();
    toast(`Extended to ${fmtTime(dur)} — Undo edit re-renders the original.`);
  } catch (err) {
    console.error(err);
    toast('Extend failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⤢ Extend ×2';
  }
}

// ✂ Cut section: remove the selected [start,end] span and join the parts.
async function cutSection() {
  if (!editSong) return;
  const song = editSong;
  const opts = currentEditOpts();
  if (opts.end - opts.start < 0.2) {
    toast('Select a section of at least 0.2 s to cut.');
    return;
  }
  const btn = els.editCut;
  btn.disabled = true;
  btn.textContent = 'Cutting…';
  try {
    const r = await cutSectionAudio(await ensureAudio(song), { start: opts.start, end: opts.end });
    await idbPut('audio', { id: song.id, blob: r.blob });
    song.duration = r.duration;
    song.edit = null;
    song.edited = false;
    song.originalDuration = null;
    await idbPut('songs', song);
    if (blobCache.has(song)) blobCache.delete(song);
    abWaves.delete(song.id);
    els.editDialog.close();
    if (state.currentSongId === song.id) playSong(song.id);
    renderView();
    toast(`Cut ${fmtTime(opts.end - opts.start)} — now ${fmtTime(r.duration)}.`);
  } catch (err) {
    console.error(err);
    toast('Cut failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✂ Cut section';
  }
}

async function applyEdit() {
  if (!editSong) return;
  const song = editSong;
  const opts = currentEditOpts();
  const btn = els.editApply;
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    const result = await renderEditedAudio(song, opts);
    await idbPut('audio', { id: song.id, blob: result.blob });
    // Remember what was done so exports/imports preserve the edit, and the
    // card can show the before → after length. The seed stays untouched.
    if (!song.originalDuration) song.originalDuration = song.duration || result.duration;
    song.edit = { start: opts.start, end: opts.end, fadeIn: opts.fadeIn, fadeOut: opts.fadeOut };
    song.duration = result.duration;
    song.edited = true;
    await idbPut('songs', song);
    if (blobCache.has(song)) blobCache.delete(song);
    abWaves.delete(song.id); // peaks changed — the A/B dialog must re-decode
    els.editDialog.close(); // the 'close' listener captures memory + queue
    if (state.currentSongId === song.id) playSong(song.id);
    renderView();
    toast('Edit applied — the trimmed & faded version is now in your library.');
  } catch (err) {
    console.error(err);
    toast('Edit failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✂ Apply edit';
  }
}

// ---------------------------------------------------------------------------
// Player UI
// ---------------------------------------------------------------------------

function renderNowPlaying() {
  const song = currentSong();
  if (song) {
    els.npTitle.textContent = song.title;
    const vocalTag = song.hasVocals ? ' · ♪ Vocals' : '';
    els.npArtist.textContent = `${song.styleLabel}${song.bpm ? ` · ${song.bpm} BPM` : ''}${vocalTag}`;
    const cover = coverStyle(song.seed, coverLetter(song.title));
    els.art.style.background = cover.background;
    els.artLetter.textContent = coverLetter(song.title);
    els.art.classList.add('active');
    els.likeBtn.textContent = song.liked ? '♥' : '♡';
    els.likeBtn.classList.toggle('on', !!song.liked);
    els.lyricsBtn.hidden = !song.lyrics;
  } else {
    els.npTitle.textContent = 'Nothing playing';
    els.npArtist.textContent = 'Your personal studio';
    els.art.style.background = '';
    els.artLetter.textContent = '✦';
    els.art.classList.remove('active');
    els.likeBtn.textContent = '♡';
    els.lyricsBtn.hidden = true;
  }
  els.playBtn.textContent = player.paused ? '▶' : '❚❚';
  if (els.shuffleBtn && els.repeatBtn) {
    els.shuffleBtn.classList.toggle('on', state.shuffle);
    els.repeatBtn.classList.toggle('on', state.repeat !== 'off');
    els.repeatBtn.textContent = state.repeat === 'one' ? '🔂' : '🔁';
    els.repeatBtn.title = `Repeat: ${state.repeat} (R)`;
  }
  syncMediaSession();
  renderQueue(); // keep the open queue dialog's current-marker in sync
}

function paintRange(el, pct) {
  el.style.setProperty('--fill', `${Math.round(pct * 100)}%`);
}

function onTimeUpdate(current) {
  if (els.seekBar.dataset.dragging === '1') return;
  scheduleResumeSave();
  const dur = player.duration;
  els.curTime.textContent = fmtTime(current);
  els.durTime.textContent = dur ? fmtTime(dur) : '0:00';
  if (dur) {
    const pct = current / dur;
    els.seekBar.value = Math.round(pct * 1000);
    paintRange(els.seekBar, pct);
  }
  // Keep the shared A/B compare position (and its waveforms) in sync while
  // the dialog is open, so paused takes remember exactly where they were.
  if (state.abCompare && state.abCompare.ids.includes(state.currentSongId)) {
    state.abCompare.pos = current;
    if (els.abDialog && els.abDialog.open) drawAbWaves();
  }
}

function onEnded() {
  const song = currentSong();
  if (song && state.aiPlayId === song.id) {
    aiRecord(song, 1, 1); // listened to the end
    state.aiPlayId = null;
  }
  clearResumePosition(); // finished — nothing to resume
  // Repeat-one replays the finished track from the top
  if (state.repeat === 'one' && song) {
    playSong(song.id);
    return;
  }
  nextTrack();
  // After the last queued song finishes, re-check the backup reminder
  refreshBackupBanner();
}

// Cycle off → all → one. Each mode is announced so the change is noticeable
// without watching the button; the button reflects state via renderNowPlaying.
function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  saveSettings();
  renderNowPlaying();
  toast(state.repeat === 'off' ? 'Repeat off' : state.repeat === 'all' ? 'Repeat all' : 'Repeat one — this track loops');
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  saveSettings();
  renderNowPlaying();
  toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
}

// ---------------------------------------------------------------------------
// Play queue dialog: the upcoming songs in play order. Reordering edits only
// state.order — the library itself is never touched. Click = jump, ✕ = remove,
// ↑/↓ = nudge, drag = free reorder.
// ---------------------------------------------------------------------------
function queueRows() {
  const order = state.order.length ? state.order : visibleOrder();
  return order.map((id) => ({ id, song: findSong(id) })).filter((r) => r.song);
}

function renderQueue() {
  if (!els.queueDialog || !els.queueDialog.open) return;
  const rows = queueRows();
  els.queueNote.textContent = state.shuffle
    ? 'Shuffle is on — this is the pool; playback picks randomly.'
    : 'The queue follows the view you started from. Click a song to jump; drag or use ↑ ↓ to reorder.';
  els.queueList.innerHTML = rows.length
    ? rows.map(({ id, song }, i) => `
      <div class="queue-row${id === state.currentSongId ? ' current' : ''}" draggable="true" data-id="${id}">
        <span class="queue-pos">${id === state.currentSongId ? '▶' : i + 1}</span>
        <span class="queue-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</span>
        <span class="queue-dur">${fmtTime(song.duration || 0)}</span>
        <button class="mini-btn" title="Move up" data-move="-1" data-id="${id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="mini-btn" title="Move down" data-move="1" data-id="${id}" ${i === rows.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="mini-btn queue-remove" title="Remove from queue" data-remove="${id}">✕</button>
      </div>`)
    : '<p class="queue-empty">Nothing queued — play something and it will show up here.</p>';
}

function nudgeInQueue(id, dir) {
  const order = state.order.length ? state.order : (state.order = visibleOrder());
  const i = order.indexOf(id);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  renderQueue();
}

function moveInQueue(dragId, targetId) {
  const order = state.order.length ? state.order : (state.order = visibleOrder());
  const from = order.indexOf(dragId);
  const targetPos = order.indexOf(targetId);
  if (from === -1 || targetPos === -1 || dragId === targetId) return;
  const down = from < targetPos; // dragging downward lands after the target
  order.splice(from, 1);
  order.splice(order.indexOf(targetId) + (down ? 1 : 0), 0, dragId);
  renderQueue();
}

function wireQueueDrag() {
  let dragId = null;
  els.queueList.addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
      nudgeInQueue(move.dataset.id, Number(move.dataset.move));
      return;
    }
    const rem = e.target.closest('[data-remove]');
    if (rem) {
      const id = rem.dataset.remove;
      state.order = (state.order.length ? state.order : visibleOrder()).filter((x) => x !== id);
      if (id === state.currentSongId) {
        player.pause();
        state.currentSongId = null;
        renderNowPlaying();
      }
      renderQueue();
      return;
    }
    const row = e.target.closest('.queue-row');
    if (row) playSong(row.dataset.id);
  });
  // Drop a Library card here to append that song to the queue.
  els.queueDialog.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    els.queueDialog.classList.add('drop-target');
  });
  els.queueDialog.addEventListener('dragleave', () => els.queueDialog.classList.remove('drop-target'));
  els.queueDialog.addEventListener('drop', (e) => {
    els.queueDialog.classList.remove('drop-target');
    const raw = e.dataTransfer.getData('text/plain') || '';
    const m = raw.match(/^song:([A-Za-z0-9_-]+)$/);
    if (!m) return; // internal queue-row drags carry a bare id
    e.preventDefault();
    const song = findSong(m[1]);
    if (!song) return;
    state.order = state.order.length ? state.order : visibleOrder();
    if (state.order.includes(song.id)) { toast(`“${song.title}” is already in the queue.`); return; }
    state.order.push(song.id);
    if (state.shuffle) toggleShuffle(); // appending ends the shuffle pool
    renderQueue();
    toast(`Added “${song.title}” to the queue.`, 'success');
  });
  els.queueList.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.queue-row');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  });
  els.queueList.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.queue-row');
    if (row) els.queueList.querySelectorAll('.queue-row').forEach((r) => r.classList.toggle('drop-target', r === row && r.dataset.id !== dragId));
  });
  els.queueList.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = e.target.closest('.queue-row');
    if (row && dragId && row.dataset.id !== dragId) moveInQueue(dragId, row.dataset.id);
  });
  els.queueList.addEventListener('dragend', () => {
    dragId = null;
    els.queueList.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
  });
}

function onPlayState(playing) {
  els.playBtn.textContent = playing ? '❚❚' : '▶';
  els.art.classList.toggle('active', playing);
  renderCards();
  refreshAbDialog(); // keep the A/B dialog's playing highlight in sync
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// Where you were in a view survives tab switches: leaving captures
// #content's scrollTop, coming back restores it (one rAF, after the fresh
// render). Anchor views re-land on their hash section instead — that wins.
const viewScrollPos = {};
function setView(view) {
  const prev = state.view;
  if (prev && prev !== view) {
    const el = els.content;
    if (el) viewScrollPos[prev] = el.scrollTop;
  }
  state.view = view;
  els.searchInput.value = '';
  state.search = '';
  const exploreAsync = view === 'explore' && !state.exploreCache.length;
  if (exploreAsync) {
    buildExplore().then(() => renderView());
    return;
  }
  renderView();
  const saved = viewScrollPos[view];
  const hashTargetsThisView = new RegExp(`[#&]${view}=`).test(location.hash);
  if (saved != null && !hashTargetsThisView) {
    // A short timeout, not rAF: embedded webviews can stop producing frames
    // entirely (no rAF callbacks — observed), and async section painters (the
    // Account panel's IndexedDB count read) must settle before the value is
    // applied or the browser clamps it to the still-short page.
    setTimeout(() => {
      els.content.scrollTop = saved;
      els.content.dispatchEvent(new Event('scroll')); // re-sync spy/progress
    }, 60);
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => setView(t.dataset.tab));
  });

  els.playBtn.addEventListener('click', () => player.toggle());
  els.nextBtn.addEventListener('click', () => nextTrack());
  els.prevBtn.addEventListener('click', () => prevTrack());
  els.shuffleBtn.addEventListener('click', () => toggleShuffle());
  els.repeatBtn.addEventListener('click', () => cycleRepeat());
  els.queueBtn.addEventListener('click', () => {
    els.queueDialog.showModal(); // renderQueue() paints only an open dialog
    renderQueue();
  });
  els.queueClose.addEventListener('click', () => els.queueDialog.close());
  els.queueDialog.addEventListener('click', (e) => {
    if (e.target === els.queueDialog) els.queueDialog.close();
  });
  wireQueueDrag();
  // Deep link `#queue=1` opens the Up Next dialog on top of the routed view.
  const openQueueFromHash = () => {
    if (!location.hash.match(/[#&]queue=1(?:&|$)/)) return;
    els.queueBtn.click();
  };
  openQueueFromHash();
  window.addEventListener('hashchange', openQueueFromHash);

  els.seekBar.addEventListener('input', () => {
    els.seekBar.dataset.dragging = '1';
    const dur = player.duration;
    if (dur) els.curTime.textContent = fmtTime((els.seekBar.value / 1000) * dur);
  });
  els.seekBar.addEventListener('change', () => {
    const dur = player.duration;
    if (dur) player.seek((els.seekBar.value / 1000) * dur);
    els.seekBar.dataset.dragging = '0';
  });
  els.seekBar.addEventListener('pointerup', () => (els.seekBar.dataset.dragging = '0'));

  els.volumeBar.value = state.volume;
  paintRange(els.volumeBar, state.volume);
  player.setVolume(state.volume);
  els.volumeBar.addEventListener('input', () => {
    state.volume = parseFloat(els.volumeBar.value);
    state.muted = false;
    player.setVolume(state.volume);
    saveSettings();
    paintRange(els.volumeBar, state.volume);
    els.muteBtn.classList.remove('on');
  });
  els.muteBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    player.setVolume(state.muted ? 0 : state.volume);
    els.muteBtn.classList.toggle('on', state.muted);
  });

  els.likeBtn.addEventListener('click', () => {
    const song = currentSong();
    if (song) toggleLike(song);
  });

  els.lyricsBtn.addEventListener('click', () => {
    const song = currentSong();
    if (!song || !song.lyrics) return;
    els.lyricsTitle.textContent = song.title;
    els.lyricsBody.textContent = song.lyrics;
    els.lyricsDialog.showModal();
  });
  els.lyricsClose.addEventListener('click', () => els.lyricsDialog.close());
  els.lyricsDialog.addEventListener('click', (e) => {
    if (e.target === els.lyricsDialog) els.lyricsDialog.close();
  });

  els.searchInput.addEventListener('input', () => {
    state.search = els.searchInput.value;
    if (state.view === 'library') renderView();
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        player.toggle();
        break;
      case 'ArrowRight':
        e.preventDefault();
        player.seek(player.audio.currentTime + 5);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        player.seek(player.audio.currentTime - 5);
        break;
      case 'n':
      case 'N':
        nextTrack();
        break;
      case 'p':
      case 'P':
        prevTrack();
        break;
      case 'm':
      case 'M':
        els.muteBtn.click();
        break;
      case 'l':
      case 'L':
        if (state.currentSongId) toggleLike(currentSong());
        break;
      case 's':
      case 'S':
        toggleShuffle();
        break;
      case 'r':
      case 'R':
        cycleRepeat();
        break;
      case 'q':
      case 'Q':
        els.queueBtn.click();
        break;
      case 'c':
      case 'C':
        setView('create');
        break;
    }
  });
  window.addEventListener('blur', () => (els.seekBar.dataset.dragging = '0'));
  // Resume position must survive even an instant tab close — pagehide is the
  // reliable last-chance save (beforeunload is not on mobile).
  window.addEventListener('pagehide', saveResumePosition);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const player = new Player({
  onTime: onTimeUpdate,
  onEnd: onEnded,
  onPlayState,
});

// ---------------------------------------------------------------------------
// Media Session: OS media keys, lockscreen and notification show the track's
// title/artist/cover and expose prev/play-pause/next. Purely additive — the
// API simply doesn't exist in some browsers.
// ---------------------------------------------------------------------------
let mediaCoverCanvas = null;
function mediaCoverDataURL(seed, title) {
  try {
    if (!mediaCoverCanvas) {
      mediaCoverCanvas = document.createElement('canvas');
      mediaCoverCanvas.width = mediaCoverCanvas.height = 256;
    }
    const ctx = mediaCoverCanvas.getContext('2d');
    const { h1, h2, s, l } = coverFromSeed(seed);
    const g = ctx.createConicGradient ? ctx.createConicGradient((seed % 360) * Math.PI / 180, 128, 160) : null;
    if (g) {
      g.addColorStop(0, `hsl(${h1} ${s}% ${l}%)`);
      g.addColorStop(0.5, `hsl(${h2} ${s}% ${Math.max(0, l - 12)}%)`);
      g.addColorStop(1, `hsl(${h1} ${s}% ${l}%)`);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = `hsl(${h1} ${s}% ${l}%)`;
    }
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = `hsl(${h1} ${s}% ${Math.min(92, l + 30)}%)`;
    ctx.font = 'bold 120px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(coverLetter(title), 128, 136);
    return mediaCoverCanvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function syncMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const song = currentSong();
  if (!song) {
    navigator.mediaSession.metadata = null;
    return;
  }
  try {
    const cover = mediaCoverDataURL(song.seed || 0, song.title);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Untitled',
      artist: song.styleLabel || 'MusicForStudio',
      album: 'MusicForStudio',
      artwork: cover ? [{ src: cover, sizes: '256x256', type: 'image/png' }] : [],
    });
  } catch {}
  try {
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('play', () => player.play());
    navigator.mediaSession.setActionHandler('pause', () => player.pause());
  } catch {}
}

// ---------------------------------------------------------------------------
// Resume position: each song remembers where you stopped (position + whether
// it was still playing), so reopening the app picks up where you left off.
// Saved throttled during playback + reliably on pagehide; cleared when a song
// finishes or is restarted deliberately.
// ---------------------------------------------------------------------------
const RESUME_KEY = 'mfs.resume.v1';
let resumeSaveTimer = null;
function saveResumePosition() {
  const song = currentSong();
  if (!song || !song.createdAt) return; // only saved-library songs resume
  const pos = player.audio.currentTime || 0;
  if (pos < 1) return; // essentially at the start — nothing worth resuming
  const data = { id: song.id, pos, playing: !player.paused, at: Date.now() };
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(data)); } catch {}
}

function scheduleResumeSave() {
  if (resumeSaveTimer) return;
  resumeSaveTimer = setTimeout(() => {
    resumeSaveTimer = null;
    saveResumePosition();
  }, 2000);
}

function clearResumePosition() {
  try { localStorage.removeItem(RESUME_KEY); } catch {}
}

function readResumePosition() {
  try {
    const d = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    return d && d.id && typeof d.pos === 'number' ? d : null;
  } catch {
    return null;
  }
}

// Resume offer as an in-app dialog — confirm() would hard-hang embedded
// webviews (native modal nobody can answer). Both paths always remove the
// dialog element; dialog `close` events are unreliable in embedded browsers.
function offerResumeDialog(resumed, song) {
  const min = Math.floor(resumed.pos / 60);
  const sec = String(Math.floor(resumed.pos % 60)).padStart(2, '0');
  document.querySelectorAll('.resume-offer').forEach((d) => d.remove());
  const dlg = document.createElement('dialog');
  dlg.className = 'resume-offer';
  dlg.innerHTML = `
    <div class="dialog-head"><h2>Continue playing?</h2></div>
    <p class="dialog-note">“${escapeHtml(song.title)}” stopped at ${min}:${sec} last time.</p>
    <div class="resume-offer-actions">
      <button class="ghost" data-resume="no">Start fresh</button>
      <button data-resume="yes">Continue from ${min}:${sec}</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-resume]');
    if (!b) return;
    dlg.remove();
    if (b.dataset.resume === 'yes') {
      playSong(song.id).then(() => {
        if (!resumed.playing) player.pause();
        player.seek(resumed.pos);
      });
    } else {
      clearResumePosition();
    }
  });
  dlg.showModal();
}

async function init() {
  Object.assign(els, {
    content: $('content'),
    searchInput: $('searchInput'),
    playBtn: $('playBtn'),
    prevBtn: $('prevBtn'),
    nextBtn: $('nextBtn'),
    shuffleBtn: $('shuffleBtn'),
    repeatBtn: $('repeatBtn'),
    queueBtn: $('queueBtn'),
    queueDialog: $('queueDialog'),
    queueList: $('queueList'),
    queueNote: $('queueNote'),
    queueClose: $('queueClose'),
    seekBar: $('seekBar'),
    curTime: $('curTime'),
    durTime: $('durTime'),
    volumeBar: $('volumeBar'),
    muteBtn: $('muteBtn'),
    art: $('art'),
    artLetter: $('artLetter'),
    npTitle: $('npTitle'),
    npArtist: $('npArtist'),
    likeBtn: $('likeBtn'),
    lyricsBtn: $('lyricsBtn'),
    lyricsDialog: $('lyricsDialog'),
    lyricsTitle: $('lyricsTitle'),
    lyricsBody: $('lyricsBody'),
    lyricsClose: $('lyricsClose'),
    shareDialog: $('shareDialog'),
    shareDialogTitle: $('shareDialogTitle'),
    shareNote: $('shareNote'),
    shareInput: $('shareInput'),
    shareQr: $('shareQr'),
    shareCopy: $('shareCopy'),
    shareClose: $('shareClose'),
    incomingDialog: $('incomingDialog'),
    incomingCard: $('incomingCard'),
    incomingPlay: $('incomingPlay'),
    incomingSave: $('incomingSave'),
    incomingDownload: $('incomingDownload'),
    incomingClose: $('incomingClose'),
    playlistPickerDialog: $('playlistPickerDialog'),
    playlistPickerTitle: $('playlistPickerTitle'),
    playlistPickerList: $('playlistPickerList'),
    playlistPickerName: $('playlistPickerName'),
    playlistPickerCreate: $('playlistPickerCreate'),
    playlistPickerClose: $('playlistPickerClose'),
    editDialog: $('editDialog'),
    editNote: $('editNote'),
    editStart: $('editStart'),
    editEnd: $('editEnd'),
    editFadeIn: $('editFadeIn'),
    editFadeOut: $('editFadeOut'),
    editStartLbl: $('editStartLbl'),
    editEndLbl: $('editEndLbl'),
    editFadeInLbl: $('editFadeInLbl'),
    editFadeOutLbl: $('editFadeOutLbl'),
    editPreview: $('editPreview'),
    editApply: $('editApply'),
    editExtend: $('editExtend'),
    editCut: $('editCut'),
    dlCover: $('dlCover'),
    dlMidi: $('dlMidi'),
    dlLicense: $('dlLicense'),
    editInstrumental: $('editInstrumental'),
    editClose: $('editClose'),
    editWave: $('editWave'),
    editZoom: $('editZoom'),
    editZoomLbl: $('editZoomLbl'),
    editZoomFit: $('editZoomFit'),
    editCustomPresets: $('editCustomPresets'),
    editPresetName: $('editPresetName'),
    editPresetSave: $('editPresetSave'),
    restoreReportDialog: $('restoreReportDialog'),
    restoreReportClose: $('restoreReportClose'),
    restoreReportSummary: $('restoreReportSummary'),
    restoreReportList: $('restoreReportList'),
    backupBanner: $('backupBanner'),
    backupBannerText: $('backupBannerText'),
    backupBannerNow: $('backupBannerNow'),
    backupBannerDismiss: $('backupBannerDismiss'),
    abDialog: $('abDialog'),
    abTitle: $('abTitle'),
    abTakes: $('abTakes'),
    abClose: $('abClose'),
    downloadMenu: $('downloadMenu'),
    dlWav: $('dlWav'),
    dlMp3: $('dlMp3'),
    dlMp4: $('dlMp4'),
    videoDialog: $('videoDialog'),
    videoTitle: $('videoTitle'),
    videoNote: $('videoNote'),
    videoFill: $('videoFill'),
    videoStatus: $('videoStatus'),
    videoCancelBtn: $('videoCancelBtn'),
    toast: $('toast'),
  });

  loadSettings();
  applyTheme();
  aiInit(); // load + retrain the taste model from persisted interactions
  await initDB();
  await migrateMembers(); // stamp pre-family songs/playlists as the owner's
  initFamily({
    onSwitch: async () => {
      // The voice picker follows the member: their saved preference, if any.
      state.createVoice = familyVoiceType() || state.createVoice || '';
      if (state.createVoice === 'mine' && !memberHasRecordedVoice()) state.createVoice = '';
      // Member switched: reload only their songs + playlists, then repaint.
      const all = await idbGetAll('songs');
      state.trash = all.filter((s) => s.deletedAt);
      state.songs = all.filter((s) => !s.deletedAt);
      state.playlists = (await idbGetAll('playlists')).sort((a, b) => b.createdAt - a.createdAt);
      state.justCreated = [...state.songs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
      if (!state.songs.find((s) => s.id === state.currentSongId)) {
        player.pause();
        state.currentSongId = null;
      }
      renderView();
    },
  });
  const allSongs = await idbGetAll('songs');
  // The voice picker follows the signed-in member's saved preference.
  state.createVoice = familyVoiceType() || state.createVoice || '';
  if (state.createVoice === 'mine' && !memberHasRecordedVoice()) state.createVoice = '';
  // Soft-deleted songs live in a side list, recoverable for 30 days.
  state.trash = allSongs.filter((s) => s.deletedAt);
  state.songs = allSongs.filter((s) => !s.deletedAt);
  await purgeExpiredTrash();
  state.playlists = (await idbGetAll('playlists')).sort((a, b) => b.createdAt - a.createdAt);
  // If auto-export is on but the stored folder is gone or unpermitted (e.g.
  // after a browser restart), tell the user early instead of failing silently.
  if (state.autoExport) {
    workspaceFolderStatus().then(({ handle, perm }) => {
      if (!handle || perm !== 'granted') {
        toast('Auto-export is on, but its folder needs re-selecting — open Settings.', 'error');
      }
    });
  }
  state.justCreated = [...state.songs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  // Last session's unfinished track? Offer to pick up where it stopped.
  // An in-app dialog, NOT confirm(): native modals hang embedded webviews
  // forever (nothing can ever answer them) and block the main thread.
  const resumed = readResumePosition();
  if (resumed) {
    const song = findSong(resumed.id);
    if (song && song.createdAt) {
      setTimeout(() => offerResumeDialog(resumed, song), 400);
    } else {
      clearResumePosition(); // song since deleted
    }
  }

  // Share dialog
  els.shareClose.addEventListener('click', () => els.shareDialog.close());
  els.shareCopy.addEventListener('click', copyShareLink);
  els.shareDialog.addEventListener('click', (e) => {
    if (e.target === els.shareDialog) els.shareDialog.close();
  });

  // Incoming (received) song dialog
  els.incomingClose.addEventListener('click', () => els.incomingDialog.close());
  els.incomingPlay.addEventListener('click', () => {
    const song = state.incoming[0];
    if (song) playSong(song.id);
  });
  els.incomingSave.addEventListener('click', () => {
    const song = state.incoming[0];
    if (song) saveDiscovery(song);
  });
  els.incomingDownload.addEventListener('click', () => {
    const song = state.incoming[0];
    if (song) downloadSong(song);
  });
  els.incomingDialog.addEventListener('click', (e) => {
    if (e.target === els.incomingDialog) els.incomingDialog.close();
  });

  // Playlist picker dialog
  els.playlistPickerClose.addEventListener('click', () => {
    els.playlistPickerDialog.close();
    pickerSong = null;
  });
  els.playlistPickerDialog.addEventListener('click', (e) => {
    if (e.target === els.playlistPickerDialog) {
      els.playlistPickerDialog.close();
      pickerSong = null;
    }
  });
  els.playlistPickerCreate.addEventListener('click', async () => {
    const pl = await createPlaylist(els.playlistPickerName.value);
    if (!pl) {
      toast('Give the playlist a name first.');
      return;
    }
    if (pickerSong) await setSongInPlaylist(pl, pickerSong.id, true);
    els.playlistPickerDialog.close();
    pickerSong = null;
    renderView();
    toast(`Playlist “${pl.name}” created.`);
  });

  // Audio editor dialog
  els.editClose.addEventListener('click', () => {
    els.editDialog.close(); // the 'close' listener below captures memory + queue
  });
  els.editDialog.addEventListener('click', (e) => {
    if (e.target === els.editDialog) {
      els.editDialog.close();
    }
  });
  // Closing the dialog (any way: ✕, Apply, Esc, outside click) remembers this
  // song's slider positions + zoom for next time, and hands the play queue
  // back from any edit preview so next/prev don't get stuck on the preview.
  els.editDialog.addEventListener('close', () => {
    saveEditMemory();
    if (state.preEditOrder && state.preEditOrder.length) {
      state.order = state.preEditOrder;
    }
    state.preEditOrder = null;
    editSong = null;
  });
  bindEditWaveDrag();

  // A/B compare dialog
  els.abClose.addEventListener('click', () => els.abDialog.close());
  els.abDialog.addEventListener('click', (e) => {
    if (e.target === els.abDialog) els.abDialog.close();
  });
  els.abDialog.addEventListener('close', closeAbCompare);
  // Keys A–E jump straight to that take while comparing (modal: these don't
  // reach the global shortcuts).
  els.abDialog.addEventListener('keydown', (e) => {
    if (!state.abCompare) return;
    const i = 'abcde'.indexOf(e.key.toLowerCase());
    if (i >= 0 && state.abCompare.ids[i]) {
      e.preventDefault();
      e.stopPropagation();
      switchAbTake(state.abCompare.ids[i]);
    }
  });
  // Zoom: higher = a tighter window, centered on the selection; Fit = whole song.
  els.editZoom.addEventListener('input', () => {
    const dur = editSong ? editSong.duration || editWaveData?.seconds || 0 : 0;
    if (dur > 0) {
      editZoomCenter = (editSec(+els.editStart.value, dur) + editSec(+els.editEnd.value, dur)) / 2 / dur;
    }
    editZoom = +els.editZoom.value;
    els.editZoomLbl.textContent = `×${editZoom}`;
    drawEditWave();
  });
  els.editZoomFit.addEventListener('click', () => {
    editZoom = 1;
    editZoomCenter = 0.5;
    els.editZoom.value = 1;
    els.editZoomLbl.textContent = '×1';
    drawEditWave();
  });
  els.editPresetSave.addEventListener('click', saveCurrentAsPreset);
  els.editPresetName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveCurrentAsPreset();
    }
  });
  [els.editStart, els.editEnd, els.editFadeIn, els.editFadeOut].forEach((s) => s.addEventListener('input', updateEditLabels));
  document.querySelectorAll('.preset-chip').forEach((btn) => {
    btn.addEventListener('click', () => applyEditPreset(btn.dataset.preset));
  });
  els.editPreview.addEventListener('click', previewEdit);
  els.editApply.addEventListener('click', applyEdit);
  els.editExtend.addEventListener('click', extendSong);
  els.editCut.addEventListener('click', cutSection);

  // Restore report dialog
  els.restoreReportClose.addEventListener('click', () => els.restoreReportDialog.close());
  els.restoreReportDialog.addEventListener('click', (e) => {
    if (e.target === els.restoreReportDialog) els.restoreReportDialog.close();
  });

  // Download menu (WAV / MP3 / MP4) on song cards
  els.dlWav.addEventListener('click', () => {
    const s = menuSong;
    closeDownloadMenu();
    if (s) downloadSong(s);
  });
  els.dlMp3.addEventListener('click', () => {
    const s = menuSong;
    closeDownloadMenu();
    if (s) downloadMp3(s);
  });
  els.dlMp4.addEventListener('click', () => {
    const s = menuSong;
    closeDownloadMenu();
    if (s) downloadVideo(s);
  });
  els.dlCover.addEventListener('click', () => {
    const s = menuSong;
    closeDownloadMenu();
    if (s) downloadCoverPng(s);
  });
  els.dlMidi.addEventListener('click', () => {
    const s = menuSong;
    closeDownloadMenu();
    if (s) downloadMidi(s);
  });
  els.dlLicense.addEventListener('click', () => {
    const s = menuSong;
    closeDownloadMenu();
    if (s) downloadLicense(s);
  });
  els.editInstrumental.addEventListener('click', () => {
    const s = editSong;
    els.editDialog.close(); // the 'close' listener captures memory + queue
    if (s) makeInstrumental(s);
  });
  els.downloadMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (menuSong && !e.target.closest('.dl-menu') && !e.target.closest('.cover-download')) closeDownloadMenu();
  });
  window.addEventListener('scroll', closeDownloadMenu, true);
  window.addEventListener('resize', closeDownloadMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDownloadMenu();
  });

  // Video-export dialog
  els.videoCancelBtn.addEventListener('click', () => {
    if (videoSource) {
      videoCancelled = true;
      try {
        videoSource.stop();
      } catch {
        /* already ended */
      }
    } else {
      els.videoDialog.close();
    }
  });
  els.videoDialog.addEventListener('click', (e) => {
    if (e.target === els.videoDialog && videoSource) {
      videoCancelled = true;
      try {
        videoSource.stop();
      } catch {
        /* already ended */
      }
    }
  });

  // Auto-backup reminder banner: one-click backup, or dismiss until the
  // next multiple of N new songs.
  els.backupBannerNow.addEventListener('click', () => {
    setView('workspace');
    backupLibrary();
  });
  els.backupBannerDismiss.addEventListener('click', () => {
    const r = state.backupReminder || (state.backupReminder = { every: 10, count: 0, remindedAt: 0 });
    r.remindedAt = r.count;
    saveSettings();
    refreshBackupBanner();
  });
  refreshBackupBanner();

  player.startVisualizer($('visualizer'));
  bindEvents();
  await buildExplore();
  renderView();

  // Open a shared song if the URL carries one (fresh load, or same-tab paste)
  const openSharedFromHash = () => {
    const shared = parseShareHash();
    if (shared) setTimeout(() => openIncoming(shared), 300);
  };
  openSharedFromHash();
  window.addEventListener('hashchange', openSharedFromHash);

  // Declarative hash→view routers — one row per hash namespace. Each entry
  // validates its value (unknown ids fall through) and may apply it to app
  // state BEFORE the view renders; the views themselves read nothing. The
  // anchor views (settings/workspace/learn) land on their section via
  // wireAnchorNav inside their render.
  const hashRouters = {
    settings: { valid: () => true },
    workspace: { valid: () => true },
    learn: { valid: (v) => LESSONS.some((l) => l.id === v) },
    library: {
      // renderLibrary validates categories/trash/playlists and falls back to all.
      valid: (v) => /^[a-z0-9-]+$/.test(v),
      apply: (v) => { state.libraryFilter = v; },
    },
    explore: {
      valid: (v) => STYLES.some((s) => s.category === v),
      apply: (v) => {
        state.exploreCat = v;
        const inCat = STYLES.filter((s) => s.category === v);
        const remembered = state.exploreGenreByCat[v];
        state.exploreGenre = remembered && inCat.some((s) => s.id === remembered) ? remembered : inCat[0].id;
      },
    },
  };
  const routeViewFromHash = () => {
    for (const [key, def] of Object.entries(hashRouters)) {
      const m = location.hash.match(new RegExp(`[#&]${key}=([^&]+)`));
      if (!m) continue;
      let val = m[1];
      try { val = decodeURIComponent(val); } catch {} // %xx in category names
      if (!def.valid(val)) continue;
      def.apply?.(val);
      if (state.view !== key) setView(key);
      return;
    }
  };
  routeViewFromHash();
  window.addEventListener('hashchange', routeViewFromHash);

  // A `#lesson=<id>` link lands straight on that lesson, highlighted.
  const openLessonFromHash = () => {
    const m = location.hash.match(/[#&]lesson=([A-Za-z0-9_-]+)/);
    if (!m) return;
    const lesson = LESSONS.find((l) => l.id === m[1]);
    if (!lesson) return;
    setView('learn');
    setTimeout(() => {
      const card = document.querySelector(`.lesson-card[data-lesson="${lesson.id}"]`);
      if (card) {
        // #content is the app's scroll container — scrollIntoView is a no-op
        // inside it, so scroll the container directly (same as the chip nav).
        scrollContentTo(card, 90);
        card.classList.add('lesson-flash');
        setTimeout(() => card.classList.remove('lesson-flash'), 1600);
        // Mirror the chip nav's active state for the landed lesson.
        document.querySelectorAll('.settings-anchor[data-section]').forEach((a) =>
          a.classList.toggle('active', a.dataset.section === lesson.id)
        );
      }
      toast(`Opened lesson: ${lesson.title}`);
    }, 300);
  };
  openLessonFromHash();
  window.addEventListener('hashchange', openLessonFromHash);
}

init().catch((err) => {
  console.error(err);
  toast('Failed to start: ' + err.message);
});
