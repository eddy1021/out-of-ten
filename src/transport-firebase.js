/**
 * Online Multiplayer Transport powered by Firebase Realtime Database + Anonymous Auth.
 * Imports the official modular Firebase JS SDK dynamically from gstatic.com ONLY when configured,
 * so zero npm/build step is required and offline Local Demo mode makes zero external requests.
 */

import {
  AVATAR_COLORS,
  MAX_PLAYERS,
  generateRoomCode,
  normalizeRoomCode,
  sanitizeName,
  sanitizeTopic,
  validateBallot,
} from './engine.js';

const FB_VERSION = '10.14.1';
const FB_BASE = `https://www.gstatic.com/firebasejs/${FB_VERSION}`;

const OVERRIDE_KEY = 'outoften:firebase-config';

export function loadStoredFirebaseConfig() {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidFirebaseConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveStoredFirebaseConfig(config) {
  if (!config) {
    localStorage.removeItem(OVERRIDE_KEY);
    return;
  }
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(config));
}

export function isValidFirebaseConfig(cfg) {
  return Boolean(
    cfg &&
      typeof cfg === 'object' &&
      typeof cfg.apiKey === 'string' &&
      cfg.apiKey.trim() &&
      typeof cfg.databaseURL === 'string' &&
      /^https:\/\/.+/i.test(cfg.databaseURL.trim()) &&
      typeof cfg.projectId === 'string' &&
      cfg.projectId.trim() &&
      typeof cfg.appId === 'string' &&
      cfg.appId.trim()
  );
}

/**
 * Parses either JSON or a pasted Firebase Console JS snippet like:
 *   const firebaseConfig = { apiKey: "...", databaseURL: "https://...", ... };
 */
export function parseFirebaseConfigInput(rawText) {
  const text = (rawText || '').trim();
  if (!text) return null;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Paste the firebaseConfig object starting with { and ending with }.');
  }

  let body = text.slice(start, end + 1);
  // First try pure JSON
  try {
    const parsed = JSON.parse(body);
    return sanitizeConfigFields(parsed);
  } catch {
    // Strip JS comments WITHOUT touching `//` inside quoted URLs like "https://..."
    body = body
      .replace(
        /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (token) => {
          if (token.startsWith('"')) return token;
          if (token.startsWith("'")) {
            const inner = token.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
            return `"${inner}"`;
          }
          return '';
        }
      )
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(body);
    return sanitizeConfigFields(parsed);
  }
}

function sanitizeConfigFields(obj) {
  const clean = {
    apiKey: String(obj.apiKey || '').trim(),
    authDomain: String(obj.authDomain || `${obj.projectId || ''}.firebaseapp.com`).trim(),
    databaseURL: String(obj.databaseURL || '').trim(),
    projectId: String(obj.projectId || '').trim(),
    appId: String(obj.appId || '').trim(),
  };
  if (!isValidFirebaseConfig(clean)) {
    throw new Error(
      'Missing required fields. Include apiKey, databaseURL (https://...), projectId, and appId.'
    );
  }
  return clean;
}

export class FirebaseTransport {
  constructor(config) {
    this.mode = 'firebase';
    this.supportsBots = false;
    this.config = config;
    this.uid = null;
    this.app = null;
    this.auth = null;
    this.db = null;
    this.sdk = null;
    this._activeUnsubs = [];
  }

  async init() {
    if (this.uid && this.db) return this.uid;

    const [appMod, authMod, dbMod] = await Promise.all([
      import(`${FB_BASE}/firebase-app.js`),
      import(`${FB_BASE}/firebase-auth.js`),
      import(`${FB_BASE}/firebase-database.js`),
    ]);

    this.sdk = { appMod, authMod, dbMod };
    const existing = appMod.getApps().find((a) => a.name === 'out-of-ten');
    if (existing) {
      await appMod.deleteApp(existing);
    }

    this.app = appMod.initializeApp(this.config, 'out-of-ten');
    this.auth = authMod.getAuth(this.app);
    this.db = dbMod.getDatabase(this.app);

    const existingUser = await new Promise((resolve) => {
      const unsub = authMod.onAuthStateChanged(this.auth, (user) => {
        unsub();
        resolve(user);
      });
    });

    if (existingUser) {
      this.uid = existingUser.uid;
    } else {
      const cred = await authMod.signInAnonymously(this.auth);
      this.uid = cred.user.uid;
    }
    return this.uid;
  }

