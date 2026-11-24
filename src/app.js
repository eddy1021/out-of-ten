/**
 * Main UI & state controller for "Out of Ten".
 * Cleanly supports both Local Multi-Tab Demo and Online Firebase RTDB transports.
 */

import { FIREBASE_CONFIG as FILE_FIREBASE_CONFIG } from '../config.js';
import {
  AVATAR_COLORS,
  MAX_NAME_LEN,
  MAX_SCORE,
  MAX_TOPIC_LEN,
  MIN_SCORE,
  PROMPT_CATEGORIES,
  buildShareSummary,
  computeRoundResults,
  describeRoundRules,
  formatDelta,
  formatRoomCode,
  formatScore,
  getInitials,
  getTargetsForVoter,
  isValidRoomCode,
  isValidScore,
  normalizeRoomCode,
  pickRandomPrompt,
  sanitizeName,
  sanitizeTopic,
} from './engine.js';
import {
  FirebaseTransport,
  isValidFirebaseConfig,
  loadStoredFirebaseConfig,
  parseFirebaseConfigInput,
  saveStoredFirebaseConfig,
} from './transport-firebase.js';
import { LocalTransport } from './transport-local.js';
import { canNativeShareFile, renderRoundShareImage } from './share-image.js';
import {
  ICONS,
  closeModal,
  confirmDialog,
  copyToClipboard,
  esc,
  openModal,
  renderAvatar,
  showToast,
} from './ui.js';

const PROFILE_STORAGE_KEY = 'outoften:profile';
const ACTIVE_ROOM_SESSION_KEY = 'outoften:active-room';

const appState = {
  transport: null,
  uid: null,
  configSource: 'none', // 'file' | 'browser' | 'none'
  activeConfig: null,

  // Entry profile
  profile: loadProfile(),
  landingTab: 'create', // 'create' | 'join'
  joinCodeInput: '',
  entryError: '',
  busy: false,

  // Active room
  roomCode: null,
  unsubRoom: null,
  snapshot: null,
  lastRenderedViewKey: null,

  // Host lobby draft state (local so typing doesn't jump cursor)
  draftTopic: '',
  draftTopicTimer: null,
  nextRoundTopic: '',

  // Active rating ballot draft (uid -> integer 0..10)
  activeRatingRoundId: null,
  draftScores: {},
  editingSubmitted: false,
  autoRevealTriggeredFor: null,
  submittingBallot: false,

  // Results UI toggles
  sortBy: 'overall', // 'overall' | 'group' | 'delta'
  expandedRows: new Set(),
};

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        name: sanitizeName(parsed.name || ''),
        colorIndex: Number.isInteger(parsed.colorIndex)
          ? Math.max(0, Math.min(AVATAR_COLORS.length - 1, parsed.colorIndex))
          : 0,
      };
    }
  } catch {
    // Ignore storage errors
  }
  return {
    name: '',
    colorIndex: Math.floor(Math.random() * AVATAR_COLORS.length),
  };
}

function saveProfile() {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(appState.profile));
  } catch {
    // Non-fatal
  }
}

function getRoomInviteUrl(code) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', normalizeRoomCode(code));
  return url.toString();
}

function syncUrlRoomParam(code) {
  const url = new URL(window.location.href);
  if (code) {
    url.searchParams.set('room', normalizeRoomCode(code));
  } else {
    url.searchParams.delete('room');
  }
  window.history.replaceState({}, '', url.toString());
}

function resolveInitialConfig() {
  if (isValidFirebaseConfig(FILE_FIREBASE_CONFIG)) {
    return { source: 'file', config: FILE_FIREBASE_CONFIG };
  }
  const stored = loadStoredFirebaseConfig();
  if (stored) {
    return { source: 'browser', config: stored };
  }
  return { source: 'none', config: null };
}

async function initTransport(configObj = null, source = 'none') {
  if (appState.unsubRoom) {
    appState.unsubRoom();
    appState.unsubRoom = null;
  }
  if (appState.transport) {
    appState.transport.dispose();
    appState.transport = null;
  }

  if (configObj && isValidFirebaseConfig(configObj)) {
    const fb = new FirebaseTransport(configObj);
    try {
      const uid = await fb.init();
      appState.transport = fb;
      appState.uid = uid;
      appState.activeConfig = configObj;
      appState.configSource = source;
      updateConnectionPill();
      return;
    } catch (err) {
      fb.dispose();
      console.error('Firebase init failed, falling back to Local Demo:', err);
      showToast(
        `Could not connect to Firebase (${err.message || 'check config'}). Using Local Demo mode.`,
        'error',
        4500
      );
    }
  }

  const local = new LocalTransport();
  appState.uid = await local.init();
  appState.transport = local;
  appState.activeConfig = null;
  appState.configSource = 'none';
  updateConnectionPill();
}

function updateConnectionPill() {
  const pill = document.getElementById('btn-connection-status');
  const label = document.getElementById('conn-pill-label');
  if (!pill || !label) return;
  const isOnline = appState.transport && appState.transport.mode === 'firebase';
  pill.classList.toggle('is-online', Boolean(isOnline));
  // On phones keep connection label crisp & ultra-compact inside a room so header stays one row
  if (appState.roomCode && window.innerWidth <= 460) {
    label.textContent = isOnline ? 'Online' : 'Demo';
  } else {
    label.textContent = isOnline ? 'Online · Firebase' : 'Local Demo';
  }
}

function renderTopbarRoomActions() {
  updateConnectionPill();
  const container = document.getElementById('topbar-actions');
  if (!container) return;

  // Preserve the connection pill and swap optional room controls beside it
  container.querySelectorAll('.room-top-item').forEach((el) => el.remove());

  if (appState.roomCode && appState.snapshot && appState.snapshot.exists) {
    const chip = document.createElement('span');
    chip.className = 'room-chip room-top-item';
    chip.textContent = formatRoomCode(appState.roomCode);
    chip.title = 'Current room code';
    container.prepend(chip);

    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'btn btn-ghost btn-sm room-top-item';
    leaveBtn.id = 'btn-top-leave';
    leaveBtn.textContent = 'Leave';
    leaveBtn.addEventListener('click', handleLeaveRoom);
    container.appendChild(leaveBtn);
  }
}

function getSortedMembers(membersMap = {}) {
  return Object.values(membersMap)
    .filter(Boolean)
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.name.localeCompare(b.name));
}

function isHost(snap) {
  return Boolean(snap && snap.meta && snap.meta.hostUid === appState.uid);
}

function getCurrentRound(snap) {
  if (!snap || !snap.meta || !snap.meta.currentRoundId || !snap.rounds) return null;
  return snap.rounds[snap.meta.currentRoundId] || null;
}

function getCompletedRounds(snap, excludeId = null) {
  if (!snap || !snap.rounds) return [];
  return Object.values(snap.rounds)
    .filter((r) => r && r.phase === 'results' && r.id !== excludeId)
    .sort((a, b) => (b.number || 0) - (a.number || 0));
}

function maybeAutoReveal(snap) {
  if (!isHost(snap)) return;
  if (!snap.meta || snap.meta.phase !== 'rating') return;
  const round = getCurrentRound(snap);
  if (!round || round.phase !== 'rating') return;

  const activeParticipantUids = Object.keys(round.playerIds || {}).filter(
    (uid) => snap.members && snap.members[uid]
  );
  if (activeParticipantUids.length === 0) return;

  const submittedMap = (snap.submitted && snap.submitted[round.id]) || {};
  const allSubmitted = activeParticipantUids.every((uid) => Boolean(submittedMap[uid]));

  if (allSubmitted && appState.autoRevealTriggeredFor !== round.id) {
    appState.autoRevealTriggeredFor = round.id;
    const roomCode = appState.roomCode;
    const roundId = round.id;
    // Defer by a microtask (not setTimeout) so backgrounded host tabs still reveal right away
    queueMicrotask(async () => {
      if (appState.roomCode !== roomCode) return;
      const latestRound = getCurrentRound(appState.snapshot);
      if (!latestRound || latestRound.id !== roundId || latestRound.phase !== 'rating') return;
      try {
        await appState.transport.revealRound(roomCode, roundId);
      } catch (err) {
        appState.autoRevealTriggeredFor = null;
        console.warn('Auto-reveal skipped:', err);
      }
    });
  }
}

function resetRatingDraftIfRoundChanged(round) {
  if (!round) {
    appState.activeRatingRoundId = null;
    appState.draftScores = {};
    appState.editingSubmitted = false;
    return;
  }
  if (appState.activeRatingRoundId !== round.id) {
    appState.activeRatingRoundId = round.id;
    appState.draftScores = {};
    appState.editingSubmitted = false;
    appState.expandedRows.clear();
    appState.sortBy = 'overall';
  }
}

function enterRoomSubscription(code) {
  if (appState.unsubRoom) {
    appState.unsubRoom();
    appState.unsubRoom = null;
  }
  appState.roomCode = normalizeRoomCode(code);
  try {
    sessionStorage.setItem(ACTIVE_ROOM_SESSION_KEY, appState.roomCode);
  } catch {
    // Non-fatal
  }
  syncUrlRoomParam(appState.roomCode);

  appState.unsubRoom = appState.transport.subscribeRoom(
    appState.roomCode,
    (snap) => {
      appState.snapshot = snap;
      if (!snap.exists) {
        const wasCode = appState.roomCode;
        exitRoomLocalState(false);
        showToast(`Room ${formatRoomCode(wasCode)} was closed by the host.`, 'neutral', 3500);
        render();
        return;
      }

      // If removed/kicked by host after joining
      if (snap.members && Object.keys(snap.members).length > 0 && !snap.members[appState.uid]) {
        exitRoomLocalState(false);
        showToast('You are no longer in that room.', 'error', 3500);
        render();
        return;
      }

      if (snap.meta.phase === 'rating') {
        const round = getCurrentRound(snap);
        resetRatingDraftIfRoundChanged(round);
        maybeAutoReveal(snap);
      } else if (snap.meta.phase === 'results') {
        const round = getCurrentRound(snap);
        if (round && appState.activeRatingRoundId !== round.id) {
          appState.activeRatingRoundId = round.id;
          appState.expandedRows.clear();
          appState.sortBy = 'overall';
        }
      }

      render();
    },
    (err) => {
      console.error('Room listener error:', err);
      showToast(err.message || 'Connection issue with room.', 'error', 3600);
    }
  );
}

function exitRoomLocalState(clearUrl = true) {
  if (appState.unsubRoom) {
    appState.unsubRoom();
    appState.unsubRoom = null;
  }
  appState.roomCode = null;
  appState.snapshot = null;
  appState.draftTopic = '';
  appState.nextRoundTopic = '';
  appState.activeRatingRoundId = null;
  appState.draftScores = {};
  appState.editingSubmitted = false;
  appState.autoRevealTriggeredFor = null;
  appState.lastRenderedViewKey = null;
  try {
    sessionStorage.removeItem(ACTIVE_ROOM_SESSION_KEY);
  } catch {
    // Ignore
  }
  if (clearUrl) {
    syncUrlRoomParam(null);
  }
  renderTopbarRoomActions();
}

