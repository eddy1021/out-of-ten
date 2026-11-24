/**
 * Pure, deterministic game engine for "Out of Ten".
 * Shared across Local Demo transport and Firebase Realtime Database transport.
 */

export const MAX_PLAYERS = 30;
export const MIN_SCORE = 0;
export const MAX_SCORE = 10;
export const MAX_NAME_LEN = 24;
export const MAX_TOPIC_LEN = 140;

// Unambiguous Crockford-like alphabet (omits 0, 1, I, L, O)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Warm, accessible ink-safe avatar palette matching the paper aesthetic
export const AVATAR_COLORS = [
  { bg: '#F4DDD4', fg: '#9A3318', label: 'Terracotta' },
  { bg: '#D6ECE5', fg: '#155C4A', label: 'Pine' },
  { bg: '#F4E8C7', fg: '#805709', label: 'Ochre' },
  { bg: '#D7E5F0', fg: '#234C6B', label: 'Slate' },
  { bg: '#F1DBE2', fg: '#842E4C', label: 'Berry' },
  { bg: '#E3E9D3', fg: '#3E5722', label: 'Olive' },
  { bg: '#E8DFD3', fg: '#5B452E', label: 'Umber' },
  { bg: '#D5EBE8', fg: '#1A5757', label: 'Teal' },
];

export const PROMPT_CATEGORIES = [
  {
    category: 'Skills & Hobbies',
    prompts: [
      'How good at basketball?',
      'How good at cooking a surprise dinner from scratch?',
      'How fast at assembling IKEA furniture without losing a screw?',
      'How likely to beat everyone here at Mario Kart?',
      'How good at singing karaoke in front of strangers?',
      'How skilled at parallel parking under pressure?',
      'How good at keeping a houseplant alive for a full year?',
      'How good at taking a flattering group photo?',
    ],
  },
  {
    category: 'Everyday Vibes',
    prompts: [
      'How punctual when we say "meet at 7:00 sharp"?',
      'How fast at replying to group chat texts?',
      'How chaotic is their sleep schedule?',
      'How likely to lose their keys, wallet, or phone on a trip?',
      'How dramatic when they catch a mild cold?',
      'How good at giving directions without using a phone?',
      'How easily talked into ordering late-night dessert?',
      'How likely to overpack for a two-night weekend trip?',
    ],
  },
  {
    category: 'Wild Scenarios',
    prompts: [
      'How long would they survive in a zombie apocalypse?',
      'How believable when telling an outrageous lie with a straight face?',
      'How likely to accidentally befriend a stray animal on vacation?',
      'How calm during a mild flight turbulence?',
      'How good at negotiating the bill down at a flea market?',
      'How likely to win a reality show built on strategy alone?',
      'How good at planning a surprise trip for everyone?',
      'How likely to show up to the wrong restaurant?',
    ],
  },
  {
    category: 'Social & Party',
    prompts: [
      'How fast at making friends at a party where they know nobody?',
      'How competitive during a "casual" board game?',
      'How good at picking the movie everyone agrees on?',
      'How trustworthy with a really good secret?',
      'How likely to start dancing first at a wedding?',
      'How great a road-trip DJ / aux cord host?',
      'How good at remembering everyone’s birthday without a calendar?',
      'How bold when choosing spice level at a restaurant?',
    ],
  },
];

export const ALL_PROMPTS = PROMPT_CATEGORIES.flatMap((c) => c.prompts);

export const DEMO_BOT_NAMES = [
  'Mia', 'Leo', 'Sam', 'Zoe', 'Noah', 'Chloe', 'Kai', 'Maya', 'Eli', 'Juno',
];

