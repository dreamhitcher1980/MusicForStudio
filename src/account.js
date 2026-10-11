// Account section — everything about you: sign-in state, your display name
// and contact email, and the family members sharing this device. Rendered as
// a panel inside the Settings view.
//
// Boundaries (architect pass):
//   family.js   — owns ALL member state and policy (validation, sessions,
//                 switching, dialog recipes). This module only calls its API.
//   voicerec.js — owns recorded-voice storage (clear).
//   main.js     — owns app-shell concerns: the toast, the voice recorder
//                 dialog, and re-rendering after member switches. Those are
//                 passed in as hooks, so nothing here imports main.js.

import { activeMember, getMembers, isUnlocked, memberVoiceLabel, memberVoiceType, memberHasRecordedVoice, setMemberVoice, setMemberProfile, switchToMember, signOut, openLogin, openAddMember } from './family.js';
import { clearVoiceSample } from './voicerec.js';
import { songCountsByMember } from './db.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = (sel) => document.getElementById(sel);

function memberRowHtml(member, { locked = false, active = false, songs = 0 } = {}) {
  return `
    <div class="acc-member${active ? ' active' : ''}">
      <span class="fam-avatar" style="background:${member.color}">${escapeHtml(member.avatar || member.name.charAt(0).toUpperCase())}</span>
      <span class="acc-member-meta">
        <b>${escapeHtml(member.name)}${member.role === 'owner' ? ' <small class="acc-owner-tag">owner</small>' : ''}</b>
        <small>voice: ${escapeHtml(memberVoiceLabel(member.id))}${member.email ? ` · ${escapeHtml(member.email)}` : ''}</small>
      </span>
      <span class="acc-songs" title="Songs in ${escapeHtml(member.name)}'s library">${songs} song${songs === 1 ? '' : 's'}</span>
      <span class="acc-member-state" title="${active ? 'Signed in' : locked ? 'Passcode required' : 'Unlocked on this device'}">${active ? '●' : locked ? '🔒' : '●'}</span>
      ${active ? '' : `<button class="ghost acc-switch" data-switch="${member.id}">Switch</button>`}
    </div>`;
}

// Compact summary for the Settings header: who is signed in right now.
// Passive (no actions) — the Account section below owns the buttons.
export function accountSummaryHtml() {
  const me = activeMember();
  const unlocked = isUnlocked(me?.id);
  if (me && unlocked) {
    return `
      <div class="acc-summary" title="Signed in as ${escapeHtml(me.name)}">
        <span class="fam-avatar" style="background:${me.color}">${escapeHtml(me.avatar || me.name.charAt(0).toUpperCase())}</span>
        <span class="acc-summary-name">${escapeHtml(me.name)}</span>
        <span class="acc-summary-pill on">signed in</span>
      </div>`;
  }
  return `
    <div class="acc-summary" title="No member library is unlocked">
      <span class="fam-avatar acc-summary-lock">🔒</span>
      <span class="acc-summary-name">Signed out</span>
      <span class="acc-summary-pill">locked</span>
    </div>`;
}