/* ==========================================================================
   Main Render Dispatcher (preserves focused inputs during live snapshots)
   ========================================================================== */

function render() {
  const stage = document.getElementById('main-stage');
  if (!stage) return;

  renderTopbarRoomActions();

  if (!appState.roomCode || !appState.snapshot || !appState.snapshot.exists) {
    appState.lastRenderedViewKey = 'home';
    renderLanding(stage);
    return;
  }

  const snap = appState.snapshot;
  const phase = snap.meta.phase || 'lobby';

  if (phase === 'rating') {
    renderRating(stage, snap);
  } else if (phase === 'results') {
    renderResults(stage, snap);
  } else {
    renderLobby(stage, snap);
  }
}

/* ==========================================================================
   1. Landing / Create / Join Screen
   ========================================================================== */

function renderLanding(stage) {
  const isJoin = appState.landingTab === 'join';
  const isOnline = appState.transport && appState.transport.mode === 'firebase';
  const swatchButtons = AVATAR_COLORS.map((color, idx) => {
    const selected = appState.profile.colorIndex === idx;
    const initials = getInitials(appState.profile.name || 'You');
    return `
      <button
        type="button"
        class="swatch ${selected ? 'is-selected' : ''}"
        data-color-idx="${idx}"
        style="background:${color.bg};color:${color.fg}"
        aria-label="${esc(color.label)} badge color"
        aria-pressed="${selected}"
      >${selected ? esc(initials) : ''}</button>
    `;
  }).join('');

  const scalePreview = Array.from({ length: 11 }, (_, n) => {
    const isHot = n === 8;
    return `<span class="preview-pip ${isHot ? 'is-hot' : ''}" aria-hidden="true">${n}</span>`;
  }).join('');

  stage.innerHTML = `
    <div class="view-stack">
      <section class="hero-header">
        <h1 class="hero-title">Rate everyone, zero to ten.</h1>
        <p class="hero-sub">
          Jump in from any phone or laptop, discuss a topic together, rate the whole crew
          from <strong>0 to 10</strong>, and reveal the ranked averages — anonymous or open,
          with or without self-ratings.
        </p>
        <div class="landing-scale-preview" aria-hidden="true">
          ${scalePreview}
          <span class="preview-pip-note">whole numbers only</span>
        </div>
      </section>

      ${
        !isOnline
          ? `
          <div class="subtle-banner">
            <div>
              <strong>Local Demo Mode active.</strong> Play right now across multiple browser tabs or with simulated demo players.
              Want friends to join over different Wi-Fi / 5G?
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-banner-setup">
              Connect Firebase
            </button>
          </div>`
          : ''
      }

      <section class="card entry-card" aria-label="Start or join a room">
        <div class="entry-tabs" role="tablist">
          <button
            type="button"
            class="entry-tab ${!isJoin ? 'is-active' : ''}"
            id="tab-create"
            role="tab"
            aria-selected="${!isJoin}"
          >Create a Room</button>
          <button
            type="button"
            class="entry-tab ${isJoin ? 'is-active' : ''}"
            id="tab-join"
            role="tab"
            aria-selected="${isJoin}"
          >Join a Room</button>
        </div>

        <form class="entry-form" id="entry-form" novalidate>
          ${
            isJoin
              ? `
              <div class="field">
                <label class="field-label" for="input-room-code">
                  Room code
                  <span class="field-hint">6 letters &amp; numbers from your host</span>
                </label>
                <input
                  id="input-room-code"
                  name="roomCode"
                  class="input input-code"
                  type="text"
                  maxlength="7"
                  autocomplete="off"
                  autocapitalize="characters"
                  placeholder="K7M-9P2"
                  value="${esc(formatRoomCode(appState.joinCodeInput))}"
                  required
                />
              </div>`
              : ''
          }

          <div class="field">
            <label class="field-label" for="input-nickname">
              Your nickname
              <span class="field-hint">Shown inside the room only (max ${MAX_NAME_LEN})</span>
            </label>
            <input
              id="input-nickname"
              name="nickname"
              class="input"
              type="text"
              maxlength="${MAX_NAME_LEN}"
              autocomplete="nickname"
              placeholder="e.g. Alex"
              value="${esc(appState.profile.name)}"
              required
            />
          </div>

          <div class="field">
            <span class="field-label">Badge color</span>
            <div class="color-swatches" id="color-swatches">${swatchButtons}</div>
          </div>

          ${appState.entryError ? `<p class="text-error" role="alert" style="margin:0;">${esc(appState.entryError)}</p>` : ''}

          <button
            type="submit"
            class="btn btn-primary btn-full"
            id="btn-entry-submit"
            ${appState.busy ? 'disabled' : ''}
          >
            ${
              appState.busy
                ? isJoin ? 'Joining room…' : 'Creating room…'
                : isJoin ? 'Join Room' : 'Create Room & Get Link'
            }
          </button>
        </form>
      </section>

      <section class="how-strip" aria-label="How it works">
        <div class="how-step">
          <div class="how-num">01</div>
          <div class="how-title">No surprises</div>
          <p class="how-copy">The host chooses <strong>Anonymous or Open</strong> and <strong>Self-rating</strong> before the round locks in.</p>
        </div>
        <div class="how-step">
          <div class="how-num">02</div>
          <div class="how-title">Secret until reveal</div>
          <p class="how-copy">Every player picks whole numbers <strong>0–10</strong>. Scores stay sealed while anyone is still rating.</p>
        </div>
        <div class="how-step">
          <div class="how-num">03</div>
          <div class="how-title">Self vs. group</div>
          <p class="how-copy">See the ranked averages, biggest splits, and how your self-rating compares to everyone else’s.</p>
        </div>
      </section>
    </div>
  `;

  stage.querySelector('#tab-create').addEventListener('click', () => {
    appState.landingTab = 'create';
    appState.entryError = '';
    renderLanding(stage);
  });
  stage.querySelector('#tab-join').addEventListener('click', () => {
    appState.landingTab = 'join';
    appState.entryError = '';
    renderLanding(stage);
    const codeInput = stage.querySelector('#input-room-code');
    if (codeInput && !appState.joinCodeInput) codeInput.focus();
  });

  const bannerBtn = stage.querySelector('#btn-banner-setup');
  if (bannerBtn) bannerBtn.addEventListener('click', openFirebaseSetupModal);

  const nickInput = stage.querySelector('#input-nickname');
  nickInput.addEventListener('input', (e) => {
    appState.profile.name = e.target.value;
    const selectedSwatch = stage.querySelector('.swatch.is-selected');
    if (selectedSwatch) {
      selectedSwatch.textContent = getInitials(e.target.value || 'You');
    }
  });

  const codeInput = stage.querySelector('#input-room-code');
  if (codeInput) {
    codeInput.addEventListener('input', (e) => {
      const normalized = normalizeRoomCode(e.target.value);
      appState.joinCodeInput = normalized;
      e.target.value = formatRoomCode(normalized);
    });
  }

  stage.querySelectorAll('.swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.profile.colorIndex = Number(btn.dataset.colorIdx);
      saveProfile();
      stage.querySelectorAll('.swatch').forEach((other) => {
        const active = other === btn;
        other.classList.toggle('is-selected', active);
        other.setAttribute('aria-pressed', String(active));
        other.textContent = active ? getInitials(nickInput.value || 'You') : '';
      });
    });
  });

  stage.querySelector('#entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (appState.busy) return;
    const nick = sanitizeName(nickInput.value);
    if (!nick) {
      appState.entryError = 'Pick a nickname so your group knows who you are.';
      renderLanding(stage);
      stage.querySelector('#input-nickname').focus();
      return;
    }
    appState.profile.name = nick;
    saveProfile();

    if (appState.landingTab === 'join') {
      const code = normalizeRoomCode(appState.joinCodeInput);
      if (!isValidRoomCode(code)) {
        appState.entryError = 'Enter a valid 6-character room code (no 0, 1, I, L, or O).';
        renderLanding(stage);
        stage.querySelector('#input-room-code').focus();
        return;
      }
      appState.busy = true;
      appState.entryError = '';
      renderLanding(stage);
      try {
        const res = await appState.transport.joinRoom({
          code,
          name: nick,
          colorIndex: appState.profile.colorIndex,
        });
        appState.busy = false;
        enterRoomSubscription(res.code);
      } catch (err) {
        appState.busy = false;
        appState.entryError = err.message || 'Could not join room.';
        renderLanding(stage);
      }
      return;
    }

    appState.busy = true;
    appState.entryError = '';
    renderLanding(stage);
    try {
      const res = await appState.transport.createRoom({
        name: nick,
        colorIndex: appState.profile.colorIndex,
      });
      appState.busy = false;
      enterRoomSubscription(res.code);
    } catch (err) {
      appState.busy = false;
      appState.entryError = err.message || 'Could not create room.';
      renderLanding(stage);
    }
  });
}

/* ==========================================================================
   2. Lobby Screen (Pre-round Settings, Invite Link, Roster)
   ========================================================================== */