export function generateRoomCode(length = 6) {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function formatRoomCode(code) {
  const clean = normalizeRoomCode(code);
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)}-${clean.slice(3)}`;
}

export function isValidRoomCode(code) {
  const clean = normalizeRoomCode(code);
  if (clean.length !== 6) return false;
  for (const ch of clean) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LEN);
}

export function sanitizeTopic(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TOPIC_LEN);
}

export function isValidScore(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SCORE &&
    value <= MAX_SCORE
  );
}

export function getInitials(name) {
  const clean = sanitizeName(name);
  if (!clean) return '?';
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

export function getAvatarColor(colorIndex = 0) {
  const len = AVATAR_COLORS.length;
  const idx = ((Math.floor(Number(colorIndex) || 0) % len) + len) % len;
  return AVATAR_COLORS[idx];
}

export function pickRandomPrompt(currentTopic = '') {
  const trimmed = sanitizeTopic(currentTopic).toLowerCase();
  const candidates = ALL_PROMPTS.filter((p) => p.toLowerCase() !== trimmed);
  const pool = candidates.length ? candidates : ALL_PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Returns the ordered list of target players a given voter must rate in a round.
 * Respects `round.allowSelfRating`.
 */
export function getTargetsForVoter(round, voterUid) {
  if (!round || !round.playerSnapshots) return [];
  const all = Object.values(round.playerSnapshots)
    .filter((p) => p && round.playerIds && round.playerIds[p.uid])
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.name.localeCompare(b.name));

  if (round.allowSelfRating) {
    // Move current voter's self row first only? Keep shared order consistent with subtle tag.
    return all;
  }
  return all.filter((p) => p.uid !== voterUid);
}

/**
 * Validates that a ballot contains whole integers 0..10 for every expected target,
 * and rejects self-score if allowSelfRating is false.
 */
export function validateBallot(round, voterUid, rawScores) {
  const targets = getTargetsForVoter(round, voterUid);
  if (!targets.length) {
    return { valid: false, error: 'No players available to rate.' };
  }
  const cleanScores = {};
  const missing = [];

  for (const target of targets) {
    const val = rawScores ? rawScores[target.uid] : undefined;
    if (!isValidScore(val)) {
      missing.push(target.name);
    } else {
      cleanScores[target.uid] = val;
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      error: `Missing a whole-number rating (0–10) for ${missing.length} player${missing.length === 1 ? '' : 's'}.`,
    };
  }

  return { valid: true, scores: cleanScores };
}

/**
 * Generates an honest, zero-surprise rule summary displayed BEFORE a round starts
 * and locked inside the rating view.
 */
export function describeRoundRules(settings) {
  const allowSelf = Boolean(settings.allowSelfRating);
  const isOpen = settings.visibility === 'open';
  const revealSelfInAnon = Boolean(settings.revealSelfInAnon);

  if (isOpen) {
    if (allowSelf) {
      return {
        visibilityLabel: 'Open votes',
        selfLabel: 'Include self',
        headline:
          'Everyone will see who gave which score. Your self-rating is shown for comparison only and is NOT counted in your average.',
        shortTag: 'Avg excludes self · Names & self-rating shown',
      };
    }
    return {
      visibilityLabel: 'Open votes',
      selfLabel: 'Others only',
      headline: 'Everyone will see who gave which score. You do not rate yourself.',
      shortTag: 'Individual ratings shown with names',
    };
  }

  // Anonymous mode
  if (allowSelf && revealSelfInAnon) {
    return {
      visibilityLabel: 'Anonymous votes',
      selfLabel: 'Include self',
      headline:
        'Individual ratings stay hidden — only the average and min–max range are shown. Self-ratings are NOT counted in averages, and each player’s self-rating vs. group IS shown publicly.',
      shortTag: 'Individual votes hidden · Avg excludes self · Self shown',
    };
  }

  if (allowSelf) {
    return {
      visibilityLabel: 'Anonymous votes',
      selfLabel: 'Include self',
      headline:
        'Individual ratings stay hidden — only the average (excluding self-rating) and min–max range are shown. Your own Self vs. Group comparison is shown privately only to you.',
      shortTag: 'Individual votes hidden · Avg excludes self',
    };
  }

  return {
    visibilityLabel: 'Anonymous votes',
    selfLabel: 'Others only',
    headline:
      'Individual ratings stay hidden — only the average and min–max range are shown. You do not rate yourself.',
    shortTag: 'Individual votes hidden · No self-rating',
  };
}

export function roundNum(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(1);
}

export function formatDelta(delta) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return '—';
  const rounded = roundNum(delta, 1);
  if (Math.abs(rounded) < 0.05) return '0.0';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

/**
 * Deterministic standard competition ranking ("1, 2, 2, 4") comparing to 2 decimal places.
 */
function assignRanks(rows, metricKey) {
  let lastScore = null;
  let lastRank = 0;
  return rows.map((row, i) => {
    const val = row[metricKey];
    if (val === null || val === undefined) {
      return { ...row, rank: null };
    }
    const key = Math.round(val * 1000);
    if (lastScore === null || key !== lastScore) {
      lastRank = i + 1;
      lastScore = key;
    }
    return { ...row, rank: lastRank };
  });
}

/**
 * Computes leaderboard rows, privacy-aware breakdowns, private self insight,
 * and superlative awards for a round.
 *
 * NOTE: A player's average, rank, range, spread, and anonymous score chips are
 * computed STRICTLY from OTHER players' ratings (never including self-rating).
 * Self-rating is kept strictly separate to show Self vs. Group comparison.
 *
 * @param {object} round - round descriptor
 * @param {object} ballotsByVoter - map `{ [voterUid]: { [targetUid]: integer 0..10 } }`
 * @param {string} currentUid - viewer's own uid (for private self insight in strict anonymous mode)
 * @param {string} sortBy - 'overall' | 'delta'
 */
export function computeRoundResults(round, ballotsByVoter = {}, currentUid = null, sortBy = 'overall') {
  if (!round || !round.playerSnapshots) {
    return {
      rows: [],
      voterCount: 0,
      eligibleCount: 0,
      isOpen: false,
      allowSelfRating: false,
      showPublicSelfGap: false,
      mySelfInsight: null,
      awards: [],
    };
  }

  const players = Object.values(round.playerSnapshots)
    .filter((p) => p && round.playerIds && round.playerIds[p.uid])
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0) || a.name.localeCompare(b.name));

  const isOpen = round.visibility === 'open';
  const allowSelfRating = Boolean(round.allowSelfRating);
  const showPublicSelfGap = allowSelfRating && (isOpen || Boolean(round.revealSelfInAnon));

  const validVoterUids = Object.keys(ballotsByVoter || {}).filter(
    (voterUid) => round.playerIds && round.playerIds[voterUid] && ballotsByVoter[voterUid]
  );

  const rawRows = players.map((player) => {
    const peerScores = [];
    const openBreakdown = [];
    let selfScore = null;

    for (const voterUid of validVoterUids) {
      const voterBallot = ballotsByVoter[voterUid];
      if (!voterBallot || !Object.prototype.hasOwnProperty.call(voterBallot, player.uid)) {
        continue;
      }
      const val = voterBallot[player.uid];
      if (!isValidScore(val)) continue;

      const isSelf = voterUid === player.uid;
      if (isSelf && !allowSelfRating) continue;

      if (isSelf) {
        selfScore = val;
      } else {
        peerScores.push(val);
      }

      if (isOpen) {
        const voterMeta = round.playerSnapshots[voterUid] || { uid: voterUid, name: 'Player', colorIndex: 0 };
        openBreakdown.push({
          voterUid,
          voterName: voterMeta.name,
          colorIndex: voterMeta.colorIndex || 0,
          score: val,
          isSelf,
        });
      }
    }

    const peerSum = peerScores.reduce((acc, n) => acc + n, 0);
    const peerAvg = peerScores.length ? peerSum / peerScores.length : null;
    const rawDelta =
      selfScore !== null && peerAvg !== null ? selfScore - peerAvg : null;

    const minScore = peerScores.length ? Math.min(...peerScores) : null;
    const maxScore = peerScores.length ? Math.max(...peerScores) : null;
    const spread = minScore !== null && maxScore !== null ? maxScore - minScore : null;

    // Individual anonymous votes are intentionally withheld (only avg and min–max range exposed)
    const sortedScores = isOpen ? [...peerScores].sort((a, b) => a - b) : null;

    // Sort open breakdown: self first (not included in avg), then score desc, then name
    openBreakdown.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.voterName.localeCompare(b.voterName);
    });

    // Public-safe vs private fields so the UI never accidentally renders secret data in strict anonymous mode
    return {
      uid: player.uid,
      name: player.name,
      colorIndex: player.colorIndex || 0,
      overallAvg: peerAvg,
      overallCount: peerScores.length,
      minScore,
      maxScore,
      spread,
      sortedScores,
      // Peer average excluding self (identical to overallAvg)
      othersAvg: peerAvg,
      othersCount: peerScores.length,
      // Only expose self-rating & delta on row when policy allows it publicly
      selfScore: showPublicSelfGap ? selfScore : null,
      delta: showPublicSelfGap ? rawDelta : null,
      openBreakdown: isOpen ? openBreakdown : null,
      // Keep internal metrics solely for personal viewer card check below
      _privateSelf: player.uid === currentUid ? selfScore : null,
      _privateOthersAvg: player.uid === currentUid ? peerAvg : null,
      _privateOthersCount: player.uid === currentUid ? peerScores.length : 0,
      _privateDelta: player.uid === currentUid ? rawDelta : null,
    };
  });

  // Extract the viewer's own private Self vs. Group insight card (always safe to show to self!)
  let mySelfInsight = null;
  if (allowSelfRating && currentUid) {
    const mine = rawRows.find((r) => r.uid === currentUid);
    if (mine && mine._privateSelf !== null) {
      mySelfInsight = {
        uid: mine.uid,
        name: mine.name,
        selfScore: mine._privateSelf,
        othersAvg: mine._privateOthersAvg,
        othersCount: mine._privateOthersCount,
        overallAvg: mine.overallAvg,
        delta: mine._privateDelta,
      };
    }
  }

  // Strip private underscore markers before handing rows to UI
  const cleanRows = rawRows.map(
    ({ _privateSelf, _privateOthersAvg, _privateOthersCount, _privateDelta, ...rest }) => rest
  );

  // Pick sort metric (fall back cleanly to overall if requested sort isn't permitted/available)
  let effectiveSort = sortBy === 'delta' && showPublicSelfGap ? 'delta' : 'overall';

  const compareNullableDesc = (a, b) => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  };

  // Pre-compute peer-avg rank first for tie-safe canonical numbering
  const byOverall = [...cleanRows].sort((a, b) => {
    const cmp = compareNullableDesc(a.overallAvg, b.overallAvg);
    if (Math.abs(cmp) > 1e-6) return cmp;
    const scmp = compareNullableDesc(a.overallCount, b.overallCount);
    if (scmp !== 0) return scmp;
    return a.name.localeCompare(b.name);
  });
  const overallRankMap = new Map();
  assignRanks(byOverall, 'overallAvg').forEach((r) => overallRankMap.set(r.uid, r.rank));

  let sortedRows;
  if (effectiveSort === 'delta') {
    sortedRows = [...cleanRows].sort((a, b) => {
      const cmp = compareNullableDesc(a.delta, b.delta);
      if (Math.abs(cmp) > 1e-6) return cmp;
      return compareNullableDesc(a.overallAvg, b.overallAvg) || a.name.localeCompare(b.name);
    });
    sortedRows = sortedRows.map((r, i) => ({ ...r, rank: r.delta === null ? null : i + 1 }));
  } else {
    sortedRows = assignRanks(byOverall, 'overallAvg');
  }

  sortedRows = sortedRows.map((r) => ({
    ...r,
    overallRank: overallRankMap.get(r.uid),
  }));

  // Compute fun superlatives using only publicly permitted fields
  const awards = [];
  const scoredRows = byOverall.filter((r) => r.overallAvg !== null);
  if (scoredRows.length >= 1) {
    const topAvg = scoredRows[0].overallAvg;
    const leaders = scoredRows.filter((r) => Math.abs(r.overallAvg - topAvg) < 0.001);
    awards.push({
      id: 'top',
      label: leaders.length > 1 ? 'Co-Leaders' : 'Top Ranked',
      names: leaders.map((l) => l.name).join(' & '),
      detail: `${formatScore(topAvg)} / 10 avg`,
      tone: 'gold',
    });
  }

  const spreadRows = scoredRows.filter((r) => r.overallCount >= 2 && r.spread !== null);
  if (spreadRows.length >= 2) {
    const maxSpread = Math.max(...spreadRows.map((r) => r.spread));
    const minSpread = Math.min(...spreadRows.map((r) => r.spread));
    if (maxSpread > 0) {
      const spicy = spreadRows.filter((r) => r.spread === maxSpread);
      awards.push({
        id: 'split',
        label: 'Biggest Split',
        names: spicy.map((l) => l.name).join(' & '),
        detail: `${spicy[0].minScore}–${spicy[0].maxScore} range (${maxSpread} pt gap)`,
        tone: 'accent',
      });
    }
    if (minSpread < maxSpread) {
      const agreed = spreadRows.filter((r) => r.spread === minSpread);
      awards.push({
        id: 'consensus',
        label: 'Most Unanimous',
        names: agreed.map((l) => l.name).join(' & '),
        detail: minSpread === 0 ? `All scored ${agreed[0].minScore}` : `${minSpread} pt range`,
        tone: 'sage',
      });
    }
  }

  if (showPublicSelfGap) {
    const deltaRows = scoredRows.filter((r) => r.delta !== null);
    if (deltaRows.length >= 1) {
      const maxDelta = Math.max(...deltaRows.map((r) => r.delta));
      if (maxDelta >= 0.45) {
        const confident = deltaRows.filter((r) => Math.abs(r.delta - maxDelta) < 0.05);
        awards.push({
          id: 'confident',
          label: 'Highest Self-Belief',
          names: confident.map((l) => l.name).join(' & '),
          detail: `${formatDelta(maxDelta)} vs. group`,
          tone: 'accent',
        });
      }
      const minDelta = Math.min(...deltaRows.map((r) => r.delta));
      if (minDelta <= -0.45) {
        const humble = deltaRows.filter((r) => Math.abs(r.delta - minDelta) < 0.05);
        awards.push({
          id: 'humble',
          label: 'Most Humble',
          names: humble.map((l) => l.name).join(' & '),
          detail: `${formatDelta(minDelta)} vs. group`,
          tone: 'slate',
        });
      }
      const bestMatch = Math.min(...deltaRows.map((r) => Math.abs(r.delta)));
      if (bestMatch <= 0.75 && deltaRows.length >= 2) {
        const spotOn = deltaRows.filter((r) => Math.abs(Math.abs(r.delta) - bestMatch) < 0.05);
        awards.push({
          id: 'accurate',
          label: 'Most Self-Aware',
          names: spotOn.map((l) => l.name).join(' & '),
          detail: `${formatDelta(spotOn[0].delta)} from group avg`,
          tone: 'sage',
        });
      }
    }
  }

  return {
    rows: sortedRows,
    voterCount: validVoterUids.length,
    eligibleCount: players.length,
    isOpen,
    allowSelfRating,
    showPublicSelfGap,
    effectiveSort,
    mySelfInsight,
    awards: awards.slice(0, 4),
  };
}

/**
 * Generates a plain-text leaderboard summary safe for pasting into group chat.
 * Strictly respects anonymity settings so no hidden data leaks on export.
 */
export function buildShareSummary(round, ballotsByVoter = {}) {
  const res = computeRoundResults(round, ballotsByVoter, null, 'overall');
  const rules = describeRoundRules(round);
  const lines = [
    `Out of Ten — Round ${round.number}: ${round.topic}`,
    `Mode: ${rules.visibilityLabel} · ${rules.selfLabel} (${res.voterCount}/${res.eligibleCount} voted${res.allowSelfRating ? ', avg excl. self' : ''})`,
    '',
  ];
  res.rows.forEach((row) => {
    const rankStr = row.rank !== null ? `#${row.rank}` : '—';
    const avgStr = row.overallAvg !== null ? `${formatScore(row.overallAvg)}/10` : 'No peer votes';
    if (res.showPublicSelfGap && row.selfScore !== null) {
      if (row.overallAvg !== null) {
        lines.push(
          `${rankStr} ${row.name} — ${avgStr} (self: ${row.selfScore}, ${formatDelta(row.delta)} vs avg)`
        );
      } else {
        lines.push(`${rankStr} ${row.name} — ${avgStr} (self: ${row.selfScore})`);
      }
    } else if (row.minScore !== null) {
      lines.push(`${rankStr} ${row.name} — ${avgStr} (range ${row.minScore}–${row.maxScore})`);
    } else {
      lines.push(`${rankStr} ${row.name} — ${avgStr}`);
    }
  });
  return lines.join('\n');
}

/**
 * Generates natural-looking whole-number ratings for demo bots so solo testers
 * can experience ties, spreads, and Self vs. Group deltas realistically.
 */
export function generateBotBallot(round, botUid) {
  const targets = getTargetsForVoter(round, botUid);
  const ballot = {};
  // Seed a playful cluster bias per target so rankings spread across 3..9 cleanly
  targets.forEach((t) => {
    let hash = 0;
    const key = `${round.id}:${t.uid}`;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash * 31 + key.charCodeAt(i)) % 997;
    }
    const base = 3 + (hash % 6); // 3..8
    const jitter = Math.floor(Math.random() * 5) - 2; // -2..+2
    const isSelf = t.uid === botUid;
    const bump = isSelf ? (Math.random() > 0.4 ? 1 : -1) : 0;
    ballot[t.uid] = Math.max(MIN_SCORE, Math.min(MAX_SCORE, base + jitter + bump));
  });
  return ballot;
}
