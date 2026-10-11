// Family accounts for MusicForStudio.
//
// Each family member gets their own passcode-protected library: songs,
// playlists, and the trash are filtered per member at the db.js layer, so the
// rest of the app doesn't need to know. The taste engine and app settings stay
// device-wide by design.
//
// Storage:
//   mfs.members.v1   — member records (id, name, optional email, hashed passcode, color, avatar)
//   mfs.session.v1   — which members are currently unlocked on this device
//   mfs.activeMember — owned by db.js (via setActiveMember)
//
// Passcodes are hashed (FNV-1a, same scheme as VidMusForLive) and never stored
// in plain text. Everything stays on this device.

import { setActiveMember, getActiveMember } from './db.js';
import { hashSeed } from './gen.js';
import { getVoiceSample } from './voicerec.js';

const MEMBERS_KEY = 'mfs.members.v1';
const SESSION_KEY = 'mfs.session.v1';
const OWNER_DEFAULT_PASSCODE = '1234';
const OWNER_DISPLAY_NAME = 'DreamHitcherS';

const COLORS = ['#a855f7', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#14b8a6'];

export function hashPasscode(value) {
  const input = String(value || '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 'h1:' + (hash >>> 0).toString(16).padStart(8, '0');
}

function passcodeMatches(member, input) {
  const stored = member && member.passcode;
  if (!stored) return false;
  if (String(stored).startsWith('h1:')) return String(stored) === hashPasscode(input);
  return String(stored) === String(input); // legacy plain — upgraded on next save
}

// Optional account emails are stored trimmed and only when they plausibly look
// like an address; an empty/blank value normalizes to '' (meaning "none").
function normalizeEmail(value) {
  const v = String(value || '').trim();
  return v && /^\S+@\S+\.\S+$/.test(v) ? v : '';
}

function loadMembers() {
  try {
    const list = JSON.parse(localStorage.getItem(MEMBERS_KEY) || '[]');
    if (Array.isArray(list) && list.length) {
      // One-time rename: the owner record originally shipped with the default
      // name "Owner" — adopt the studio's chosen name while keeping the
      // passcode, color, session and id exactly as they were.
      let changed = false;
      list.forEach((m) => {
        if (m.role === 'owner' && m.name === 'Owner') {
          m.name = OWNER_DISPLAY_NAME;
          if (!m.avatar || m.avatar === 'O') m.avatar = 'D';
          changed = true;
        }
      });
      if (changed) localStorage.setItem(MEMBERS_KEY, JSON.stringify(list));
      return list;
    }
  } catch { /* reseed below */ }
  const owner = { id: 'me', name: OWNER_DISPLAY_NAME, passcode: hashPasscode(OWNER_DEFAULT_PASSCODE), color: COLORS[0], avatar: 'D', role: 'owner', createdAt: Date.now() };
  localStorage.setItem(MEMBERS_KEY, JSON.stringify([owner]));
  return [owner];
}

function saveMembers(list) {
  localStorage.setItem(MEMBERS_KEY, JSON.stringify(list));
}

let members = [];

export function getMembers() {
  return members;
}

export function memberById(id) {
  return members.find((m) => m.id === id) || null;
}

export function activeMember() {
  return memberById(getActiveMember()) || members[0];
}

function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    return { unlocked: Array.isArray(s.unlocked) ? s.unlocked : [] };
  } catch {
    return { unlocked: [] };
  }
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function isUnlocked(id) {
  return getSession().unlocked.includes(id);
}

function markUnlocked(id) {
  const session = getSession();
  session.unlocked = [...new Set([...session.unlocked, id])];
  saveSession(session);
}

export function signOut() {
  saveSession({ unlocked: [] });
  setActiveMember(members[0] ? members[0].id : 'me');
}

// ---------------------------------------------------------------------------
// Per-member voice: each member gets a deterministic vocal timbre (derived
// from their id) plus a preferred voice type for their songs. The local engine
// shapes every vocal layer with it — in songs and in the videos rendered from
// them — so a family member's music is recognizably theirs.
// ---------------------------------------------------------------------------

export function memberVoiceSig(id) {
  const m = memberById(id || getActiveMember());
  return m ? (hashSeed('vox|' + m.id) >>> 0) : null;
}

export function memberVoiceType() {
  const m = memberById(getActiveMember());
  return (m && m.voice) || '';
}

export function setMemberVoice(type) {
  const m = memberById(getActiveMember());
  if (!m) return;
  m.voice = ['female', 'male', 'off', 'mine', ''].includes(type) ? type : '';
  saveMembers(members);
}

// Optional contact email — purely local account info. It is shown on the
// login/menu lists so family members can tell their profiles apart, and it
// never leaves the device (there is no server to send it to).
export function memberEmail(id) {
  const m = memberById(id || getActiveMember());
  return (m && m.email) || '';
}

export function setMemberEmail(email) {
  const m = memberById(getActiveMember());
  if (!m) return;
  m.email = normalizeEmail(email);
  saveMembers(members);
}

// Update a member's display name and/or optional email (used by the Account
// tab). This is the single validation owner for member names/emails — callers
// surface { error } and never pre-validate. Returns { member } on success.
export function setMemberProfile(id, { name, email } = {}) {
  const m = memberById(id);
  if (!m) return { error: 'Member not found.' };
  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { error: 'Give the member a name.' };
    if (members.some((o) => o.id !== m.id && o.name.toLowerCase() === trimmed.toLowerCase())) {
      return { error: 'That name is taken by another member.' };
    }
    m.name = trimmed;
  }
  if (email !== undefined) {
    const raw = String(email || '').trim();
    if (raw && !normalizeEmail(raw)) return { error: "That email doesn't look right — fix it or leave it empty." };
    m.email = normalizeEmail(raw);
  }
  saveMembers(members);
  updateChip();
  return { member: m };
}