  getUid() {
    return this.uid;
  }

  dispose() {
    this._activeUnsubs.forEach((fn) => {
      try {
        fn();
      } catch {
        // Ignore
      }
    });
    this._activeUnsubs = [];
  }

  _ref(path) {
    return this.sdk.dbMod.ref(this.db, path);
  }

  async createRoom({ name, colorIndex = 0 }) {
    const { get, set } = this.sdk.dbMod;
    const cleanName = sanitizeName(name);
    if (!cleanName) throw new Error('Please enter a nickname first.');
    const safeColor = ((Number(colorIndex) || 0) % AVATAR_COLORS.length + AVATAR_COLORS.length) % AVATAR_COLORS.length;

    let code = generateRoomCode(6);
    for (let i = 0; i < 6; i += 1) {
      const snap = await get(this._ref(`rooms/${code}/meta`));
      if (!snap.exists()) break;
      code = generateRoomCode(6);
    }

    const now = Date.now();
    const meta = {
      code,
      hostUid: this.uid,
      phase: 'lobby',
      roundCount: 0,
      locked: false,
      draftTopic: '',
      settings: {
        allowSelfRating: true,
        visibility: 'anonymous',
        revealSelfInAnon: false,
      },
      createdAt: now,
      updatedAt: now,
    };

    const member = {
      uid: this.uid,
      name: cleanName,
      colorIndex: safeColor,
      joinedAt: now,
    };

    await set(this._ref(`rooms/${code}/meta`), meta);
    await set(this._ref(`rooms/${code}/members/${this.uid}`), member);
    return { code };
  }

  async joinRoom({ code, name, colorIndex = 0 }) {
    const { get, set } = this.sdk.dbMod;
    const cleanCode = normalizeRoomCode(code);
    const cleanName = sanitizeName(name);
    if (!cleanName) throw new Error('Please enter a nickname first.');
    const safeColor = ((Number(colorIndex) || 0) % AVATAR_COLORS.length + AVATAR_COLORS.length) % AVATAR_COLORS.length;

    const metaSnap = await get(this._ref(`rooms/${cleanCode}/meta`));
    if (!metaSnap.exists()) {
      throw new Error(`Room "${cleanCode}" wasn’t found. Double-check the code with your host.`);
    }
    const meta = metaSnap.val();

    const membersSnap = await get(this._ref(`rooms/${cleanCode}/members`));
    const members = membersSnap.exists() ? membersSnap.val() : {};
    const existing = members[this.uid];

    if (!existing && meta.locked && meta.hostUid !== this.uid) {
      throw new Error('This room is locked by the host right now.');
    }
    if (!existing && Object.keys(members).length >= MAX_PLAYERS) {
      throw new Error(`This room is full (max ${MAX_PLAYERS} players).`);
    }

    await set(this._ref(`rooms/${cleanCode}/members/${this.uid}`), {
      uid: this.uid,
      name: cleanName,
      colorIndex: safeColor,
      joinedAt: existing ? existing.joinedAt : Date.now(),
    });

    return { code: cleanCode };
  }

  subscribeRoom(code, onSnapshot, onError) {
    const { onValue } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);

    const state = {
      metaLoaded: false,
      meta: null,
      members: {},
      rounds: {},
      submitted: {},
      ballots: {},
    };

    // Per-round ballot subscriptions aligned with database.rules.json
    // - While round.phase === 'rating', subscribe ONLY to own ballot (never triggers PERMISSION_DENIED)
    // - Once round.phase === 'results', switch to the full ballots/{roundId} node
    const ballotSubs = new Map(); // roundId -> { mode: 'mine' | 'all', unsub }

    const emit = () => {
      if (!state.metaLoaded) return;
      if (!state.meta) {
        onSnapshot({ exists: false });
        return;
      }
      onSnapshot({
        exists: true,
        meta: state.meta,
        members: state.members || {},
        rounds: state.rounds || {},
        submitted: state.submitted || {},
        ballots: { ...state.ballots },
      });
    };