function renderLobby(stage, snap) {
  const host = isHost(snap);
  const meta = snap.meta;
  const members = getSortedMembers(snap.members);
  const settings = meta.settings || {
    allowSelfRating: true,
    visibility: 'anonymous',
    revealSelfInAnon: false,
  };
  const roundNum = (meta.roundCount || 0) + 1;
  const rules = describeRoundRules(settings);
  const isOpen = settings.visibility === 'open';
  const showBotsBar = appState.transport && appState.transport.supportsBots;
  const completedRounds = getCompletedRounds(snap);

  // Preserve caret & typed text if the host is actively typing the lobby topic input
  const activeEl = document.activeElement;
  const wasEditingTopic = activeEl && activeEl.id === 'input-lobby-topic';
  const caretStart = wasEditingTopic ? activeEl.selectionStart : null;
  const caretEnd = wasEditingTopic ? activeEl.selectionEnd : null;

  const topicValue = host ? appState.draftTopic : meta.draftTopic || '';
  const needMorePlayers = !settings.allowSelfRating && members.length < 2;
  const canStart = sanitizeTopic(topicValue).length > 0 && !needMorePlayers;

  const inviteUrl = getRoomInviteUrl(meta.code);

  const rosterHtml = members
    .map((m) => {
      const mIsHost = m.uid === meta.hostUid;
      const mIsMe = m.uid === appState.uid;
      return `
        <li class="roster-item">
          <div class="roster-person">
            ${renderAvatar(m.name, m.colorIndex)}
            <div style="min-width:0;">
              <div class="roster-name">${esc(m.name)}</div>
              <div class="roster-meta">
                ${mIsHost ? '<span class="badge badge-gold">Host</span>' : ''}
                ${mIsMe ? '<span class="badge badge-neutral">You</span>' : ''}
                ${m.isBot ? '<span class="badge badge-slate">Demo</span>' : ''}
              </div>
            </div>
          </div>
          ${
            host && !mIsMe
              ? `<div class="roster-actions">
                  ${
                    !m.isBot
                      ? `<button type="button" class="btn btn-ghost btn-xs" data-make-host="${esc(m.uid)}">Make host</button>`
                      : ''
                  }
                  <button type="button" class="btn btn-ghost btn-xs" data-kick="${esc(m.uid)}" aria-label="Remove ${esc(m.name)}">Remove</button>
                </div>`
              : ''
          }
        </li>
      `;
    })
    .join('');

  stage.innerHTML = `
    <div class="view-stack">
      <!-- Invite / Room Code Card -->
      <section class="card card-padded">
        <div class="share-strip">
          <div class="code-display">
            <span class="section-label">Room code ${meta.locked ? '· Locked' : ''}</span>
            <h1 class="code-digits" id="lobby-room-code">${esc(formatRoomCode(meta.code))}</h1>
          </div>
          <div class="share-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-link">
              ${ICONS.share}
              Copy Invite Link
            </button>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-copy-code">
              ${ICONS.copy}
              Copy Code
            </button>
            ${
              host
                ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-toggle-lock" title="Block new players from joining while you play">
                    ${meta.locked ? ICONS.lock : ICONS.unlock}
                    ${meta.locked ? 'Unlock' : 'Lock room'}
                  </button>`
                : ''
            }
          </div>
        </div>
        ${
          meta.locked
            ? `<p class="field-hint" style="margin:10px 0 0;">Room is locked — new players cannot join with this code until you unlock it.</p>`
            : ''
        }
      </section>

      <!-- Round Rules & Topic Card -->
      <section class="card card-padded stack-md" aria-label="Round setup">
        <div class="card-header-row" style="margin-bottom:0;">
          <div>
            <span class="section-label">Round ${roundNum} Setup</span>
            <h2 class="card-title">${host ? 'Pick a topic &amp; lock the rules' : 'Waiting for host to start'}</h2>
          </div>
          <span class="badge ${isOpen ? 'badge-gold' : 'badge-sage'}">
            ${isOpen ? ICONS.eye : ICONS.lock}
            ${isOpen ? 'Open' : 'Anonymous'}
          </span>
        </div>

        ${
          host
            ? `
            <div class="field">
              <label class="field-label" for="input-lobby-topic">
                Topic to rate (0–10)
                <span class="field-hint">Max ${MAX_TOPIC_LEN} chars</span>
              </label>
              <div class="topic-input-row">
                <input
                  id="input-lobby-topic"
                  class="input"
                  type="text"
                  maxlength="${MAX_TOPIC_LEN}"
                  placeholder="e.g. How good at basketball?"
                  value="${esc(topicValue)}"
                />
                <button type="button" class="btn btn-secondary" id="btn-random-prompt" title="Pick a random topic">
                  ${ICONS.shuffle}
                  Surprise me
                </button>
                <button type="button" class="btn btn-ghost" id="btn-browse-prompts" title="Browse topic ideas">
                  ${ICONS.list}
                  Ideas
                </button>
              </div>
            </div>`
            : `
            <div class="subtle-banner">
              <div>
                <div class="section-label" style="margin-bottom:3px;">Upcoming topic</div>
                <strong style="color:var(--ink-1);font-size:1rem;">
                  ${topicValue ? esc(topicValue) : 'Host is typing a topic…'}
                </strong>
              </div>
            </div>`
        }

        <div class="settings-grid">
          <div class="setting-block">
            <span class="field-label">1. Who gets rated?</span>
            <div class="segmented" role="group" aria-label="Self-rating setting">
              <button
                type="button"
                class="seg-btn ${settings.allowSelfRating ? 'is-active' : ''}"
                id="seg-self-on"
                ${host ? '' : 'disabled'}
                aria-pressed="${Boolean(settings.allowSelfRating)}"
              >
                <span class="seg-btn-title">Include self</span>
                <span class="seg-btn-sub">Rate all ${members.length} player${members.length === 1 ? '' : 's'}</span>
              </button>
              <button
                type="button"
                class="seg-btn ${!settings.allowSelfRating ? 'is-active' : ''}"
                id="seg-self-off"
                ${host ? '' : 'disabled'}
                aria-pressed="${!settings.allowSelfRating}"
              >
                <span class="seg-btn-title">Others only</span>
                <span class="seg-btn-sub">Skip yourself (${Math.max(0, members.length - 1)})</span>
              </button>
            </div>
          </div>

          <div class="setting-block">
            <span class="field-label">2. After reveal, votes are…</span>
            <div class="segmented" role="group" aria-label="Vote visibility setting">
              <button
                type="button"
                class="seg-btn tone-sage ${!isOpen ? 'is-active' : ''}"
                id="seg-vis-anon"
                ${host ? '' : 'disabled'}
                aria-pressed="${!isOpen}"
              >
                <span class="seg-btn-title">${ICONS.lock} Anonymous</span>
                <span class="seg-btn-sub">Hide who rated what</span>
              </button>
              <button
                type="button"
                class="seg-btn tone-gold ${isOpen ? 'is-active' : ''}"
                id="seg-vis-open"
                ${host ? '' : 'disabled'}
                aria-pressed="${isOpen}"
              >
                <span class="seg-btn-title">${ICONS.eye} Open</span>
                <span class="seg-btn-sub">Show names &amp; votes</span>
              </button>
            </div>
          </div>
        </div>

        ${
          settings.allowSelfRating && !isOpen
            ? `
            <label class="checkbox-row" ${host ? '' : 'style="cursor:default;opacity:0.9;"'}>
              <input
                type="checkbox"
                id="chk-reveal-self-anon"
                ${settings.revealSelfInAnon ? 'checked' : ''}
                ${host ? '' : 'disabled'}
              />
              <span>
                <strong>Also show everyone’s Self vs. Group gap publicly</strong><br />
                <span class="field-hint">
                  Off by default so self-ratings stay private to each person during anonymous rounds.
                </span>
              </span>
            </label>`
            : ''
        }

        <div class="rule-preview-box ${isOpen ? 'is-open' : ''}" role="note">
          <span class="rule-preview-icon">${isOpen ? ICONS.eye : ICONS.lock}</span>
          <div>
            <strong>Before rating starts (${esc(rules.visibilityLabel)} · ${esc(rules.selfLabel)}):</strong>
            ${esc(rules.headline)}
            Once started, these rules cannot be changed mid-round.
          </div>
        </div>

        ${
          host
            ? `
            <div class="row-between">
              <span class="text-muted" id="lobby-start-hint">
                ${
                  needMorePlayers
                    ? 'Add or invite at least 1 more player for "Others only" mode.'
                    : sanitizeTopic(topicValue)
                      ? `Ready for ${members.length} player${members.length === 1 ? '' : 's'}.`
                      : 'Enter a topic above or click “Surprise me”.'
                }
              </span>
              <button
                type="button"
                class="btn btn-primary"
                id="btn-start-round"
                ${canStart ? '' : 'disabled'}
              >
                Start Round ${roundNum} →
              </button>
            </div>`
            : `<p class="text-muted" style="margin:0;">You can see the exact vote rule above right now so there are no surprises once rating begins.</p>`
        }
      </section>

      <!-- Player Roster -->
      <section class="card card-padded stack-md" aria-label="Players in room">
        <div class="card-header-row" style="margin-bottom:0;">
          <h2 class="card-title">Players <span class="badge badge-neutral tabular" style="margin-left:4px;">${members.length}</span></h2>
          ${
            showBotsBar
              ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-open-friend-tab">Open Friend Tab ↗</button>`
              : ''
          }
        </div>
        <ul class="roster-list">${rosterHtml}</ul>
        ${
          showBotsBar && host
            ? `
            <div class="demo-strip">
              <span>Testing solo? Add simulated friends who vote 0–10 on command.</span>
              <div class="row-gap">
                <button type="button" class="btn btn-secondary btn-xs" id="btn-add-bot">
                  ${ICONS.plus} Add Demo Friend
                </button>
              </div>
            </div>`
            : ''
        }
      </section>

      ${completedRounds.length > 0 ? renderHistoryCard(snap, completedRounds) : ''}

      <div class="row-between" style="padding:2px 4px;">
        <button type="button" class="btn btn-ghost btn-sm" id="btn-lobby-leave">Leave room</button>
        ${
          host
            ? `<button type="button" class="btn btn-danger-soft btn-sm" id="btn-close-room">Close &amp; delete room</button>`
            : ''
        }
      </div>
    </div>
  `;

  // Restore focus to topic input seamlessly after reactive re-render
  if (wasEditingTopic) {
    const inp = stage.querySelector('#input-lobby-topic');
    if (inp) {
      inp.focus();
      if (caretStart !== null && caretEnd !== null) {
        try {
          inp.setSelectionRange(caretStart, caretEnd);
        } catch {
          // Ignore
        }
      }
    }
  }

  // Event bindings
  stage.querySelector('#btn-copy-link').addEventListener('click', async () => {
    const ok = await copyToClipboard(inviteUrl);
    showToast(ok ? 'Invite link copied!' : 'Could not copy link.', ok ? 'success' : 'error');
  });
  stage.querySelector('#btn-copy-code').addEventListener('click', async () => {
    const ok = await copyToClipboard(meta.code);
    showToast(ok ? `Code ${formatRoomCode(meta.code)} copied!` : 'Could not copy code.', ok ? 'success' : 'error');
  });

  const openTabBtn = stage.querySelector('#btn-open-friend-tab');
  if (openTabBtn) {
    openTabBtn.addEventListener('click', () => {
      window.open(inviteUrl, '_blank', 'noopener');
    });
  }

  stage.querySelector('#btn-lobby-leave').addEventListener('click', handleLeaveRoom);

  if (host) {
    const lockBtn = stage.querySelector('#btn-toggle-lock');
    lockBtn.addEventListener('click', async () => {
      try {
        await appState.transport.setRoomLocked(meta.code, !meta.locked);
        showToast(!meta.locked ? 'Room locked to current players.' : 'Room unlocked for new players.');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    const topicInput = stage.querySelector('#input-lobby-topic');
    const startBtn = stage.querySelector('#btn-start-round');
    const startHint = stage.querySelector('#lobby-start-hint');

    const updateStartEnabled = (val) => {
      const hasTopic = sanitizeTopic(val).length > 0;
      startBtn.disabled = !(hasTopic && !needMorePlayers);
      if (!needMorePlayers && startHint) {
        startHint.textContent = hasTopic
          ? `Ready for ${members.length} player${members.length === 1 ? '' : 's'}.`
          : 'Enter a topic above or click “Surprise me”.';
      }
    };

    const scheduleDraftSync = (text) => {
      clearTimeout(appState.draftTopicTimer);
      appState.draftTopicTimer = setTimeout(() => {
        if (appState.roomCode === meta.code) {
          appState.transport.updateDraftTopic(meta.code, text).catch(() => {});
        }
      }, 280);
    };

    topicInput.addEventListener('input', (e) => {
      appState.draftTopic = e.target.value;
      updateStartEnabled(appState.draftTopic);
      scheduleDraftSync(appState.draftTopic);
    });

    topicInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !startBtn.disabled) {
        e.preventDefault();
        startBtn.click();
      }
    });

    stage.querySelector('#btn-random-prompt').addEventListener('click', () => {
      const prompt = pickRandomPrompt(appState.draftTopic);
      appState.draftTopic = prompt;
      topicInput.value = prompt;
      updateStartEnabled(prompt);
      appState.transport.updateDraftTopic(meta.code, prompt).catch(() => {});
    });

    stage.querySelector('#btn-browse-prompts').addEventListener('click', () => {
      openPromptPickerModal((chosen) => {
        appState.draftTopic = chosen;
        topicInput.value = chosen;
        updateStartEnabled(chosen);
        appState.transport.updateDraftTopic(meta.code, chosen).catch(() => {});
      });
    });

    stage.querySelector('#seg-self-on').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { allowSelfRating: true }).catch((e) => showToast(e.message, 'error'))
    );
    stage.querySelector('#seg-self-off').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { allowSelfRating: false }).catch((e) => showToast(e.message, 'error'))
    );
    stage.querySelector('#seg-vis-anon').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { visibility: 'anonymous' }).catch((e) => showToast(e.message, 'error'))
    );
    stage.querySelector('#seg-vis-open').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { visibility: 'open' }).catch((e) => showToast(e.message, 'error'))
    );

    const revealSelfChk = stage.querySelector('#chk-reveal-self-anon');
    if (revealSelfChk) {
      revealSelfChk.addEventListener('change', (e) =>
        appState.transport
          .updateSettings(meta.code, { revealSelfInAnon: e.target.checked })
          .catch((err) => showToast(err.message, 'error'))
      );
    }

    startBtn.addEventListener('click', async () => {
      const topic = sanitizeTopic(appState.draftTopic);
      if (!topic) {
        showToast('Enter a topic first.', 'error');
        topicInput.focus();
        return;
      }
      startBtn.disabled = true;
      try {
        clearTimeout(appState.draftTopicTimer);
        await appState.transport.startRound(meta.code, { topic, settings });
        appState.draftTopic = '';
      } catch (err) {
        startBtn.disabled = false;
        showToast(err.message || 'Could not start round.', 'error');
      }
    });

    const addBotBtn = stage.querySelector('#btn-add-bot');
    if (addBotBtn) {
      addBotBtn.addEventListener('click', async () => {
        try {
          await appState.transport.addDemoBot(meta.code);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    stage.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetUid = btn.dataset.kick;
        const member = snap.members[targetUid];
        if (!member) return;
        const ok = await confirmDialog({
          title: `Remove ${member.name}?`,
          message: member.isBot
            ? `Remove demo player ${member.name} from the room?`
            : `${member.name} will be removed from the room (they can rejoin if the room isn't locked).`,
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        try {
          await appState.transport.kickMember(meta.code, targetUid);
          showToast(`Removed ${member.name}.`);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    stage.querySelectorAll('[data-make-host]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetUid = btn.dataset.makeHost;
        const member = snap.members[targetUid];
        if (!member) return;
        const ok = await confirmDialog({
          title: `Pass host to ${member.name}?`,
          message: `${member.name} will control round topics, settings, and when results reveal.`,
          confirmLabel: 'Pass host',
        });
        if (!ok) return;
        try {
          await appState.transport.transferHost(meta.code, targetUid);
          showToast(`${member.name} is now host.`);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    stage.querySelector('#btn-close-room').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Close & delete this room?',
        message: 'All players will be disconnected and every round and vote in this room will be permanently deleted.',
        confirmLabel: 'Delete room',
        danger: true,
      });
      if (!ok) return;
      try {
        await appState.transport.closeRoom(meta.code);
        exitRoomLocalState(true);
        showToast('Room deleted.', 'success');
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  bindHistoryActions(stage, snap);
}

/* ==========================================================================
   3. Rating Screen (0–10 Whole Numbers)
   ========================================================================== */

function renderRating(stage, snap) {
  const round = getCurrentRound(snap);
  if (!round) {
    renderLobby(stage, snap);
    return;
  }

  const host = isHost(snap);
  const rules = describeRoundRules(round);
  const isOpen = round.visibility === 'open';
  const submittedMap = (snap.submitted && snap.submitted[round.id]) || {};
  const myStoredBallot =
    (snap.ballots && snap.ballots[round.id] && snap.ballots[round.id][appState.uid]) || null;
  const iAmActive = Boolean(round.playerIds && round.playerIds[appState.uid]);
  const iSubmitted = Boolean(submittedMap[appState.uid]);

  // Active players who are still in the room (plus anyone who already submitted)
  const allRoundPlayers = Object.values(round.playerSnapshots || {}).sort(
    (a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.name.localeCompare(b.name)
  );
  const activePlayers = allRoundPlayers.filter(
    (p) => (snap.members && snap.members[p.uid]) || submittedMap[p.uid]
  );
  const doneCount = activePlayers.filter((p) => Boolean(submittedMap[p.uid])).length;
  const totalCount = activePlayers.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const hasPendingBots =
    appState.transport &&
    appState.transport.supportsBots &&
    Object.values(snap.members || {}).some(
      (m) => m.isBot && round.playerIds[m.uid] && !submittedMap[m.uid]
    );

  // If the user is actively filling ratings right now in the same round,
  // surgically update ONLY the readiness section so we never disrupt a tap/focus!
  const desiredModeKey = `rating:${round.id}:${host}:${iAmActive}:${iSubmitted && !appState.editingSubmitted}`;
  if (appState.lastRenderedViewKey === desiredModeKey && stage.querySelector('#readiness-section')) {
    updateReadinessBar(stage, activePlayers, submittedMap, doneCount, totalCount, pct, host, hasPendingBots);
    return;
  }
  appState.lastRenderedViewKey = desiredModeKey;

  const statusChipsHtml = renderStatusChips(activePlayers, submittedMap);

  const targets = getTargetsForVoter(round, appState.uid);
  const showingForm = iAmActive && (!iSubmitted || appState.editingSubmitted);

  // Hydrate draftScores from saved ballot when starting an edit
  if (showingForm && iSubmitted && myStoredBallot && Object.keys(appState.draftScores).length === 0) {
    appState.draftScores = { ...myStoredBallot };
  }

  let bodyHtml = '';
  if (!iAmActive) {
    bodyHtml = `
      <section class="card card-padded stack-sm">
        <h2 class="card-title">Spectating this round</h2>
        <p style="margin:0;color:var(--ink-2);">
          You joined after Round ${round.number} started, so you’ll sit this ballot out and automatically join the lineup in the next round.
        </p>
      </section>
    `;
  } else if (showingForm) {
    const scoredCount = targets.filter((t) => isValidScore(appState.draftScores[t.uid])).length;
    const allRated = scoredCount === targets.length && targets.length > 0;

    const cardsHtml = targets
      .map((target, index) => {
        const val = appState.draftScores[target.uid];
        const isSet = isValidScore(val);
        const isSelf = target.uid === appState.uid;
        const pipsHtml = Array.from({ length: MAX_SCORE - MIN_SCORE + 1 }, (_, n) => {
          const score = MIN_SCORE + n;
          const active = isSet && val === score;
          return `
            <button
              type="button"
              class="scale-pip ${active ? 'is-selected' : ''}"
              role="radio"
              aria-checked="${active}"
              aria-label="Give ${esc(target.name)} ${score} out of 10"
              data-target="${esc(target.uid)}"
              data-score="${score}"
            >${score}</button>
          `;
        }).join('');

        return `
          <article class="rate-card ${isSet ? 'is-scored' : ''} ${isSelf ? 'is-self' : ''}" data-rate-card="${esc(target.uid)}">
            <div class="rate-card-head">
              <div class="rate-person">
                ${renderAvatar(target.name, target.colorIndex)}
                <div style="min-width:0;">
                  <div class="rate-person-name">${esc(target.name)}</div>
                  ${
                    isSelf
                      ? '<span class="badge badge-accent" style="margin-top:2px;">You · self-rating</span>'
                      : ''
                  }
                </div>
              </div>
              <div class="score-readout ${isSet ? 'is-set' : ''}" data-readout="${esc(target.uid)}" aria-live="polite">
                ${isSet ? `${val}` : '—'}
              </div>
            </div>
            <div class="scale-strip" role="radiogroup" aria-label="Rate ${esc(target.name)} from 0 to 10">
              ${pipsHtml}
            </div>
            ${
              index === 0
                ? '<div class="scale-legend"><span>0 · lowest</span><span>5 · middle</span><span>10 · highest</span></div>'
                : ''
            }
          </article>
        `;
      })
      .join('');

    bodyHtml = `
      <div class="rating-list" id="rating-list">${cardsHtml}</div>
      <div class="submit-dock" id="submit-dock">
        <span class="submit-summary-text tabular" id="submit-progress-text">
          ${allRated ? `All ${targets.length} rated — ready to lock in` : `Rated ${scoredCount} of ${targets.length} players`}
        </span>
        <div class="row-gap">
          ${
            iSubmitted && appState.editingSubmitted
              ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-cancel-edit">Cancel</button>`
              : ''
          }
          <button
            type="button"
            class="btn btn-primary"
            id="btn-submit-ballot"
            ${allRated ? '' : 'disabled'}
          >
            ${iSubmitted ? 'Save Updated Ratings' : 'Submit My Ratings'}
          </button>
        </div>
      </div>
    `;
  } else {
    // Already submitted & waiting for other players
    const recapChips = targets
      .map((t) => {
        const s = myStoredBallot ? myStoredBallot[t.uid] : appState.draftScores[t.uid];
        const tag = t.uid === appState.uid ? ' (you)' : '';
        return `<span class="recap-chip">${esc(t.name)}${tag} <strong>${isValidScore(s) ? s : '—'}</strong></span>`;
      })
      .join('');

    bodyHtml = `
      <section class="card card-padded stack-md">
        <div class="row-between">
          <div>
            <span class="badge badge-sage">${ICONS.check} Submitted</span>
            <h2 class="card-title" style="margin-top:8px;">Your ratings are sealed!</h2>
            <p class="text-muted" style="margin:4px 0 0;">
              Results will reveal automatically once everyone finishes (or when the host reveals early).
            </p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-edit-ballot">
            Edit my ratings
          </button>
        </div>
        <div>
          <span class="section-label">Your submitted scores (visible only to you)</span>
          <div class="submitted-recap">${recapChips}</div>
        </div>
      </section>
    `;
  }

  stage.innerHTML = `
    <div class="view-stack">
      <section class="card card-padded topic-hero">
        <div class="topic-meta-row">
          <span class="section-label">Round ${round.number} · Rating open</span>
          <div class="topic-badges">
            <span class="badge ${isOpen ? 'badge-gold' : 'badge-sage'}">
              ${isOpen ? ICONS.eye : ICONS.lock} ${esc(rules.visibilityLabel)}
            </span>
            <span class="badge badge-neutral">${esc(rules.selfLabel)}</span>
          </div>
        </div>

        <h1 class="topic-headline">${esc(round.topic)}</h1>

        <div class="rule-preview-box ${isOpen ? 'is-open' : ''}">
          <span class="rule-preview-icon">${isOpen ? ICONS.eye : ICONS.lock}</span>
          <div>
            <strong>Locked for this round:</strong> ${esc(rules.headline)}
          </div>
        </div>

        <div class="readiness-bar" id="readiness-section">
          <div class="row-between">
            <span class="section-label" id="readiness-count">${doneCount} / ${totalCount} submitted</span>
            <div class="row-gap" id="readiness-controls">
              ${
                host && hasPendingBots
                  ? `<button type="button" class="btn btn-secondary btn-xs" id="btn-sim-bots">Simulate demo votes</button>`
                  : ''
              }
              ${
                host
                  ? `<button type="button" class="btn btn-secondary btn-xs" id="btn-reveal-early" ${doneCount === 0 ? 'disabled' : ''}>Reveal now</button>`
                  : ''
              }
            </div>
          </div>
          <div class="readiness-track" role="progressbar" aria-valuemin="0" aria-valuemax="${totalCount}" aria-valuenow="${doneCount}">
            <div class="readiness-fill" id="readiness-fill" style="width:${pct}%"></div>
          </div>
          <div class="status-pills" id="readiness-chips">${statusChipsHtml}</div>
        </div>
      </section>

      ${bodyHtml}
    </div>
  `;

  bindReadinessControls(stage, snap, round);

  if (showingForm) {
    const syncDockState = () => {
      const done = targets.filter((t) => isValidScore(appState.draftScores[t.uid])).length;
      const all = done === targets.length && targets.length > 0;
      const textEl = stage.querySelector('#submit-progress-text');
      const submitBtn = stage.querySelector('#btn-submit-ballot');
      if (textEl) {
        textEl.textContent = all
          ? `All ${targets.length} rated — ready to lock in`
          : `Rated ${done} of ${targets.length} players`;
      }
      if (submitBtn) submitBtn.disabled = !all || appState.submittingBallot;
    };

    const selectScore = (targetUid, score) => {
      appState.draftScores[targetUid] = score;
      const card = stage.querySelector(`[data-rate-card="${CSS.escape(targetUid)}"]`);
      if (card) {
        card.classList.add('is-scored');
        const readout = card.querySelector(`[data-readout="${CSS.escape(targetUid)}"]`);
        if (readout) {
          readout.textContent = String(score);
          readout.classList.add('is-set');
        }
        card.querySelectorAll('.scale-pip').forEach((pip) => {
          const match = Number(pip.dataset.score) === score;
          pip.classList.toggle('is-selected', match);
          pip.setAttribute('aria-checked', String(match));
        });
      }
      syncDockState();
    };

    stage.querySelectorAll('.scale-pip').forEach((pip) => {
      pip.addEventListener('click', () => {
        selectScore(pip.dataset.target, Number(pip.dataset.score));
      });
      pip.addEventListener('keydown', (e) => {
        const cur = Number(pip.dataset.score);
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(MAX_SCORE, cur + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(MIN_SCORE, cur - 1);
        else if (e.key === 'Home') next = MIN_SCORE;
        else if (e.key === 'End') next = MAX_SCORE;
        if (next === null) return;
        e.preventDefault();
        const targetUid = pip.dataset.target;
        selectScore(targetUid, next);
        const card = pip.closest('.rate-card');
        const targetBtn = card && card.querySelector(`.scale-pip[data-score="${next}"]`);
        if (targetBtn) targetBtn.focus();
      });
    });

    const cancelBtn = stage.querySelector('#btn-cancel-edit');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        appState.editingSubmitted = false;
        appState.lastRenderedViewKey = null;
        render();
      });
    }

    const submitBtn = stage.querySelector('#btn-submit-ballot');
    submitBtn.addEventListener('click', async () => {
      if (appState.submittingBallot) return;
      appState.submittingBallot = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      try {
        await appState.transport.submitBallot(snap.meta.code, round.id, appState.draftScores);
        appState.editingSubmitted = false;
        appState.submittingBallot = false;
        appState.lastRenderedViewKey = null;
        showToast('Ratings submitted!', 'success');
        render();
      } catch (err) {
        appState.submittingBallot = false;
        submitBtn.disabled = false;
        submitBtn.textContent = iSubmitted ? 'Save Updated Ratings' : 'Submit My Ratings';
        showToast(err.message || 'Could not submit ratings.', 'error');
      }
    });
  } else if (iAmActive && iSubmitted) {
    const editBtn = stage.querySelector('#btn-edit-ballot');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        appState.draftScores = myStoredBallot ? { ...myStoredBallot } : { ...appState.draftScores };
        appState.editingSubmitted = true;
        appState.lastRenderedViewKey = null;
        render();
      });
    }
  }
}

function renderStatusChips(activePlayers, submittedMap) {
  return activePlayers
    .map((p) => {
      const done = Boolean(submittedMap[p.uid]);
      return `
        <span class="status-chip ${done ? 'is-done' : ''}">
          ${done ? ICONS.check : '<span aria-hidden="true">·</span>'}
          ${esc(p.name)}
        </span>
      `;
    })
    .join('');
}

function updateReadinessBar(stage, activePlayers, submittedMap, doneCount, totalCount, pct, host, hasPendingBots) {
  const countEl = stage.querySelector('#readiness-count');
  const fillEl = stage.querySelector('#readiness-fill');
  const chipsEl = stage.querySelector('#readiness-chips');
  const revealBtn = stage.querySelector('#btn-reveal-early');
  const simBtn = stage.querySelector('#btn-sim-bots');
  const track = stage.querySelector('.readiness-track');

  if (countEl) countEl.textContent = `${doneCount} / ${totalCount} submitted`;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (track) {
    track.setAttribute('aria-valuemax', String(totalCount));
    track.setAttribute('aria-valuenow', String(doneCount));
  }
  if (chipsEl) chipsEl.innerHTML = renderStatusChips(activePlayers, submittedMap);
  if (revealBtn) revealBtn.disabled = doneCount === 0;
  if (simBtn && !hasPendingBots) simBtn.remove();
}

function bindReadinessControls(stage, snap, round) {
  const simBtn = stage.querySelector('#btn-sim-bots');
  if (simBtn) {
    simBtn.addEventListener('click', async () => {
      try {
        const count = await appState.transport.submitDemoBots(snap.meta.code, round.id);
        if (count > 0) {
          showToast(`${count} demo friend${count === 1 ? '' : 's'} submitted!`);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const revealBtn = stage.querySelector('#btn-reveal-early');
  if (revealBtn) {
    revealBtn.addEventListener('click', async () => {
      const latestSnap = appState.snapshot;
      const submittedMap = (latestSnap.submitted && latestSnap.submitted[round.id]) || {};
      const active = Object.values(round.playerSnapshots || {}).filter(
        (p) => latestSnap.members && latestSnap.members[p.uid]
      );
      const waiting = active.filter((p) => !submittedMap[p.uid]);
      if (waiting.length > 0) {
        const names = waiting.map((p) => p.name).join(', ');
        const ok = await confirmDialog({
          title: 'Reveal scores early?',
          message: `Still waiting on: ${names}. Averages will be calculated using the votes already submitted, and the round will lock.`,
          confirmLabel: 'Reveal now',
        });
        if (!ok) return;
      }
      try {
        await appState.transport.revealRound(snap.meta.code, round.id);
      } catch (err) {
        showToast(err.message || 'Could not reveal round.', 'error');
      }
    });
  }
}

/* ==========================================================================
   4. Results / Ranked Leaderboard Screen
   ========================================================================== */

function renderResults(stage, snap) {
  const round = getCurrentRound(snap);
  if (!round) {
    renderLobby(stage, snap);
    return;
  }

  appState.lastRenderedViewKey = `results:${round.id}`;
  const host = isHost(snap);
  const rules = describeRoundRules(round);
  const isOpen = round.visibility === 'open';
  const ballots = (snap.ballots && snap.ballots[round.id]) || {};
  const results = computeRoundResults(round, ballots, appState.uid, appState.sortBy);
  const completedOthers = getCompletedRounds(snap, round.id);
  const meta = snap.meta;
  const members = getSortedMembers(snap.members);
  const nextSettings = meta.settings || {
    allowSelfRating: true,
    visibility: 'anonymous',
    revealSelfInAnon: false,
  };
  const nextIsOpen = nextSettings.visibility === 'open';
  const nextRules = describeRoundRules(nextSettings);

  // Check if host is actively typing into next-round topic box
  const activeEl = document.activeElement;
  const wasEditingNext = activeEl && activeEl.id === 'input-next-topic';
  const caretStart = wasEditingNext ? activeEl.selectionStart : null;
  const caretEnd = wasEditingNext ? activeEl.selectionEnd : null;

  const privateSelfCardHtml =
    results.allowSelfRating && !results.showPublicSelfGap && results.mySelfInsight
      ? renderPrivateSelfCard(results.mySelfInsight)
      : '';

  const awardsHtml =
    results.awards.length > 0
      ? `
        <div class="awards-row" aria-label="Round highlights">
          ${results.awards
            .map(
              (a) => `
              <div class="award-card tone-${esc(a.tone)}">
                <div class="award-label">${esc(a.label)}</div>
                <div class="award-name">${esc(a.names)}</div>
                <div class="award-detail">${esc(a.detail)}</div>
              </div>`
            )
            .join('')}
        </div>`
      : '';

  const sortControlsHtml = results.showPublicSelfGap
    ? `
      <div class="sort-pills" role="group" aria-label="Sort leaderboard by">
        <button type="button" class="sort-pill ${results.effectiveSort === 'overall' ? 'is-active' : ''}" data-sort="overall">Avg score</button>
        <button type="button" class="sort-pill ${results.effectiveSort === 'delta' ? 'is-active' : ''}" data-sort="delta">Self vs. group</button>
      </div>`
    : '';

  const allExpanded =
    isOpen && results.rows.length > 0 && results.rows.every((r) => appState.expandedRows.has(r.uid));

  const rowsHtml = results.rows
    .map((row, idx) => renderLeaderboardRow(row, results, idx))
    .join('');

  const needMoreNext = !nextSettings.allowSelfRating && members.length < 2;

  stage.innerHTML = `
    <div class="view-stack">
      <!-- Topic Header -->
      <section class="card card-padded topic-hero">
        <div class="topic-meta-row">
          <span class="section-label">Round ${round.number} Results · ${results.voterCount} of ${results.eligibleCount} voted</span>
          <div class="topic-badges">
            <span class="badge ${isOpen ? 'badge-gold' : 'badge-sage'}">
              ${isOpen ? ICONS.eye : ICONS.lock} ${esc(rules.visibilityLabel)}
            </span>
            <span class="badge badge-neutral">${esc(rules.selfLabel)}</span>
          </div>
        </div>

        <h1 class="topic-headline">${esc(round.topic)}</h1>

        <div class="row-between">
          <span class="text-muted">${esc(rules.shortTag)}</span>
          <div class="row-gap">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-save-image">
              ${ICONS.image} Save image
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-summary">
              ${ICONS.copy} Copy text
            </button>
            ${
              host
                ? `<button type="button" class="btn btn-ghost btn-sm" id="btn-back-lobby">Back to lobby</button>`
                : ''
            }
          </div>
        </div>
      </section>

      ${privateSelfCardHtml}
      ${awardsHtml}

      <!-- Ranked Leaderboard -->
      <section class="stack-md" aria-label="Ranked averages">
        <div class="row-between">
          <div class="row-gap">
            <h2 class="card-title" style="font-size:1.1rem;">Ranked Results</h2>
            <div class="meter-legend">
              <span class="legend-item"><span class="legend-dot is-range"></span>Min–max</span>
              <span class="legend-item"><span class="legend-dot is-avg"></span>Avg${results.allowSelfRating ? ' (excl. self)' : ''}</span>
              ${
                results.showPublicSelfGap
                  ? '<span class="legend-item"><span class="legend-dot is-self"></span>Self</span>'
                  : ''
              }
            </div>
          </div>
          <div class="row-gap">
            ${sortControlsHtml}
            ${
              isOpen && results.rows.length > 0
                ? `<button type="button" class="btn btn-ghost btn-xs" id="btn-toggle-all-votes">
                    ${allExpanded ? 'Hide all votes' : 'Show all votes'}
                  </button>`
                : ''
            }
          </div>
        </div>

        <div class="leaderboard-list">${rowsHtml}</div>
      </section>

      <!-- Next Round Panel -->
      ${
        host
          ? `
          <section class="card card-padded stack-md" aria-label="Start next round">
            <div class="card-header-row" style="margin-bottom:0;">
              <div>
                <span class="section-label">Up next</span>
                <h2 class="card-title">Round ${(meta.roundCount || 1) + 1}</h2>
              </div>
              <span class="badge ${nextIsOpen ? 'badge-gold' : 'badge-sage'}">
                ${nextIsOpen ? ICONS.eye : ICONS.lock} ${nextIsOpen ? 'Open' : 'Anonymous'}
              </span>
            </div>

            <div class="topic-input-row">
              <input
                id="input-next-topic"
                class="input"
                type="text"
                maxlength="${MAX_TOPIC_LEN}"
                placeholder="Type the next topic…"
                value="${esc(appState.nextRoundTopic)}"
              />
              <button type="button" class="btn btn-secondary" id="btn-next-random">
                ${ICONS.shuffle} Surprise
              </button>
              <button type="button" class="btn btn-ghost" id="btn-next-ideas">
                ${ICONS.list} Ideas
              </button>
            </div>

            <div class="settings-grid">
              <div class="setting-block">
                <span class="field-label">Self-rating</span>
                <div class="segmented">
                  <button type="button" class="seg-btn ${nextSettings.allowSelfRating ? 'is-active' : ''}" id="next-self-on">
                    <span class="seg-btn-title">Include self</span>
                    <span class="seg-btn-sub">All ${members.length}</span>
                  </button>
                  <button type="button" class="seg-btn ${!nextSettings.allowSelfRating ? 'is-active' : ''}" id="next-self-off">
                    <span class="seg-btn-title">Others only</span>
                    <span class="seg-btn-sub">Skip self</span>
                  </button>
                </div>
              </div>
              <div class="setting-block">
                <span class="field-label">Vote visibility</span>
                <div class="segmented">
                  <button type="button" class="seg-btn tone-sage ${!nextIsOpen ? 'is-active' : ''}" id="next-vis-anon">
                    <span class="seg-btn-title">${ICONS.lock} Anonymous</span>
                    <span class="seg-btn-sub">Hide names</span>
                  </button>
                  <button type="button" class="seg-btn tone-gold ${nextIsOpen ? 'is-active' : ''}" id="next-vis-open">
                    <span class="seg-btn-title">${ICONS.eye} Open</span>
                    <span class="seg-btn-sub">Show names</span>
                  </button>
                </div>
              </div>
            </div>

            ${
              nextSettings.allowSelfRating && !nextIsOpen
                ? `
                <label class="checkbox-row">
                  <input type="checkbox" id="chk-next-reveal-self" ${nextSettings.revealSelfInAnon ? 'checked' : ''} />
                  <span><strong>Also show everyone’s Self vs. Group gap publicly</strong></span>
                </label>`
                : ''
            }

            <div class="row-between">
              <span class="text-muted">${
                needMoreNext
                  ? 'Need at least 2 players for “Others only” mode.'
                  : esc(nextRules.shortTag)
              }</span>
              <button
                type="button"
                class="btn btn-primary"
                id="btn-start-next-round"
                ${sanitizeTopic(appState.nextRoundTopic) && !needMoreNext ? '' : 'disabled'}
              >
                Start Round ${(meta.roundCount || 1) + 1} →
              </button>
            </div>
          </section>`
          : `
          <div class="subtle-banner">
            <span>Waiting for the host to start Round ${(meta.roundCount || 1) + 1}. Next rule currently set to <strong>${esc(nextRules.visibilityLabel)} · ${esc(nextRules.selfLabel)}</strong>.</span>
          </div>`
      }

      ${completedOthers.length > 0 ? renderHistoryCard(snap, completedOthers) : ''}
    </div>
  `;

  if (wasEditingNext) {
    const inp = stage.querySelector('#input-next-topic');
    if (inp) {
      inp.focus();
      if (caretStart !== null && caretEnd !== null) {
        try {
          inp.setSelectionRange(caretStart, caretEnd);
        } catch {
          // Ignore
        }
      }
    }
  }

  // Handlers
  stage.querySelector('#btn-save-image').addEventListener('click', () => {
    openShareImageModal(round, ballots);
  });

  stage.querySelector('#btn-copy-summary').addEventListener('click', async () => {
    const text = buildShareSummary(round, ballots);
    const ok = await copyToClipboard(text);
    showToast(ok ? 'Results copied for group chat!' : 'Could not copy results.', ok ? 'success' : 'error');
  });

  stage.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.sortBy = btn.dataset.sort;
      renderResults(stage, appState.snapshot);
    });
  });

  const toggleAllBtn = stage.querySelector('#btn-toggle-all-votes');
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', () => {
      if (allExpanded) {
        appState.expandedRows.clear();
      } else {
        results.rows.forEach((r) => appState.expandedRows.add(r.uid));
      }
      renderResults(stage, appState.snapshot);
    });
  }

  stage.querySelectorAll('[data-toggle-row]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const uid = btn.dataset.toggleRow;
      if (appState.expandedRows.has(uid)) appState.expandedRows.delete(uid);
      else appState.expandedRows.add(uid);
      renderResults(stage, appState.snapshot);
    });
  });

  if (host) {
    stage.querySelector('#btn-back-lobby').addEventListener('click', async () => {
      try {
        await appState.transport.returnToLobby(meta.code);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    const nextInput = stage.querySelector('#input-next-topic');
    const nextStartBtn = stage.querySelector('#btn-start-next-round');
    const syncNextBtn = (val) => {
      nextStartBtn.disabled = !(sanitizeTopic(val).length > 0 && !needMoreNext);
    };
    nextInput.addEventListener('input', (e) => {
      appState.nextRoundTopic = e.target.value;
      syncNextBtn(appState.nextRoundTopic);
    });
    nextInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !nextStartBtn.disabled) {
        e.preventDefault();
        nextStartBtn.click();
      }
    });

    stage.querySelector('#btn-next-random').addEventListener('click', () => {
      const p = pickRandomPrompt(appState.nextRoundTopic || round.topic);
      appState.nextRoundTopic = p;
      nextInput.value = p;
      syncNextBtn(p);
    });

    stage.querySelector('#btn-next-ideas').addEventListener('click', () => {
      openPromptPickerModal((chosen) => {
        appState.nextRoundTopic = chosen;
        nextInput.value = chosen;
        syncNextBtn(chosen);
      });
    });

    stage.querySelector('#next-self-on').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { allowSelfRating: true }).catch((e) => showToast(e.message, 'error'))
    );
    stage.querySelector('#next-self-off').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { allowSelfRating: false }).catch((e) => showToast(e.message, 'error'))
    );
    stage.querySelector('#next-vis-anon').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { visibility: 'anonymous' }).catch((e) => showToast(e.message, 'error'))
    );
    stage.querySelector('#next-vis-open').addEventListener('click', () =>
      appState.transport.updateSettings(meta.code, { visibility: 'open' }).catch((e) => showToast(e.message, 'error'))
    );

    const nextRevealChk = stage.querySelector('#chk-next-reveal-self');
    if (nextRevealChk) {
      nextRevealChk.addEventListener('change', (e) =>
        appState.transport
          .updateSettings(meta.code, { revealSelfInAnon: e.target.checked })
          .catch((err) => showToast(err.message, 'error'))
      );
    }

    nextStartBtn.addEventListener('click', async () => {
      const topic = sanitizeTopic(appState.nextRoundTopic);
      if (!topic) return;
      nextStartBtn.disabled = true;
      try {
        appState.autoRevealTriggeredFor = null;
        await appState.transport.startRound(meta.code, { topic, settings: nextSettings });
        appState.nextRoundTopic = '';
      } catch (err) {
        nextStartBtn.disabled = false;
        showToast(err.message || 'Could not start next round.', 'error');
      }
    });
  }

  bindHistoryActions(stage, snap);
}

function renderPrivateSelfCard(insight) {
  const hasOthers = insight.othersAvg !== null && insight.othersCount > 0;
  let note = 'Only you scored yourself this round.';
  if (hasOthers && insight.delta !== null) {
    if (insight.delta >= 0.45) {
      note = `You rated yourself ${formatDelta(insight.delta)} higher than the group.`;
    } else if (insight.delta <= -0.45) {
      note = `You rated yourself ${formatDelta(insight.delta)} below the group average.`;
    } else {
      note = 'Right in line with how the group rated you!';
    }
  }
  return `
    <section class="private-self-card" aria-label="Your private self vs group summary">
      <div>
        <div class="section-label" style="color:var(--sage-ink);opacity:0.85;display:inline-flex;align-items:center;gap:5px;">
          ${ICONS.lock} Private check-in · only visible to you
        </div>
        <div style="font-weight:700;margin-top:3px;">${esc(note)}</div>
      </div>
      <div class="private-self-numbers">
        <div class="stat-mini">
          <span class="stat-mini-label">Your self</span>
          <span class="stat-mini-val">${esc(insight.selfScore)}</span>
        </div>
        <div class="stat-mini">
          <span class="stat-mini-label">Others (${insight.othersCount})</span>
          <span class="stat-mini-val">${hasOthers ? esc(formatScore(insight.othersAvg)) : '—'}</span>
        </div>
        <div class="stat-mini">
          <span class="stat-mini-label">Gap</span>
          <span class="stat-mini-val">${hasOthers ? esc(formatDelta(insight.delta)) : '—'}</span>
        </div>
      </div>
    </section>
  `;
}

function renderLeaderboardRow(row, results, index) {
  const isMe = row.uid === appState.uid;
  const isTop = row.rank === 1 && row.overallAvg !== null;
  const primaryValue = row.overallAvg;
  const pct = primaryValue !== null ? Math.max(0, Math.min(100, (primaryValue / 10) * 100)) : 0;

  const hasAvg = primaryValue !== null;
  const hasRange = row.minScore !== null && row.maxScore !== null && row.overallCount >= 1;
  const minPct = hasRange ? (row.minScore / 10) * 100 : 0;
  const rangeWidthPct = hasRange ? ((row.maxScore - row.minScore) / 10) * 100 : 0;

  const showGap = results.showPublicSelfGap && row.selfScore !== null;
  let deltaClass = 'is-even';
  if (row.delta !== null) {
    if (row.delta >= 0.45) deltaClass = 'is-up';
    else if (row.delta <= -0.45) deltaClass = 'is-down';
  }

  const expanded = results.isOpen && appState.expandedRows.has(row.uid);
  const voteWord = results.allowSelfRating ? 'peer vote' : 'vote';

  const subText =
    row.overallCount === 0
      ? results.allowSelfRating
        ? 'No ratings from others yet'
        : 'No votes recorded'
      : row.minScore === row.maxScore
        ? `${row.overallCount} ${voteWord}${row.overallCount === 1 ? '' : 's'}${row.overallCount >= 2 ? ` · unanimous (${row.minScore})` : ''}`
        : `${row.overallCount} ${voteWord}s · range ${row.minScore}–${row.maxScore}`;

  const openBreakdownHtml =
    results.isOpen && expanded && row.openBreakdown
      ? `
        <div class="open-breakdown">
          ${row.openBreakdown
            .map(
              (v) => `
              <span class="voter-pill ${v.isSelf ? 'is-self' : ''}">
                ${esc(v.voterName)}${v.isSelf ? ' (self)' : ''}
                <strong>${v.score}</strong>
              </span>`
            )
            .join('')}
        </div>`
      : '';

  return `
    <article
      class="lb-row ${isTop ? 'is-first' : ''}"
      style="animation-delay:${Math.min(index * 45, 280)}ms"
    >
      <div class="lb-top">
        <div class="lb-left">
          <div class="rank-badge ${isTop ? 'rank-1' : ''}" aria-label="Rank ${row.rank || 'unranked'}">
            ${row.rank !== null ? `#${row.rank}` : '—'}
          </div>
          ${renderAvatar(row.name, row.colorIndex)}
          <div class="lb-name-wrap">
            <div class="lb-name">
              <span>${esc(row.name)}</span>
              ${isMe ? '<span class="badge badge-neutral">You</span>' : ''}
            </div>
            <div class="lb-sub">${esc(subText)}</div>
          </div>
        </div>
        <div class="lb-score-block">
          <div class="lb-score-big">${primaryValue !== null ? esc(formatScore(primaryValue)) : '—'}</div>
          <div class="lb-score-denom">${results.allowSelfRating ? 'avg excl. self' : 'out of 10'}</div>
        </div>
      </div>

      <div class="meter-wrap" aria-hidden="true">
        <div class="meter-track">
          <span class="meter-mid-tick" style="left:50%"></span>
          ${
            hasRange && row.maxScore > row.minScore
              ? `<div class="meter-range-span" style="left:${minPct}%;width:${rangeWidthPct}%;"></div>`
              : ''
          }
          ${
            hasAvg
              ? `<span class="meter-pin pin-avg" style="left:${pct}%" title="Average (excl. self): ${formatScore(primaryValue)}"></span>`
              : ''
          }
          ${
            showGap
              ? `<span class="meter-pin pin-self" style="left:${(row.selfScore / 10) * 100}%" title="Self-rating: ${row.selfScore} (not counted in avg)"></span>`
              : ''
          }
        </div>
        ${
          index === 0
            ? '<div class="meter-scale-labels"><span>0</span><span>5</span><span>10</span></div>'
            : ''
        }
      </div>

      ${
        showGap || results.isOpen
          ? `
          <div class="lb-meta-row">
            ${
              showGap
                ? `
                <div class="self-gap-row">
                  <span>Self <strong>${row.selfScore}</strong></span>
                  ${
                    row.delta !== null
                      ? `<span class="delta-pill ${deltaClass}">${esc(formatDelta(row.delta))} vs group</span>`
                      : ''
                  }
                </div>`
                : `<span class="text-muted" style="font-size:0.78rem;">Open breakdown</span>`
            }
            ${
              results.isOpen
                ? `<button type="button" class="breakdown-toggle" data-toggle-row="${esc(row.uid)}" aria-expanded="${expanded}">
                    ${expanded ? 'Hide votes' : `See ${row.openBreakdown ? row.openBreakdown.length : 0} votes`}
                    ${ICONS.chevron}
                  </button>`
                : '<span class="text-muted" style="font-size:0.76rem;">Individual votes hidden</span>'
            }
          </div>`
          : ''
      }

      ${openBreakdownHtml}
    </article>
  `;
}

function renderHistoryCard(snap, completedRounds) {
  const itemsHtml = completedRounds
    .map((r) => {
      const ballots = (snap.ballots && snap.ballots[r.id]) || {};
      const res = computeRoundResults(r, ballots, null, 'overall');
      const isOpen = r.visibility === 'open';
      const mini = res.rows
        .map(
          (row) =>
            `<span class="recap-chip">#${row.rank ?? '—'} ${esc(row.name)} <strong>${formatScore(row.overallAvg)}</strong></span>`
        )
        .join('');
      return `
        <details class="history-item">
          <summary>
            <span>
              <span class="section-label" style="margin-right:6px;">R${r.number}</span>
              ${esc(r.topic)}
            </span>
            <span class="row-gap">
              <span class="badge ${isOpen ? 'badge-gold' : 'badge-sage'}">${isOpen ? 'Open' : 'Anon'}</span>
              <span class="badge badge-neutral">${r.allowSelfRating ? 'Self' : 'Others'}</span>
            </span>
          </summary>
          <div class="history-mini-list">${mini}</div>
          <div class="row-gap" style="margin-top:8px;">
            <button type="button" class="btn btn-ghost btn-xs" data-save-history-img="${esc(r.id)}">
              ${ICONS.image} Save image
            </button>
            <button type="button" class="btn btn-ghost btn-xs" data-copy-history="${esc(r.id)}">
              ${ICONS.copy} Copy text
            </button>
          </div>
        </details>
      `;
    })
    .join('');

  return `
    <section class="card card-padded stack-sm" aria-label="Previous rounds">
      <div class="row-between">
        <h2 class="card-title" style="font-size:1rem;">Previous Rounds (${completedRounds.length})</h2>
      </div>
      <div>${itemsHtml}</div>
    </section>
  `;
}