// Switch to another member from the Account tab: unlocks-aware — shows the
// login dialog when their library is still locked, otherwise swaps the active
// profile (and fires the app-wide library reload via the onSwitch callback).
export async function switchToMember(id) {
  const m = memberById(id);
  if (!m) return;
  if (!isUnlocked(id)) {
    openLogin(id);
    return;
  }
  setActiveMember(id);
  updateChip();
  await afterMemberChange();
}

export function memberVoiceLabel(id) {
  const m = memberById(id || getActiveMember());
  if (!m) return '';
  if (getVoiceSample(m.id)) return 'own recorded voice';
  const type = m.voice === 'female' ? 'female vocal' : m.voice === 'male' ? 'male vocal' : m.voice === 'off' ? 'instrumental' : 'style default';
  return type;
}

// ---------------------------------------------------------------------------
// Per-member RECORDED voice: a member can record ~3s of their real voice; the
// analysis profile lives in localStorage (via voicerec.js) and the raw audio in
// IndexedDB. When set, their songs' lead vocals are sung by the recording
// itself instead of the synthesized voice.
// ---------------------------------------------------------------------------

export function memberHasRecordedVoice(id = null) {
  return !!getVoiceSample(id || getActiveMember());
}

export function addMember(name, passcode, email) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { error: 'Give the member a name.' };
  if (members.some((m) => m.name.toLowerCase() === trimmed.toLowerCase())) return { error: 'That name is taken.' };
  const code = String(passcode || '').trim();
  if (code.length < 4) return { error: 'Passcode must be at least 4 characters.' };
  const rawEmail = String(email || '').trim();
  const cleanEmail = normalizeEmail(rawEmail);
  if (rawEmail && !cleanEmail) return { error: "That email doesn't look right — fix it or leave it empty." };
  const member = {
    id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: trimmed,
    email: cleanEmail,
    passcode: hashPasscode(code),
    color: COLORS[members.length % COLORS.length],
    avatar: trimmed.charAt(0).toUpperCase(),
    role: 'member',
    createdAt: Date.now(),
  };
  members.push(member);
  saveMembers(members);
  return { member };
}

// ---------------------------------------------------------------------------
// UI — account chip in the top bar, family menu, login and add-member dialogs
// ---------------------------------------------------------------------------

let onSwitchCallback = null;
let chipOpen = false;

export function onFamilySwitch(cb) {
  onSwitchCallback = cb;
}

