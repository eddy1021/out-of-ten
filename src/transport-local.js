/**
 * Zero-setup Local Multi-Tab Transport for "Out of Ten".
 * Uses localStorage + BroadcastChannel + 'storage' events so opening the app
 * in multiple browser tabs behaves like a live online party room — plus optional
 * simulated friends ("bots") for quick single-tab testing.
 */

import {
  AVATAR_COLORS,
  DEMO_BOT_NAMES,
  MAX_PLAYERS,
  generateBotBallot,
  generateRoomCode,
  normalizeRoomCode,
  sanitizeName,
  sanitizeTopic,
  validateBallot,
} from './engine.js';

const STORAGE_PREFIX = 'outoften:room:';
const UID_SESSION_KEY = 'outoften:tab-uid';
const CHANNEL_NAME = 'outoften-local-sync';

function makeLocalUid() {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `local_${hex}`;
}

function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : null;
}

function readRawRoom(code) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${code}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeRawRoom(code, room, channel) {
  if (room === null) {
    localStorage.removeItem(`${STORAGE_PREFIX}${code}`);
  } else {
    localStorage.setItem(`${STORAGE_PREFIX}${code}`, JSON.stringify(room));
  }
  if (channel) {
    try {
      channel.postMessage({ type: 'room-changed', code });
    } catch {
      // Ignore closed channel
    }
  }
}

export class LocalTransport {
  constructor() {
    this.mode = 'local';
    this.supportsBots = true;
    this.uid = null;
    this.channel = null;
    this.listeners = new Map(); // code -> Set<cb>
    this._onStorage = (e) => {
      if (!e.key || !e.key.startsWith(STORAGE_PREFIX)) return;
      const code = e.key.slice(STORAGE_PREFIX.length);
      this._emit(code);
    };
  }