    const syncBallotSubscriptions = () => {
      const rounds = state.rounds || {};
      // Clean removed rounds
      for (const [roundId, entry] of ballotSubs.entries()) {
        if (!rounds[roundId]) {
          entry.unsub();
          ballotSubs.delete(roundId);
          delete state.ballots[roundId];
        }
      }

      for (const [roundId, round] of Object.entries(rounds)) {
        const desiredMode = round.phase === 'results' ? 'all' : 'mine';
        const existing = ballotSubs.get(roundId);
        if (existing && existing.mode === desiredMode) continue;
        if (existing) {
          existing.unsub();
          ballotSubs.delete(roundId);
        }

        if (desiredMode === 'all') {
          const unsub = onValue(
            this._ref(`rooms/${clean}/ballots/${roundId}`),
            (snap) => {
              state.ballots[roundId] = snap.exists() ? snap.val() : {};
              emit();
            },
            (err) => onError && onError(err)
          );
          ballotSubs.set(roundId, { mode: 'all', unsub });
        } else {
          const unsub = onValue(
            this._ref(`rooms/${clean}/ballots/${roundId}/${this.uid}`),
            (snap) => {
              state.ballots[roundId] = snap.exists() ? { [this.uid]: snap.val() } : {};
              emit();
            },
            (err) => onError && onError(err)
          );
          ballotSubs.set(roundId, { mode: 'mine', unsub });
        }
      }
    };

    const unsubMeta = onValue(
      this._ref(`rooms/${clean}/meta`),
      (snap) => {
        state.metaLoaded = true;
        state.meta = snap.exists() ? snap.val() : null;
        emit();
      },
      (err) => onError && onError(err)
    );

    const unsubMembers = onValue(
      this._ref(`rooms/${clean}/members`),
      (snap) => {
        state.members = snap.exists() ? snap.val() : {};
        emit();
      },
      (err) => onError && onError(err)
    );

    const unsubRounds = onValue(
      this._ref(`rooms/${clean}/rounds`),
      (snap) => {
        state.rounds = snap.exists() ? snap.val() : {};
        syncBallotSubscriptions();
        emit();
      },
      (err) => onError && onError(err)
    );

    const unsubSubmitted = onValue(
      this._ref(`rooms/${clean}/submitted`),
      (snap) => {
        state.submitted = snap.exists() ? snap.val() : {};
        emit();
      },
      (err) => onError && onError(err)
    );

    const teardown = () => {
      unsubMeta();
      unsubMembers();
      unsubRounds();
      unsubSubmitted();
      for (const entry of ballotSubs.values()) {
        entry.unsub();
      }
      ballotSubs.clear();
    };