// Paint the Account section into `host` (a .field.ai-panel inside Settings).
// hooks: { toast(msg), repaint(), openVoiceRecorder() } — repaint() re-runs
// the Settings render so avatar/title/lists reflect edits.
export async function renderAccountSection(host, hooks = {}) {
  const toast = hooks.toast || (() => {});
  const repaint = hooks.repaint || (() => {});
  const openVoiceRecorder = hooks.openVoiceRecorder || (() => {});
  const unlocked = isUnlocked(activeMember()?.id);
  const me = activeMember();
  // Per-member song totals straight from the IndexedDB library (bypasses the
  // active-member read filter, so locked members' counts show too).
  const songCounts = await songCountsByMember();
  host.innerHTML = `
    ${unlocked && me ? `
    <div class="ai-head"><span>Your account</span><small>saved on this device only</small></div>
    <div class="acc-avatar-row">
      <span class="fam-avatar acc-avatar-big" style="background:${me.color}">${escapeHtml(me.avatar || me.name.charAt(0).toUpperCase())}</span>
      <label class="field-inline">Name
        <input type="text" id="accName" maxlength="24" value="${escapeHtml(me.name)}" spellcheck="false" />
      </label>
      <label class="field-inline">Email
        <input type="email" id="accEmail" value="${escapeHtml(me.email || '')}" placeholder="optional — stays on this device" spellcheck="false" />
      </label>
    </div>
    <p class="fam-error" id="accError" hidden></p>
    <div class="settings-row">
      <button class="ghost" id="accSave">Save changes</button>
      <button class="ghost" id="accSignOut">⇥ Lock & sign out</button>
    </div>` : `
    <div class="ai-head"><span>Sign in</span><small>passcode-protected libraries</small></div>
    <p class="settings-note">Each family member has a private library on this device. Pick your profile and enter the passcode to open it.</p>
    <div class="acc-login-list">
      ${getMembers().map((m) => `
        <button class="acc-login-row" data-signin="${m.id}">
          <span class="fam-avatar" style="background:${m.color}">${escapeHtml(m.avatar || m.name.charAt(0).toUpperCase())}</span>
          <span class="acc-member-meta"><b>${escapeHtml(m.name)}</b><small>${m.role === 'owner' ? 'Owner' : 'Family member'}${m.email ? ` · ${escapeHtml(m.email)}` : ''}</small></span>
          <span class="acc-member-state">🔒</span>
        </button>`).join('')}
    </div>
    <div class="settings-row">
      <button class="cta" id="accOpenLogin">🔒 Sign in…</button>
    </div>`}

    <div class="acc-subhead"><span>Your singing voice</span><small>used for this member's songs</small></div>
    <label class="field-inline">Voice
      <select id="accVoice">
        <option value=""${!(me && me.voice) ? ' selected' : ''}>Style default</option>
        <option value="female"${me && me.voice === 'female' ? ' selected' : ''}>Female</option>
        <option value="male"${me && me.voice === 'male' ? ' selected' : ''}>Male</option>
        <option value="off"${me && me.voice === 'off' ? ' selected' : ''}>Instrumental</option>
      </select>
    </label>
    <div class="settings-row">
      <button class="ghost" id="accVoiceRec">🎙 ${me && memberHasRecordedVoice() ? 'Re-record your voice' : 'Record your voice'}</button>
      ${me && memberHasRecordedVoice() ? '<button class="ghost" id="accVoiceDel">Remove recording</button>' : ''}
    </div>
    <p class="settings-note">Songs made by you sing with this member's voice — pick a synth type, or record ~3s of your real voice and the engine will use that instead.</p>

    <div class="acc-subhead"><span>Family members</span><small>${getMembers().length} on this device</small></div>
    <div class="acc-member-list">
      ${getMembers().map((m) => memberRowHtml(m, { locked: !isUnlocked(m.id), active: !!me && m.id === me.id && unlocked, songs: songCounts[m.id] || 0 })).join('')}
    </div>
    <div class="settings-row">
      <button class="ghost" id="accAddMember">＋ New family member</button>
    </div>
    <p class="settings-note">Members are referenced, never merged — switching profiles swaps the whole library, playlists and trash, but nothing is copied or lost.</p>
  `;

  if (unlocked && me) {
    $('accSave').addEventListener('click', () => {
      const err = $('accError');
      err.hidden = true;
      // family.js owns all member-name/email validation; surface its verdict.
      const res = setMemberProfile(me.id, { name: $('accName').value.trim(), email: $('accEmail').value.trim() });
      if (res && res.error) {
        err.textContent = res.error;
        err.hidden = false;
        return;
      }
      repaint(); // re-render so the avatar, title and lists reflect the change
      toast(`Account updated — hi, ${res.member.name}.`);
    });
    $('accSignOut').addEventListener('click', () => {
      signOut();
      openLogin();
      repaint();
      toast('Signed out — every library is locked.');
    });
    $('accVoice').value = memberVoiceType() || '';
    $('accVoice').addEventListener('change', () => {
      setMemberVoice($('accVoice').value);
      toast('Voice saved for your songs.');
    });
    $('accVoiceRec').addEventListener('click', () => openVoiceRecorder());
    const del = $('accVoiceDel');
    if (del) del.addEventListener('click', () => { clearVoiceSample(); toast('Recording removed — back to the synth voice.'); repaint(); });
  } else {
    host.querySelectorAll('[data-signin]').forEach((row) => {
      row.addEventListener('click', () => openLogin(row.dataset.signin));
    });
    $('accOpenLogin').addEventListener('click', () => openLogin());
  }
  $('accAddMember').addEventListener('click', () => openAddMember());
  host.querySelectorAll('[data-switch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await switchToMember(btn.dataset.switch); // opens login when locked, swaps when unlocked
      repaint(); // onSwitch already repainted the library
      const id = btn.dataset.switch;
      const m = getMembers().find((x) => x.id === id);
      if (m && isUnlocked(id) && activeMember()?.id === id) toast(`Switched to ${m.name}.`);
    });
  });
}