async function afterMemberChange() {
  if (onSwitchCallback) await onSwitchCallback();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function memberRowHtml(member, lockedHint) {
  return `<button class="fam-row" data-fam-pick="${member.id}">
    <span class="fam-avatar" style="background:${member.color}">${escapeHtml(member.avatar || member.name.charAt(0).toUpperCase())}</span>
    <span class="fam-row-meta"><b>${escapeHtml(member.name)}</b><small>${member.role === 'owner' ? 'Owner' : 'Family member'} · voice: ${escapeHtml(memberVoiceLabel(member.id))}${member.email ? ` · ${escapeHtml(member.email)}` : ''}${lockedHint && !isUnlocked(member.id) ? ' · locked' : ''}</small></span>
    ${isUnlocked(member.id) ? '<span class="fam-unlock" title="Unlocked">●</span>' : '<span class="fam-lock" title="Passcode required">🔒</span>'}
  </button>`;
}

function ensureDialogs() {
  if (document.querySelector('#famLogin')) return;
  const login = document.createElement('dialog');
  login.id = 'famLogin';
  login.className = 'fam-dialog';
  login.innerHTML = `
    <div class="fam-dialog-icon">🔒</div>
    <h2>Who's listening?</h2>
    <p class="fam-hint">Each family member has a private library — pick a name and enter the passcode.</p>
    <div class="fam-list" id="famLoginList"></div>
    <form id="famLoginForm" novalidate>
      <input id="famPasscode" type="password" inputmode="numeric" autocomplete="off" placeholder="Passcode" />
      <input id="famEmail" type="email" autocomplete="email" spellcheck="false" placeholder="Email (optional — saved to this account)" />
      <p class="fam-error" id="famError" hidden></p>
      <div class="fam-actions">
        <button type="button" class="ghost" id="famAddLink">＋ New family member</button>
        <button type="submit" class="cta" id="famSignIn">Sign in</button>
      </div>
    </form>`;
  document.body.appendChild(login);

  const add = document.createElement('dialog');
  add.id = 'famAdd';
  add.className = 'fam-dialog';
  add.innerHTML = `
    <div class="fam-dialog-icon">✨</div>
    <h2>New family member</h2>
    <p class="fam-hint">They get their own private library, protected by their passcode.</p>
    <form id="famAddForm" novalidate>
      <label class="fam-field"><span>Name</span><input id="famAddName" maxlength="24" autocomplete="off" placeholder="e.g. Alex" /></label>
      <label class="fam-field"><span>Email (optional)</span><input id="famAddEmail" type="email" autocomplete="email" spellcheck="false" placeholder="name@example.com — stays on this device" /></label>
      <label class="fam-field"><span>Passcode</span><input id="famAddPass" type="password" inputmode="numeric" autocomplete="off" placeholder="At least 4 characters" /></label>
      <label class="fam-field"><span>Repeat passcode</span><input id="famAddPass2" type="password" inputmode="numeric" autocomplete="off" placeholder="Same again" /></label>
      <p class="fam-error" id="famAddError" hidden></p>
      <div class="fam-actions">
        <button type="button" class="ghost" id="famAddCancel">Cancel</button>
        <button type="submit" class="cta">Create member</button>
      </div>
    </form>`;
  document.body.appendChild(add);
}

function renderLoginList(selectedId) {
  const list = document.querySelector('#famLoginList');
  if (!list) return;
  list.innerHTML = members.map((m) => memberRowHtml(m, false)).join('');
  list.querySelectorAll('[data-fam-pick]').forEach((btn) => {
    btn.onclick = () => {
      loginSelected = btn.dataset.famPick;
      list.querySelectorAll('.fam-row').forEach((r) => r.classList.toggle('selected', r.dataset.famPick === loginSelected));
      const m = memberById(loginSelected);
      const mSel = memberById(loginSelected);
      const emailInput = document.querySelector('#famEmail');
      if (emailInput) emailInput.value = (mSel && mSel.email) || '';
      setActiveMember(m.id);
      updateChip();
      setTimeout(() => document.querySelector('#famPasscode')?.focus(), 0);
    };
  });
  const sel = selectedId || loginSelected;
  if (sel) list.querySelector(`[data-fam-pick="${sel}"]`)?.classList.add('selected');
}

let loginSelected = null;

export function openLogin(memberId) {
  ensureDialogs();
  loginSelected = memberId || (isUnlocked(getActiveMember()) ? getActiveMember() : members[0].id);
  const dialog = document.querySelector('#famLogin');
  const err = document.querySelector('#famError');
  err.hidden = true;
  document.querySelector('#famPasscode').value = '';
  const selMember = memberById(loginSelected);
  document.querySelector('#famEmail').value = (selMember && selMember.email) || '';
  renderLoginList(loginSelected);
  updateChip();
  if (!dialog.open) dialog.showModal();
}

function closeLogin() {
  document.querySelector('#famLogin')?.close();
}

function bindFamilyUI() {
  ensureDialogs();
  const login = document.querySelector('#famLogin');
  document.querySelector('#famLoginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const member = memberById(loginSelected) || members[0];
    const code = document.querySelector('#famPasscode').value;
    const err = document.querySelector('#famError');
    if (!passcodeMatches(member, code)) {
      err.textContent = `Incorrect passcode for ${member.name}.`;
      err.hidden = false;
      return;
    }
    // Upgrade legacy plain-text passcodes to the hash on first successful login.
    if (!String(member.passcode).startsWith('h1:')) {
      member.passcode = hashPasscode(code);
      saveMembers(members);
    }
    // Optional email: whatever is in the field is saved to this account
    // (clearing the field clears the email). Validated lightly, stored locally.
    const emailInput = document.querySelector('#famEmail');
    const rawEmail = emailInput ? String(emailInput.value || '').trim() : '';
    const cleanEmail = normalizeEmail(rawEmail);
    if (rawEmail && !cleanEmail) {
      err.textContent = "That email doesn't look right — fix it or leave it empty.";
      err.hidden = false;
      return;
    }
    if (cleanEmail !== (member.email || '')) {
      member.email = cleanEmail;
      saveMembers(members);
    }
    markUnlocked(member.id);
    setActiveMember(member.id);
    err.hidden = true;
    closeLogin();
    updateChip();
    afterMemberChange();
  });
  document.querySelector('#famAddLink').addEventListener('click', () => {
    document.querySelector('#famAddError').hidden = true;
    document.querySelector('#famAddForm').reset();
    document.querySelector('#famAdd').showModal();
  });

  const addForm = document.querySelector('#famAddForm');
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = document.querySelector('#famAddError');
    const pass = document.querySelector('#famAddPass').value;
    if (pass !== document.querySelector('#famAddPass2').value) {
      err.textContent = 'Passcodes did not match.';
      err.hidden = false;
      return;
    }
    const res = addMember(document.querySelector('#famAddName').value, pass, document.querySelector('#famAddEmail').value);
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      return;
    }
    document.querySelector('#famAdd').close();
    renderLoginList(res.member.id);
    loginSelected = res.member.id;
    setActiveMember(res.member.id);
    updateChip();
    toastSafe(`Welcome, ${res.member.name} — this is your library now. Sign-in passcode set.`);
  });
  document.querySelector('#famAddCancel').addEventListener('click', () => document.querySelector('#famAdd').close());
}