  async init() {
    if (!this.uid) {
      let existing = null;
      try {
        existing = sessionStorage.getItem(UID_SESSION_KEY);
      } catch {
        existing = null;
      }
      if (!existing) {
        existing = makeLocalUid();
        try {
          sessionStorage.setItem(UID_SESSION_KEY, existing);
        } catch {
          // Non-fatal
        }
      }
      this.uid = existing;
    }

    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event) => {
        if (event.data && event.data.type === 'room-changed' && event.data.code) {
          this._emit(event.data.code);
        }
      };
    }

    if (typeof window !== 'undefined' && !this._listeningStorage) {
      window.addEventListener('storage', this._onStorage);
      this._listeningStorage = true;
    }

    return this.uid;
  }

  getUid() {
    return this.uid;
  }

  dispose() {
    if (this._listeningStorage && typeof window !== 'undefined') {
      window.removeEventListener('storage', this._onStorage);
      this._listeningStorage = false;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.listeners.clear();
  }

  _buildSafeSnapshot(room) {
    if (!room) {
      return { exists: false };
    }
    const rounds = clone(room.rounds || {});
    const maskedBallots = {};
    const rawBallots = room.ballots || {};

    for (const [roundId, votersMap] of Object.entries(rawBallots)) {
      const round = rounds[roundId];
      if (!round) continue;
      if (round.phase === 'results') {
        maskedBallots[roundId] = clone(votersMap);
      } else if (votersMap && votersMap[this.uid]) {
        // Mirror Firebase RTDB security rules: seal other voters' ballots during rating!
        maskedBallots[roundId] = { [this.uid]: clone(votersMap[this.uid]) };
      }
    }

    return {
      exists: true,
      meta: clone(room.meta),
      members: clone(room.members || {}),
      rounds,
      submitted: clone(room.submitted || {}),
      ballots: maskedBallots,
    };
  }

  _emit(code) {
    const callbacks = this.listeners.get(code);
    if (!callbacks || callbacks.size === 0) return;
    const room = readRawRoom(code);
    const snap = this._buildSafeSnapshot(room);
    callbacks.forEach((cb) => cb(snap));
  }

  _mutate(code, updater) {
    const clean = normalizeRoomCode(code);
    const room = readRawRoom(clean);
    if (!room) {
      throw new Error('This room no longer exists.');
    }
    const next = updater(clone(room));
    writeRawRoom(clean, next, this.channel);
    this._emit(clean);
    return next;
  }

  async createRoom({ name, colorIndex = 0 }) {
    const cleanName = sanitizeName(name);
    if (!cleanName) throw new Error('Please enter a nickname first.');
    let code = generateRoomCode(6);
    let attempts = 0;
    while (readRawRoom(code) && attempts < 10) {
      code = generateRoomCode(6);
      attempts += 1;
    }
    const now = Date.now();
    const safeColor = ((Number(colorIndex) || 0) % AVATAR_COLORS.length + AVATAR_COLORS.length) % AVATAR_COLORS.length;

    const room = {
      meta: {
        code,
        hostUid: this.uid,
        phase: 'lobby',
        currentRoundId: null,
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
      },
      members: {
        [this.uid]: {
          uid: this.uid,
          name: cleanName,
          colorIndex: safeColor,
          joinedAt: now,
        },
      },
      rounds: {},
      submitted: {},
      ballots: {},
    };

    writeRawRoom(code, room, this.channel);
    this._emit(code);
    return { code };
  }

  async joinRoom({ code, name, colorIndex = 0 }) {
    const cleanCode = normalizeRoomCode(code);
    const room = readRawRoom(cleanCode);
    if (!room) {
      throw new Error(
        `No local room found for "${cleanCode}". Rooms in Local Demo only exist inside this browser — set up Firebase to play across devices.`
      );
    }
    const alreadyMember = Boolean(room.members && room.members[this.uid]);
    if (!alreadyMember && room.meta.locked && room.meta.hostUid !== this.uid) {
      throw new Error('This room is locked by the host right now.');
    }
    const memberCount = Object.keys(room.members || {}).length;
    if (!alreadyMember && memberCount >= MAX_PLAYERS) {
      throw new Error(`This room is full (max ${MAX_PLAYERS} players).`);
    }

    const cleanName = sanitizeName(name);
    if (!cleanName) throw new Error('Please enter a nickname first.');
    const safeColor = ((Number(colorIndex) || 0) % AVATAR_COLORS.length + AVATAR_COLORS.length) % AVATAR_COLORS.length;
    const now = Date.now();

    this._mutate(cleanCode, (r) => {
      const existing = r.members[this.uid];
      r.members[this.uid] = {
        uid: this.uid,
        name: cleanName,
        colorIndex: safeColor,
        joinedAt: existing ? existing.joinedAt : now,
      };
      r.meta.updatedAt = now;
      return r;
    });

    return { code: cleanCode };
  }

  subscribeRoom(code, onSnapshot) {
    const clean = normalizeRoomCode(code);
    if (!this.listeners.has(clean)) {
      this.listeners.set(clean, new Set());
    }
    this.listeners.get(clean).add(onSnapshot);

    // Emit initial state on next tick
    const room = readRawRoom(clean);
    onSnapshot(this._buildSafeSnapshot(room));

    return () => {
      const set = this.listeners.get(clean);
      if (!set) return;
      set.delete(onSnapshot);
      if (set.size === 0) {
        this.listeners.delete(clean);
      }
    };
  }

  async updateSettings(code, partial) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can change room settings.');
      if (r.meta.phase === 'rating') {
        throw new Error('Settings are locked while a round is in progress.');
      }
      r.meta.settings = {
        ...r.meta.settings,
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
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async updateDraftTopic(code, draftTopic) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) return r;
      r.meta.draftTopic = sanitizeTopic(draftTopic);
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async setRoomLocked(code, locked) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can lock or unlock the room.');
      r.meta.locked = Boolean(locked);
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async startRound(code, { topic, settings }) {
    const cleanTopic = sanitizeTopic(topic);
    if (!cleanTopic) throw new Error('Enter a topic before starting the round.');

    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can start a round.');
      const membersList = Object.values(r.members || {});
      const nextSettings = {
        allowSelfRating: Boolean(settings.allowSelfRating),
        visibility: settings.visibility === 'open' ? 'open' : 'anonymous',
        revealSelfInAnon: Boolean(settings.revealSelfInAnon),
      };

      if (!nextSettings.allowSelfRating && membersList.length < 2) {
        throw new Error('Need at least 2 players to start in "Others only" mode.');
      }
      if (membersList.length < 1) {
        throw new Error('Need at least 1 player to start a round.');
      }

      const nextNum = (r.meta.roundCount || 0) + 1;
      const roundId = `r${nextNum}`;
      const now = Date.now();

      const playerIds = {};
      const playerSnapshots = {};
      membersList.forEach((m) => {
        playerIds[m.uid] = true;
        playerSnapshots[m.uid] = {
          uid: m.uid,
          name: m.name,
          colorIndex: m.colorIndex || 0,
          joinedAt: m.joinedAt || now,
        };
      });

      r.rounds[roundId] = {
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
      r.submitted[roundId] = {};
      r.ballots[roundId] = {};

      r.meta.settings = nextSettings;
      r.meta.roundCount = nextNum;
      r.meta.currentRoundId = roundId;
      r.meta.phase = 'rating';
      r.meta.draftTopic = '';
      r.meta.updatedAt = now;
      return r;
    });
  }

  async submitBallot(code, roundId, rawScores) {
    this._mutate(code, (r) => {
      const round = r.rounds && r.rounds[roundId];
      if (!round) throw new Error('Round not found.');
      if (round.phase !== 'rating') {
        throw new Error('This round has already closed.');
      }
      if (!round.playerIds[this.uid]) {
        throw new Error('You joined mid-round and are spectating until the next round.');
      }
      const check = validateBallot(round, this.uid, rawScores);
      if (!check.valid) throw new Error(check.error);

      if (!r.ballots[roundId]) r.ballots[roundId] = {};
      if (!r.submitted[roundId]) r.submitted[roundId] = {};
      r.ballots[roundId][this.uid] = check.scores;
      r.submitted[roundId][this.uid] = Date.now();
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async revealRound(code, roundId) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can reveal scores.');
      const round = r.rounds && r.rounds[roundId];
      if (!round) throw new Error('Round not found.');
      if (round.phase === 'results') return r;
      const now = Date.now();
      round.phase = 'results';
      round.revealedAt = now;
      r.meta.phase = 'results';
      r.meta.updatedAt = now;
      return r;
    });
  }

  async returnToLobby(code) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can set up the next round.');
      r.meta.phase = 'lobby';
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async kickMember(code, targetUid) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can remove players.');
      if (targetUid === this.uid) throw new Error('Cannot remove yourself as host.');
      delete r.members[targetUid];
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async transferHost(code, newHostUid) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can pass host control.');
      if (!r.members[newHostUid]) throw new Error('Player is no longer in the room.');
      if (r.members[newHostUid].isBot) {
        throw new Error('Cannot assign a demo player as host.');
      }
      r.meta.hostUid = newHostUid;
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async leaveRoom(code) {
    const clean = normalizeRoomCode(code);
    const room = readRawRoom(clean);
    if (!room) return;
    this._mutate(clean, (r) => {
      delete r.members[this.uid];
      const realRemaining = Object.values(r.members).filter((m) => !m.isBot);
      if (realRemaining.length === 0) {
        return null; // Delete empty room automatically
      }
      if (r.meta.hostUid === this.uid) {
        realRemaining.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
        r.meta.hostUid = realRemaining[0].uid;
      }
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async closeRoom(code) {
    const clean = normalizeRoomCode(code);
    const room = readRawRoom(clean);
    if (!room) return;
    if (room.meta.hostUid !== this.uid) {
      throw new Error('Only the host can close and wipe the room.');
    }
    writeRawRoom(clean, null, this.channel);
    this._emit(clean);
  }

  // Local-only helpers for instant single-tab playtesting
  async addDemoBot(code) {
    this._mutate(code, (r) => {
      if (r.meta.hostUid !== this.uid) throw new Error('Only the host can add demo players.');
      const members = Object.values(r.members || {});
      if (members.length >= MAX_PLAYERS) {
        throw new Error(`Room is at max capacity (${MAX_PLAYERS}).`);
      }
      const taken = new Set(members.map((m) => m.name.toLowerCase()));
      const baseName =
        DEMO_BOT_NAMES.find((n) => !taken.has(n.toLowerCase())) ||
        `Guest ${members.length + 1}`;
      const botUid = `bot_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`;
      const colorIndex = members.length % AVATAR_COLORS.length;
      r.members[botUid] = {
        uid: botUid,
        name: baseName,
        colorIndex,
        joinedAt: Date.now() + members.length,
        isBot: true,
      };
      r.meta.updatedAt = Date.now();
      return r;
    });
  }

  async submitDemoBots(code, roundId) {
    let count = 0;
    this._mutate(code, (r) => {
      const round = r.rounds && r.rounds[roundId];
      if (!round || round.phase !== 'rating') return r;
      if (!r.ballots[roundId]) r.ballots[roundId] = {};
      if (!r.submitted[roundId]) r.submitted[roundId] = {};

      Object.values(r.members || {}).forEach((m) => {
        if (!m.isBot) return;
        if (!round.playerIds[m.uid]) return;
        if (r.submitted[roundId][m.uid]) return;
        r.ballots[roundId][m.uid] = generateBotBallot(round, m.uid);
        r.submitted[roundId][m.uid] = Date.now();
        count += 1;
      });
      r.meta.updatedAt = Date.now();
      return r;
    });
    return count;
  }
}