function bindHistoryActions(stage, snap) {
  stage.querySelectorAll('[data-save-history-img]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const roundId = btn.dataset.saveHistoryImg;
      const r = snap.rounds && snap.rounds[roundId];
      if (!r) return;
      const ballots = (snap.ballots && snap.ballots[roundId]) || {};
      openShareImageModal(r, ballots);
    });
  });

  stage.querySelectorAll('[data-copy-history]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const roundId = btn.dataset.copyHistory;
      const r = snap.rounds && snap.rounds[roundId];
      if (!r) return;
      const ballots = (snap.ballots && snap.ballots[roundId]) || {};
      const ok = await copyToClipboard(buildShareSummary(r, ballots));
      showToast(ok ? `Round ${r.number} copied!` : 'Could not copy.', ok ? 'success' : 'error');
    });
  });
}

/* ==========================================================================
   Modals: Prompt Picker & Online Firebase Setup
   ========================================================================== */

function openShareImageModal(round, ballots) {
  const previewResults = computeRoundResults(round, ballots, appState.uid, 'overall');
  const canTogglePrivateSelf = Boolean(
    previewResults.allowSelfRating &&
      !previewResults.showPublicSelfGap &&
      previewResults.mySelfInsight
  );
  let includePrivateSelf = false;
  let currentAsset = null;
  let renderSeq = 0;

  openModal({
    title: `Save Round ${round.number} Image`,
    bodyHtml: `
      <div class="share-preview-frame" id="share-img-frame">
        <span class="text-muted" id="share-img-loading">Rendering photo…</span>
        <img id="share-img-preview" class="share-preview-img" alt="Round ${esc(round.number)} results card" hidden />
      </div>
      <div class="share-preview-meta">
        <span id="share-img-layout-note">Preparing card…</span>
        <span>Tip: on iPhone/Android you can press &amp; hold the image to save it</span>
      </div>
      ${
        canTogglePrivateSelf
          ? `
          <label class="checkbox-row" style="margin-top:2px;">
            <input type="checkbox" id="chk-share-private-self" />
            <span>
              <strong>Include my private Self vs. Group box</strong><br />
              <span class="field-hint">
                Strict anonymous round — off by default so your own self-rating isn’t shared accidentally.
              </span>
            </span>
          </label>`
          : ''
      }
    `,
    footerHtml: `
      <button type="button" class="btn btn-secondary btn-sm" id="btn-share-download" disabled>
        ${ICONS.download} Download PNG
      </button>
      <button type="button" class="btn btn-primary btn-sm" id="btn-share-native" hidden>
        ${ICONS.share} Share / Save
      </button>
    `,
    onMount: ({ bodyEl, footerEl }) => {
      const imgEl = bodyEl.querySelector('#share-img-preview');
      const loadingEl = bodyEl.querySelector('#share-img-loading');
      const noteEl = bodyEl.querySelector('#share-img-layout-note');
      const dlBtn = footerEl.querySelector('#btn-share-download');
      const shareBtn = footerEl.querySelector('#btn-share-native');
      const selfChk = bodyEl.querySelector('#chk-share-private-self');

      const refreshPreview = async () => {
        const mySeq = ++renderSeq;
        if (loadingEl) {
          loadingEl.textContent = 'Rendering photo…';
          loadingEl.hidden = !imgEl.hidden;
        }
        dlBtn.disabled = true;
        shareBtn.disabled = true;

        try {
          const asset = await renderRoundShareImage(round, ballots, {
            currentUid: appState.uid,
            includeMyPrivateSelf: includePrivateSelf,
          });
          if (mySeq !== renderSeq) return;
          currentAsset = asset;
          imgEl.src = asset.dataUrl;
          imgEl.hidden = false;
          if (loadingEl) loadingEl.hidden = true;
          noteEl.textContent = `${asset.layout.label} · ${asset.width}×${asset.height} PNG`;
          dlBtn.disabled = false;

          const nativeSupported = canNativeShareFile(asset.file);
          shareBtn.hidden = !nativeSupported;
          shareBtn.disabled = false;
          if (nativeSupported) {
            dlBtn.classList.remove('btn-primary');
            dlBtn.classList.add('btn-secondary');
          } else {
            dlBtn.classList.remove('btn-secondary');
            dlBtn.classList.add('btn-primary');
          }
        } catch (err) {
          if (mySeq !== renderSeq) return;
          console.error('Failed to render share card:', err);
          if (loadingEl) {
            loadingEl.textContent = 'Could not generate image on this browser.';
            loadingEl.hidden = false;
          }
          showToast(err.message || 'Could not generate image.', 'error');
        }
      };

      if (selfChk) {
        selfChk.addEventListener('change', (e) => {
          includePrivateSelf = Boolean(e.target.checked);
          refreshPreview();
        });
      }

      dlBtn.addEventListener('click', () => {
        if (!currentAsset) return;
        const a = document.createElement('a');
        let objectUrl = null;
        if (currentAsset.blob) {
          objectUrl = URL.createObjectURL(currentAsset.blob);
          a.href = objectUrl;
        } else {
          a.href = currentAsset.dataUrl;
        }
        a.download = currentAsset.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (objectUrl) {
          setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
        }
        showToast('Saved results image!', 'success');
      });

      shareBtn.addEventListener('click', async () => {
        if (!currentAsset || !currentAsset.file) return;
        try {
          await navigator.share({
            files: [currentAsset.file],
            title: `Out of Ten — Round ${round.number}`,
            text: round.topic || 'Out of Ten results',
          });
        } catch (err) {
          // User cancelling the native share sheet raises AbortError; ignore quietly
          if (err && err.name === 'AbortError') return;
          showToast('Share unavailable — tap Download PNG instead.');
        }
      });

      refreshPreview();
    },
  });
}