function toastSafe(msg, kind) {
  // main.js owns the toast; family.js uses the same #toast element directly.
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastSafe._t);
  toastSafe._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function updateChip() {
  const chip = document.querySelector('#accountChip');
  if (!chip) return;
  const m = activeMember();
  chip.innerHTML = `<span class="fam-avatar" style="background:${m.color}">${escapeHtml(m.avatar || m.name.charAt(0).toUpperCase())}</span><span class="fam-chip-name">${escapeHtml(m.name)}</span>`;
  chip.title = isUnlocked(m.id) ? `${m.name}'s library` : `${m.name}'s library — locked`;
}

function toggleMenu() {
  if (chipOpen) return closeMenu();
  const chip = document.querySelector('#accountChip');
  if (!chip) return;
  chipOpen = true;
  const menu = document.createElement('div');
  menu.id = 'famMenu';
  menu.innerHTML = `
    ${members.map((m) => memberRowHtml(m, true)).join('')}
    <div class="fam-menu-sep"></div>
    <button class="fam-row" id="famMenuAdd"><span class="fam-avatar fam-avatar-add">＋</span><span class="fam-row-meta"><b>New family member</b><small>own passcode & library</small></span></button>
    <button class="fam-row" id="famMenuSignOut"><span class="fam-avatar fam-avatar-add">⇥</span><span class="fam-row-meta"><b>Sign out</b><small>lock every member</small></span></button>`;
  document.body.appendChild(menu);
  const r = chip.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 8) + 'px';
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  menu.querySelectorAll('[data-fam-pick]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.famPick;
      closeMenu();
      if (id === getActiveMember() && isUnlocked(id)) return; // already here
      if (!isUnlocked(id)) {
        openLogin(id);
      } else {
        setActiveMember(id);
        updateChip();
        afterMemberChange();
      }
    };
  });
  menu.querySelector('#famMenuAdd').onclick = () => openAddMember();
  menu.querySelector('#famMenuSignOut').onclick = () => { closeMenu(); signOut(); openLogin(); toastSafe('Signed out — every library is locked.'); };
  setTimeout(() => document.addEventListener('click', menuOutside, { once: true }), 0);
}

// Open the New-family-member dialog from any entry point (chip menu, Account
// tab): it lives inside the login dialog, so open that first, then its link.
export function openAddMember() {
  closeMenu();
  openLogin(getActiveMember());
  setTimeout(() => document.querySelector('#famAddLink')?.click(), 60);
}

function menuOutside(e) {
  if (!e.target.closest('#famMenu') && !e.target.closest('#accountChip')) closeMenu();
  else document.addEventListener('click', menuOutside, { once: true });
}

function closeMenu() {
  chipOpen = false;
  document.querySelector('#famMenu')?.remove();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initFamily({ onSwitch } = {}) {
  members = loadMembers();
  // Heal: active member must exist (e.g. storage cleared elsewhere)
  if (!memberById(getActiveMember())) setActiveMember(members[0].id);
  onFamilySwitch(onSwitch);
  bindFamilyUI();
  const chip = document.querySelector('#accountChip');
  if (chip) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    updateChip();
  }
  // Fresh page load: if the active member isn't unlocked, ask for the passcode.
  if (!isUnlocked(getActiveMember())) openLogin(getActiveMember());
}