    this._activeUnsubs.push(teardown);
    return teardown;
  }

  async updateSettings(code, partial) {
    const { get, update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    const metaSnap = await get(this._ref(`rooms/${clean}/meta`));
    if (!metaSnap.exists()) throw new Error('Room not found.');
    const meta = metaSnap.val();
    const nextSettings = {
      ...meta.settings,
      ...(typeof partial.allowSelfRating === 'boolean'
        ? { allowSelfRating: partial.allowSelfRating }
        : {}),
      ...(partial.visibility === 'anonymous' || partial.visibility === 'open'
        ? { visibility: partial.visibility }
        : {}),
      ...(typeof partial.revealSelfInAnon === 'boolean'
        ? { revealSelfInAnon: partial.revealSelfInAnon }
        : {}),
    };
    await update(this._ref(`rooms/${clean}/meta`), {
      settings: nextSettings,
      updatedAt: Date.now(),
    });
  }

  async updateDraftTopic(code, draftTopic) {
    const { update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    await update(this._ref(`rooms/${clean}/meta`), {
      draftTopic: sanitizeTopic(draftTopic),
      updatedAt: Date.now(),
    });
  }

  async setRoomLocked(code, locked) {
    const { update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    await update(this._ref(`rooms/${clean}/meta`), {
      locked: Boolean(locked),
      updatedAt: Date.now(),
    });
  }

  async startRound(code, { topic, settings }) {
    const { get, set, update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    const cleanTopic = sanitizeTopic(topic);
    if (!cleanTopic) throw new Error('Enter a topic before starting the round.');

    const [metaSnap, membersSnap] = await Promise.all([
      get(this._ref(`rooms/${clean}/meta`)),
      get(this._ref(`rooms/${clean}/members`)),
    ]);
    if (!metaSnap.exists()) throw new Error('Room not found.');
    const meta = metaSnap.val();
    if (meta.hostUid !== this.uid) throw new Error('Only the host can start a round.');

    const members = membersSnap.exists() ? Object.values(membersSnap.val()) : [];
    const nextSettings = {
      allowSelfRating: Boolean(settings.allowSelfRating),
      visibility: settings.visibility === 'open' ? 'open' : 'anonymous',
      revealSelfInAnon: Boolean(settings.revealSelfInAnon),
    };
    if (!nextSettings.allowSelfRating && members.length < 2) {
      throw new Error('Need at least 2 players to start in "Others only" mode.');
    }
    if (members.length < 1) {
      throw new Error('Need at least 1 player to start a round.');
    }

    const nextNum = (meta.roundCount || 0) + 1;
    const roundId = `r${nextNum}`;
    const now = Date.now();
    const playerIds = {};
    const playerSnapshots = {};
    members.forEach((m) => {
      playerIds[m.uid] = true;
      playerSnapshots[m.uid] = {
        uid: m.uid,
        name: m.name,
        colorIndex: Number(m.colorIndex) || 0,
        joinedAt: Number(m.joinedAt) || now,
      };
    });

    const roundObj = {
      id: roundId,
      number: nextNum,
      topic: cleanTopic,
      allowSelfRating: nextSettings.allowSelfRating,
      visibility: nextSettings.visibility,
      revealSelfInAnon: nextSettings.revealSelfInAnon,
      startedAt: now,
      phase: 'rating',
      playerIds,
      playerSnapshots,
    };

    await set(this._ref(`rooms/${clean}/rounds/${roundId}`), roundObj);
    await update(this._ref(`rooms/${clean}/meta`), {
      settings: nextSettings,
      roundCount: nextNum,
      currentRoundId: roundId,
      phase: 'rating',
      draftTopic: '',
      updatedAt: now,
    });
  }

  async submitBallot(code, roundId, rawScores) {
    const { get, set } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    const roundSnap = await get(this._ref(`rooms/${clean}/rounds/${roundId}`));
    if (!roundSnap.exists()) throw new Error('Round not found.');
    const round = roundSnap.val();
    if (round.phase !== 'rating') {
      throw new Error('This round has already closed.');
    }
    const check = validateBallot(round, this.uid, rawScores);
    if (!check.valid) throw new Error(check.error);

    await set(this._ref(`rooms/${clean}/ballots/${roundId}/${this.uid}`), check.scores);
    await set(this._ref(`rooms/${clean}/submitted/${roundId}/${this.uid}`), Date.now());
  }

  async revealRound(code, roundId) {
    const { update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    const now = Date.now();
    await update(this._ref(`rooms/${clean}/rounds/${roundId}`), {
      phase: 'results',
      revealedAt: now,
    });
    await update(this._ref(`rooms/${clean}/meta`), {
      phase: 'results',
      updatedAt: now,
    });
  }

  async returnToLobby(code) {
    const { update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    await update(this._ref(`rooms/${clean}/meta`), {
      phase: 'lobby',
      updatedAt: Date.now(),
    });
  }

  async kickMember(code, targetUid) {
    const { remove } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    if (targetUid === this.uid) throw new Error('Cannot remove yourself as host.');
    await remove(this._ref(`rooms/${clean}/members/${targetUid}`));
  }

  async transferHost(code, newHostUid) {
    const { update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    await update(this._ref(`rooms/${clean}/meta`), {
      hostUid: newHostUid,
      updatedAt: Date.now(),
    });
  }

  async leaveRoom(code) {
    const { get, remove, update } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    const [metaSnap, membersSnap] = await Promise.all([
      get(this._ref(`rooms/${clean}/meta`)),
      get(this._ref(`rooms/${clean}/members`)),
    ]);
    if (!metaSnap.exists()) return;
    const meta = metaSnap.val();
    const members = membersSnap.exists() ? membersSnap.val() : {};
    const others = Object.values(members).filter((m) => m.uid !== this.uid);

    if (meta.hostUid === this.uid) {
      if (others.length === 0) {
        await remove(this._ref(`rooms/${clean}`));
        return;
      }
      others.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
      await update(this._ref(`rooms/${clean}/meta`), {
        hostUid: others[0].uid,
        updatedAt: Date.now(),
      });
    }
    await remove(this._ref(`rooms/${clean}/members/${this.uid}`));
  }

  async closeRoom(code) {
    const { remove } = this.sdk.dbMod;
    const clean = normalizeRoomCode(code);
    await remove(this._ref(`rooms/${clean}`));
  }
}