function openPromptPickerModal(onPick) {
  const groupsHtml = PROMPT_CATEGORIES.map(
    (group) => `
      <div>
        <div class="prompt-group-title">${esc(group.category)}</div>
        <div class="prompt-chip-list">
          ${group.prompts
            .map((p) => `<button type="button" class="prompt-option" data-prompt="${esc(p)}">${esc(p)}</button>`)
            .join('')}
        </div>
      </div>
    `
  ).join('');

  openModal({
    title: 'Topic ideas',
    bodyHtml: `<p class="text-muted" style="margin:0;">Tap any prompt to drop it in — you can always customize the wording afterwards.</p>${groupsHtml}`,
    onMount: ({ bodyEl, close }) => {
      bodyEl.querySelectorAll('.prompt-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          onPick(btn.dataset.prompt);
          close();
        });
      });
    },
  });
}

function openFirebaseSetupModal() {
  const isOnline = appState.transport && appState.transport.mode === 'firebase';
  const currentJson = appState.activeConfig
    ? JSON.stringify(appState.activeConfig, null, 2)
    : '';
  const fromFile = appState.configSource === 'file';

  openModal({
    title: isOnline ? 'Online Mode (Firebase)' : 'Connect Online Play (Firebase)',
    bodyHtml: `
      <div class="subtle-banner ${isOnline ? 'tone-sage' : ''}">
        <div>
          ${
            isOnline
              ? `<strong>Connected to Firebase project:</strong> <code>${esc(appState.activeConfig.projectId)}</code> (${fromFile ? 'via config.js' : 'saved in this browser'}). Friends on any Wi-Fi or 5G can join rooms live.`
              : 'Currently in <strong>Local Demo Mode</strong> (works across tabs in this browser only). To play online with friends on separate networks, connect a free Firebase Realtime Database.'
          }
        </div>
      </div>

      <ol style="margin:0;padding-left:18px;font-size:0.86rem;color:var(--ink-2);line-height:1.6;">
        <li>Create a free project at <strong>console.firebase.google.com</strong>.</li>
        <li>Enable <strong>Authentication → Anonymous</strong> sign-in.</li>
        <li>Create a <strong>Realtime Database</strong> and paste <code>database.rules.json</code> into the <em>Rules</em> tab (blocks room crawling, seals votes before reveal, enforces 0–10 whole numbers).</li>
        <li>Add a Web App and paste its <code>firebaseConfig</code> snippet below — or save it permanently into <code>config.js</code> before hosting.</li>
      </ol>

      <div class="field">
        <label class="field-label" for="firebase-cfg-input" style="justify-content:flex-start;gap:5px;flex-wrap:wrap;">
          <span>Paste <code>firebaseConfig</code> snippet or JSON</span>
        </label>
        <textarea
          id="firebase-cfg-input"
          class="textarea"
          placeholder='{\n  "apiKey": "...",\n  "authDomain": "my-app.firebaseapp.com",\n  "databaseURL": "https://my-app-default-rtdb.firebaseio.com",\n  "projectId": "my-app",\n  "appId": "1:...:web:..."\n}'
        >${esc(currentJson)}</textarea>
      </div>
      <p class="text-error" id="firebase-cfg-err" hidden style="margin:0;"></p>
    `,
    footerHtml: `
      ${
        isOnline && !fromFile
          ? '<button type="button" class="btn btn-ghost btn-sm" id="btn-switch-local">Switch to Local Demo</button>'
          : ''
      }
      <button type="button" class="btn btn-secondary btn-sm" id="btn-copy-config-js" ${isOnline ? '' : 'hidden'}>Copy config.js</button>
      <button type="button" class="btn btn-primary btn-sm" id="btn-save-firebase">Save &amp; Connect</button>
    `,
    onMount: ({ bodyEl, footerEl, close }) => {
      const textarea = bodyEl.querySelector('#firebase-cfg-input');
      const errEl = bodyEl.querySelector('#firebase-cfg-err');
      const saveBtn = footerEl.querySelector('#btn-save-firebase');
      const copyJsBtn = footerEl.querySelector('#btn-copy-config-js');
      const localBtn = footerEl.querySelector('#btn-switch-local');

      if (copyJsBtn) {
        copyJsBtn.addEventListener('click', async () => {
          const block = `export const FIREBASE_CONFIG = ${JSON.stringify(appState.activeConfig, null, 2)};\n`;
          const ok = await copyToClipboard(block);
          showToast(ok ? 'Copied config.js snippet!' : 'Copy failed.', ok ? 'success' : 'error');
        });
      }

      if (localBtn) {
        localBtn.addEventListener('click', async () => {
          saveStoredFirebaseConfig(null);
          exitRoomLocalState(true);
          await initTransport(null, 'none');
          close();
          showToast('Switched to Local Demo mode.');
          render();
        });
      }

      saveBtn.addEventListener('click', async () => {
        errEl.hidden = true;
        let parsed;
        try {
          parsed = parseFirebaseConfigInput(textarea.value);
          if (!parsed) throw new Error('Paste your Firebase web config first.');
        } catch (err) {
          errEl.textContent = err.message || 'Invalid Firebase config.';
          errEl.hidden = false;
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Connecting…';
        try {
          saveStoredFirebaseConfig(parsed);
          exitRoomLocalState(true);
          await initTransport(parsed, 'browser');
          if (appState.transport.mode !== 'firebase') {
            throw new Error('Firebase SDK could not connect with this config.');
          }
          close();
          showToast('Connected to Firebase online mode!', 'success');
          render();
        } catch (err) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Connect';
          errEl.textContent = err.message || 'Could not initialize Firebase.';
          errEl.hidden = false;
        }
      });
    },
  });
}

async function handleLeaveRoom() {
  if (!appState.roomCode) return;
  const snap = appState.snapshot;
  const host = isHost(snap);
  const realOthers = snap && snap.members
    ? Object.values(snap.members).filter((m) => m.uid !== appState.uid && !m.isBot)
    : [];

  const msg = host && realOthers.length === 0
    ? 'Leaving will close this empty room.'
    : host
      ? 'Host control will pass automatically to the next player in the room.'
      : 'You can rejoin later with the room code unless the host locks the room.';

  const ok = await confirmDialog({
    title: 'Leave this room?',
    message: msg,
    confirmLabel: 'Leave room',
  });
  if (!ok) return;

  const code = appState.roomCode;
  try {
    await appState.transport.leaveRoom(code);
  } catch (err) {
    console.warn('Leave error:', err);
  }
  exitRoomLocalState(true);
  render();
}

/* ==========================================================================
   Bootstrap
   ========================================================================== */

async function bootstrap() {
  const { source, config } = resolveInitialConfig();
  await initTransport(config, source);

  const connBtn = document.getElementById('btn-connection-status');
  if (connBtn) connBtn.addEventListener('click', openFirebaseSetupModal);
  window.addEventListener('resize', updateConnectionPill);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && appState.snapshot) {
      maybeAutoReveal(appState.snapshot);
    }
  });

  const brandLink = document.getElementById('brand-link');
  if (brandLink) {
    brandLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (appState.roomCode) {
        handleLeaveRoom();
      } else {
        appState.landingTab = 'create';
        appState.entryError = '';
        render();
      }
    });
  }

  // Check URL invite param or recover prior session on reload
  const params = new URLSearchParams(window.location.search);
  const urlRoom = normalizeRoomCode(params.get('room') || '');
  let savedSessionRoom = '';
  try {
    savedSessionRoom = normalizeRoomCode(sessionStorage.getItem(ACTIVE_ROOM_SESSION_KEY) || '');
  } catch {
    savedSessionRoom = '';
  }

  if (savedSessionRoom && (!urlRoom || urlRoom === savedSessionRoom) && isValidRoomCode(savedSessionRoom)) {
    // Reconnect this tab seamlessly back into its active room
    appState.roomCode = savedSessionRoom;
    enterRoomSubscription(savedSessionRoom);
    return;
  }

  if (urlRoom && isValidRoomCode(urlRoom)) {
    appState.landingTab = 'join';
    appState.joinCodeInput = urlRoom;
  }

  render();
}

bootstrap();
