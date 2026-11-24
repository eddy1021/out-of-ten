/**
 * Generates a high-resolution, mobile-friendly PNG result card on an offscreen
 * HTML5 <canvas> with zero external dependencies (works offline & across iOS/Android/desktop).
 *
 * Adaptive layout tiers:
 *   - 1–9 players   ("bars"):    Full visual 0–10 meter bars + range band + group tick + self diamond.
 *   - 10–20 players ("compact"): Dense scannable rows with crisp `avg (self)` numbers (e.g. `5.7 (4)`).
 *   - 21+ players   ("split"):   Top 10 and bottom 10 compact rows with an omitted-count divider.
 */

import {
  computeRoundResults,
  describeRoundRules,
  formatDelta,
  formatScore,
  getAvatarColor,
  getInitials,
} from './engine.js';

export const SHARE_BAR_MAX = 9;
export const SHARE_COMPACT_MAX = 20;
export const SHARE_SPLIT_COUNT = 10;

const CARD_WIDTH = 1080;
const PAD_X = 64;
const INNER_W = CARD_WIDTH - PAD_X * 2;

const COLORS = {
  canvasTop: '#F6F1E7',
  canvasBottom: '#EAE1D2',
  surface: '#FFFDFA',
  surfaceSoft: '#F6F2EA',
  surfaceGoldTop: '#FFFDF7',
  surfaceGoldBot: '#FBF4E1',
  inset: '#ECE6DA',
  border: 'rgba(28, 25, 23, 0.12)',
  borderGold: 'rgba(169, 113, 12, 0.34)',
  borderSage: 'rgba(29, 111, 90, 0.28)',
  ink1: '#1C1917',
  ink2: '#514A43',
  ink3: '#787067',
  accent: '#C94726',
  accentSoft: '#FAEAE4',
  accentInk: '#8F2D14',
  sage: '#1D6F5A',
  sageSoft: '#E3F2EC',
  sageInk: '#124E3F',
  gold: '#A9710C',
  goldSoft: '#F9EED2',
  goldInk: '#6D4704',
  slate: '#2F5B7C',
  slateSoft: '#E4EEF5',
  slateInk: '#1E405A',
};

const FONT_DISPLAY =
  '"Bricolage Grotesque", ui-rounded, "Avenir Next", "SF Pro Rounded", "Segoe UI", system-ui, sans-serif';
const FONT_BODY =
  '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';

/**
 * Pure helper picking the image layout mode & visible row groups based on player count.
 * Exported for unit testing.
 */
export function selectShareCardLayout(rows = []) {
  const total = rows.length;
  if (total <= SHARE_BAR_MAX) {
    return {
      mode: 'bars',
      label: total === 1 ? '1 player · bar chart' : `${total} players · bar chart`,
      total,
      sections: [{ title: null, rows }],
      omittedCount: 0,
    };
  }
  if (total <= SHARE_COMPACT_MAX) {
    return {
      mode: 'compact',
      label: `${total} players · compact scores`,
      total,
      sections: [{ title: null, rows }],
      omittedCount: 0,
    };
  }
  const top = rows.slice(0, SHARE_SPLIT_COUNT);
  const bottom = rows.slice(total - SHARE_SPLIT_COUNT);
  const omittedCount = total - SHARE_SPLIT_COUNT * 2;
  return {
    mode: 'split',
    label: `${total} players · top 10 & bottom 10`,
    total,
    sections: [
      { title: 'TOP 10', rows: top },
      { title: 'BOTTOM 10', rows: bottom },
    ],
    omittedCount,
  };
}

/**
 * Generates a clean PNG filename for a given round.
 */
export function buildShareFilename(round) {
  const num = round && round.number ? round.number : 1;
  const slug = String((round && round.topic) || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return slug ? `out-of-ten-r${num}-${slug}.png` : `out-of-ten-round-${num}.png`;
}

/**
 * Compatibility helper for older iOS Safari versions lacking `ctx.roundRect`.
 */
function roundedRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, fill, stroke = null, lineWidth = 1.5) {
  roundedRectPath(ctx, x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/**
 * Unicode-safe text wrapper supporting both spaces (English/Latin) and
 * long unspaced runs / CJK characters.
 */
function wrapText(ctx, text, maxWidth, maxLines = 4) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return [''];
  const chars = Array.from(clean);
  const lines = [];
  let current = '';

  const pushToken = (tok) => {
    const candidate = current ? current + tok : tok;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      return;
    }
    if (current) {
      lines.push(current.trimEnd());
      current = tok.trimStart();
      if (ctx.measureText(current).width <= maxWidth) return;
    }
    // Single token wider than maxWidth: wrap character by character
    let chunk = '';
    for (const ch of Array.from(tok.trimStart())) {
      if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    current = chunk;
  };

  // Tokenize keeping trailing spaces or CJK characters individually breakable
  let word = '';
  for (const ch of chars) {
    const code = ch.codePointAt(0) || 0;
    const isBreakableWide =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana/Katakana
      (code >= 0xac00 && code <= 0xd7af); // Hangul
    if (ch === ' ') {
      if (word) {
        pushToken(word);
        word = '';
      }
      if (current) pushToken(' ');
    } else if (isBreakableWide) {
      if (word) {
        pushToken(word);
        word = '';
      }
      pushToken(ch);
    } else {
      word += ch;
    }
  }
  if (word) pushToken(word);
  if (current.trim()) lines.push(current.trim());

  if (lines.length <= maxLines) return lines;
  const trimmed = lines.slice(0, maxLines);
  let last = trimmed[maxLines - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1).trimEnd();
  }
  trimmed[maxLines - 1] = `${last}…`;
  return trimmed;
}

function truncateText(ctx, text, maxWidth) {
  const s = String(text || '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  let cut = Array.from(s);
  while (cut.length > 1 && ctx.measureText(`${cut.join('')}…`).width > maxWidth) {
    cut.pop();
  }
  return `${cut.join('').trimEnd()}…`;
}

function drawPill(ctx, x, y, text, { bg, fg, border = null, font, height = 38, padX = 16 }) {
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  const w = Math.ceil(tw + padX * 2);
  fillRoundRect(ctx, x, y, w, height, height / 2, bg, border, 1.5);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + padX, y + height / 2 + 1);
  return w;
}

function drawBrandMark(ctx, x, y, size) {
  fillRoundRect(ctx, x, y, size, size, Math.round(size * 0.28), COLORS.accent);
  const scale = size / 24;
  ctx.fillStyle = 'rgba(255, 253, 250, 0.48)';
  fillRoundRect(ctx, x + 4.5 * scale, y + 12.5 * scale, 3.6 * scale, 7 * scale, 1.1 * scale, 'rgba(255,253,250,0.48)');
  fillRoundRect(ctx, x + 10.2 * scale, y + 9 * scale, 3.6 * scale, 10.5 * scale, 1.1 * scale, 'rgba(255,253,250,0.74)');
  fillRoundRect(ctx, x + 15.9 * scale, y + 4.5 * scale, 3.6 * scale, 15 * scale, 1.1 * scale, '#FFFDFA');
}

function drawAvatar(ctx, x, y, size, name, colorIndex) {
  const pal = getAvatarColor(colorIndex);
  const r = Math.round(size * 0.30);
  fillRoundRect(ctx, x, y, size, size, r, pal.bg);
  ctx.fillStyle = pal.fg;
  ctx.font = `700 ${Math.round(size * 0.40)}px ${FONT_DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(getInitials(name), x + size / 2, y + size / 2 + 1);
}

function drawBarModeRow(ctx, y, row, results, barRowH) {
  const isTop = row.rank === 1 && row.overallAvg !== null;
  const rowX = PAD_X;
  const rowW = INNER_W;
  const pad = 28;
  const showGap = results.showPublicSelfGap && row.selfScore !== null;
  const isAnon = !results.isOpen;

  ctx.save();
  ctx.shadowColor = 'rgba(28, 25, 23, 0.055)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 4;
  let fill = COLORS.surface;
  if (isTop) {
    const grad = ctx.createLinearGradient(0, y, 0, y + barRowH);
    grad.addColorStop(0, COLORS.surfaceGoldTop);
    grad.addColorStop(1, COLORS.surfaceGoldBot);
    fill = grad;
  }
  fillRoundRect(
    ctx,
    rowX,
    y,
    rowW,
    barRowH,
    24,
    fill,
    isTop ? COLORS.borderGold : COLORS.border,
    2
  );
  ctx.restore();

  // Rank badge
  const topY = y + 24;
  const rankSize = 52;
  fillRoundRect(
    ctx,
    rowX + pad,
    topY,
    rankSize,
    rankSize,
    14,
    isTop ? COLORS.goldSoft : COLORS.inset
  );
  ctx.font = `800 24px ${FONT_DISPLAY}`;
  ctx.fillStyle = isTop ? COLORS.goldInk : COLORS.ink2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(row.rank !== null ? `#${row.rank}` : '—', rowX + pad + rankSize / 2, topY + rankSize / 2 + 1);

  // Avatar
  const avX = rowX + pad + rankSize + 16;
  drawAvatar(ctx, avX, topY, rankSize, row.name, row.colorIndex);

  // Right score readout (`7.5` + optional `(10)`)
  const rightX = rowX + rowW - pad;
  const avgStr = row.overallAvg !== null ? formatScore(row.overallAvg) : '—';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';

  if (showGap) {
    const selfText = `(${row.selfScore})`;
    ctx.font = `700 28px ${FONT_DISPLAY}`;
    const selfW = ctx.measureText(selfText).width;
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(selfText, rightX, topY + 34);

    ctx.font = `800 44px ${FONT_DISPLAY}`;
    ctx.fillStyle = COLORS.ink1;
    ctx.fillText(avgStr, rightX - selfW - 10, topY + 36);

    ctx.font = `600 17px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink3;
    ctx.fillText('avg (self)', rightX, topY + 56);
  } else {
    ctx.font = `800 44px ${FONT_DISPLAY}`;
    ctx.fillStyle = COLORS.ink1;
    ctx.fillText(avgStr, rightX, topY + 36);

    ctx.font = `600 17px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink3;
    ctx.fillText('out of 10', rightX, topY + 56);
  }

  // Name + subtitle
  const nameX = avX + rankSize + 18;
  const reservedRight = showGap ? 220 : 155;
  const maxNameW = rowW - (nameX - rowX) - pad - reservedRight;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 30px ${FONT_DISPLAY}`;
  ctx.fillStyle = COLORS.ink1;
  ctx.fillText(truncateText(ctx, row.name, maxNameW), nameX, topY + 26);

  const sub =
    row.overallCount === 0
      ? 'No votes recorded'
      : row.minScore === row.maxScore
        ? `${row.overallCount} vote${row.overallCount === 1 ? '' : 's'} · unanimous`
        : `${row.overallCount} votes · range ${row.minScore}–${row.maxScore}`;
  ctx.font = `500 20px ${FONT_BODY}`;
  ctx.fillStyle = COLORS.ink3;
  ctx.fillText(sub, nameX, topY + 52);

  // Horizontal 0–10 comparison bar
  const trackX = rowX + pad + 6;
  const trackW = rowW - (pad + 6) * 2;
  const trackY = y + 102;
  const trackH = 16;

  fillRoundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2, COLORS.inset);

  // Range band (`min–max`)
  if (row.minScore !== null && row.maxScore !== null && row.overallCount >= 2) {
    const minPx = trackX + (row.minScore / 10) * trackW;
    const maxPx = trackX + (row.maxScore / 10) * trackW;
    fillRoundRect(
      ctx,
      minPx,
      trackY + 3,
      Math.max(maxPx - minPx, 8),
      trackH - 6,
      (trackH - 6) / 2,
      'rgba(28, 25, 23, 0.17)'
    );
  }

  // Avg bar fill
  if (row.overallAvg !== null && row.overallAvg > 0) {
    const fillW = Math.max((row.overallAvg / 10) * trackW, trackH);
    fillRoundRect(ctx, trackX, trackY, fillW, trackH, trackH / 2, isTop ? COLORS.gold : COLORS.ink1);
  }

  // Group avg tick marker (slate vertical bar)
  if (showGap && row.othersAvg !== null) {
    const gx = trackX + (row.othersAvg / 10) * trackW;
    fillRoundRect(ctx, gx - 4.5, trackY - 8, 9, trackH + 16, 4, COLORS.surface);
    fillRoundRect(ctx, gx - 2.5, trackY - 6, 5, trackH + 12, 2.5, COLORS.slate);
  }

  // Self diamond marker (terracotta rotated square)
  if (showGap && row.selfScore !== null) {
    const sx = trackX + (row.selfScore / 10) * trackW;
    const sy = trackY + trackH / 2;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(Math.PI / 4);
    fillRoundRect(ctx, -10.5, -10.5, 21, 21, 3.5, COLORS.surface);
    fillRoundRect(ctx, -8, -8, 16, 16, 2.5, COLORS.accent);
    ctx.restore();
  }

  // Footer details inside row (Self vs Group badges or sorted anonymous chips)
  const footY = y + 132;
  if (showGap) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const othersTxt = row.othersAvg !== null ? formatScore(row.othersAvg) : '—';
    const baseText = `Self ${row.selfScore}  ·  Group ${othersTxt}`;
    ctx.font = `600 20px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink2;
    ctx.fillText(baseText, rowX + pad, footY + 15);
    const btW = ctx.measureText(baseText).width;

    if (row.delta !== null) {
      let badgeBg = COLORS.sageSoft;
      let badgeFg = COLORS.sageInk;
      if (row.delta >= 0.45) {
        badgeBg = COLORS.accentSoft;
        badgeFg = COLORS.accentInk;
      } else if (row.delta <= -0.45) {
        badgeBg = COLORS.slateSoft;
        badgeFg = COLORS.slateInk;
      }
      drawPill(ctx, rowX + pad + btW + 14, footY + 1, `${formatDelta(row.delta)} vs group`, {
        bg: badgeBg,
        fg: badgeFg,
        font: `700 17px ${FONT_BODY}`,
        height: 28,
        padX: 11,
      });
    }
  } else if (isAnon && row.sortedScores && row.sortedScores.length > 0) {
    ctx.font = `500 18px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Scores (sorted, anonymous)', rowX + pad, footY + 15);

    const chips = row.sortedScores;
    const chipW = 34;
    const chipH = 29;
    const gap = 6;
    const totalChipW = chips.length * chipW + (chips.length - 1) * gap;
    let cx = rightX - totalChipW;
    chips.forEach((sc) => {
      fillRoundRect(ctx, cx, footY + 1, chipW, chipH, 8, COLORS.inset);
      ctx.font = `700 18px ${FONT_DISPLAY}`;
      ctx.fillStyle = COLORS.ink2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(sc), cx + chipW / 2, footY + 1 + chipH / 2 + 1);
      cx += chipW + gap;
    });
  } else if (row.sortedScores && row.sortedScores.length > 0) {
    ctx.font = `500 18px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink3;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Votes: ${row.sortedScores.join(' · ')}`, rowX + pad, footY + 15);
  }
}

function drawCompactRow(ctx, x, y, w, h, row, showSelf, isLast) {
  const isTop = row.rank === 1 && row.overallAvg !== null;
  if (isTop) {
    fillRoundRect(ctx, x + 2, y + 2, w - 4, h - 4, 14, COLORS.surfaceGoldBot);
  }

  const centerY = y + h / 2;

  // Rank label
  const rankBadgeW = 54;
  fillRoundRect(
    ctx,
    x + 20,
    centerY - 19,
    rankBadgeW,
    38,
    10,
    isTop ? COLORS.goldSoft : COLORS.inset
  );
  ctx.font = `800 20px ${FONT_DISPLAY}`;
  ctx.fillStyle = isTop ? COLORS.goldInk : COLORS.ink2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(row.rank !== null ? `#${row.rank}` : '—', x + 20 + rankBadgeW / 2, centerY + 1);

  // Small avatar chip
  drawAvatar(ctx, x + 88, centerY - 19, 38, row.name, row.colorIndex);

  // Right-side score: `5.7(4)` or `5.7`
  const rightX = x + w - 24;
  const avgStr = row.overallAvg !== null ? formatScore(row.overallAvg) : '—';
  const hasSelf = showSelf && row.selfScore !== null;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  let reservedRight = 130;

  if (hasSelf) {
    // Laser-aligned fixed columns so 1-digit `(4)` and 2-digit `(10)` never shift the average left/right
    const selfColW = 70;
    const avgRightX = rightX - selfColW;
    const selfText = `(${row.selfScore})`;

    ctx.font = `700 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = COLORS.accent;
    ctx.textAlign = 'left';
    ctx.fillText(selfText, avgRightX + 8, centerY + 1);

    ctx.font = `800 29px ${FONT_DISPLAY}`;
    ctx.fillStyle = COLORS.ink1;
    ctx.textAlign = 'right';
    ctx.fillText(avgStr, avgRightX, centerY + 1);

    reservedRight = selfColW + 96;

    // Optional signed delta badge aligned consistently to the left of AVG
    if (row.delta !== null) {
      const dTxt = formatDelta(row.delta);
      let dBg = COLORS.sageSoft;
      let dFg = COLORS.sageInk;
      if (row.delta >= 0.45) {
        dBg = COLORS.accentSoft;
        dFg = COLORS.accentInk;
      } else if (row.delta <= -0.45) {
        dBg = COLORS.slateSoft;
        dFg = COLORS.slateInk;
      }
      const pillW = 76;
      const px = avgRightX - 96 - pillW;
      fillRoundRect(ctx, px, centerY - 13, pillW, 26, 13, dBg);
      ctx.font = `700 17px ${FONT_BODY}`;
      ctx.fillStyle = dFg;
      ctx.textAlign = 'center';
      ctx.fillText(dTxt, px + pillW / 2, centerY + 0.5);
      reservedRight = selfColW + 96 + pillW + 24;
    }
  } else {
    ctx.font = `800 29px ${FONT_DISPLAY}`;
    ctx.fillStyle = COLORS.ink1;
    ctx.fillText(avgStr, rightX, centerY + 1);
    if (row.minScore !== null && row.maxScore !== null) {
      const rangeStr = `${row.minScore}–${row.maxScore}`;
      ctx.font = `500 18px ${FONT_BODY}`;
      ctx.fillStyle = COLORS.ink3;
      ctx.fillText(rangeStr, rightX - 90, centerY + 1);
      reservedRight = 185;
    }
  }

  // Name
  const nameX = x + 142;
  const maxNameW = w - (nameX - x) - reservedRight - 20;
  ctx.font = `700 25px ${FONT_DISPLAY}`;
  ctx.fillStyle = COLORS.ink1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(truncateText(ctx, row.name, maxNameW), nameX, centerY + 1);

  if (!isLast) {
    ctx.fillStyle = 'rgba(28, 25, 23, 0.08)';
    ctx.fillRect(x + 20, y + h - 1, w - 40, 1.5);
  }
}

/**
 * Draws the full shareable results card onto an offscreen canvas and resolves with
 * `{ dataUrl, blob, file, filename, width, height, layout, results }`.
 *
 * Respects round privacy rules: in strict anonymous mode other players' self-ratings
 * are NEVER rendered. Optionally shows *only* the viewer's own personal Self vs. Group
 * box when `includeMyPrivateSelf` is explicitly enabled.
 */
export async function renderRoundShareImage(
  round,
  ballotsByVoter = {},
  { currentUid = null, includeMyPrivateSelf = false, roomCode = '' } = {}
) {
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise((r) => setTimeout(r, 900)),
      ]);
    } catch {
      // Ignore font load timeouts
    }
  }

  const results = computeRoundResults(round, ballotsByVoter, currentUid, 'overall');
  const rules = describeRoundRules(round);
  const layout = selectShareCardLayout(results.rows);
  const isOpen = results.isOpen;
  const showPrivateBox =
    Boolean(includeMyPrivateSelf) &&
    results.allowSelfRating &&
    !results.showPublicSelfGap &&
    Boolean(results.mySelfInsight);

  // Measure topic wrap height using a scratch canvas
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');
  const topicText = round.topic || 'Untitled topic';
  const topicFontSize = topicText.length > 75 ? 44 : topicText.length > 42 ? 52 : 58;
  const topicLineH = Math.round(topicFontSize * 1.16);
  sctx.font = `800 ${topicFontSize}px ${FONT_DISPLAY}`;
  const topicLines = wrapText(sctx, topicText, INNER_W - 72, 4);

  // Compute exact dynamic height cleanly (portrait card, crisp padding)
  const headerTopPad = 56;
  const brandRowH = 62;
  const heroPadTop = 36;
  const heroMetaH = 38;
  const heroTopicH = topicLines.length * topicLineH;
  const heroSubH = 36;
  const heroCardH = heroPadTop + heroMetaH + 18 + heroTopicH + 22 + heroSubH + 28;

  const privateBoxH = showPrivateBox ? 112 : 0;
  const privateGap = showPrivateBox ? 22 : 0;

  const showAwards = results.awards.length > 0;
  const displayAwards = showAwards ? results.awards.slice(0, 3) : [];
  const awardsH = showAwards ? 116 : 0;
  const awardsGap = showAwards ? 24 : 0;

  const legendH = 44;

  let bodyH = 0;
  const BAR_ROW_H = 178;
  const BAR_ROW_GAP = 16;
  const COMPACT_ROW_H = 64;
  const COMPACT_HEAD_H = 48;

  if (layout.mode === 'bars') {
    const n = layout.rows ? layout.rows.length : layout.sections[0].rows.length;
    bodyH = n > 0 ? n * BAR_ROW_H + (n - 1) * BAR_ROW_GAP : 100;
  } else if (layout.mode === 'compact') {
    const n = layout.sections[0].rows.length;
    bodyH = COMPACT_HEAD_H + n * COMPACT_ROW_H + 12;
  } else {
    // split: Top 10 + omitted divider + Bottom 10
    const topN = layout.sections[0].rows.length;
    const botN = layout.sections[1].rows.length;
    bodyH =
      (COMPACT_HEAD_H + topN * COMPACT_ROW_H + 10) +
      62 +
      (COMPACT_HEAD_H + botN * COMPACT_ROW_H + 10);
  }

  const footerH = 88;
  const totalHeight = Math.ceil(
    headerTopPad +
      brandRowH +
      26 +
      heroCardH +
      privateGap +
      privateBoxH +
      awardsGap +
      awardsH +
      28 +
      legendH +
      14 +
      bodyH +
      footerH
  );

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = totalHeight;
  const ctx = canvas.getContext('2d');

  // 1. Warm tactile paper background
  const bgGrad = ctx.createLinearGradient(0, 0, 0, totalHeight);
  bgGrad.addColorStop(0, COLORS.canvasTop);
  bgGrad.addColorStop(1, COLORS.canvasBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, CARD_WIDTH, totalHeight);

  const washA = ctx.createRadialGradient(140, 120, 10, 140, 120, 620);
  washA.addColorStop(0, 'rgba(201, 71, 38, 0.09)');
  washA.addColorStop(1, 'rgba(201, 71, 38, 0)');
  ctx.fillStyle = washA;
  ctx.fillRect(0, 0, CARD_WIDTH, totalHeight);

  const washB = ctx.createRadialGradient(CARD_WIDTH - 80, totalHeight - 160, 10, CARD_WIDTH - 80, totalHeight - 160, 560);
  washB.addColorStop(0, 'rgba(29, 111, 90, 0.08)');
  washB.addColorStop(1, 'rgba(29, 111, 90, 0)');
  ctx.fillStyle = washB;
  ctx.fillRect(0, 0, CARD_WIDTH, totalHeight);

  let y = headerTopPad;

  // 2. Brand Header
  drawBrandMark(ctx, PAD_X, y + 6, 48);
  ctx.font = `800 32px ${FONT_DISPLAY}`;
  ctx.fillStyle = COLORS.ink1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Out of Ten', PAD_X + 62, y + 31);

  const codePillText = roomCode ? `ROOM ${roomCode}` : `ROUND ${round.number}`;
  ctx.font = `700 20px ${FONT_BODY}`;
  const pillW = Math.ceil(ctx.measureText(codePillText).width + 32);
  drawPill(ctx, PAD_X + INNER_W - pillW, y + 11, codePillText, {
    bg: COLORS.surface,
    fg: COLORS.ink2,
    border: COLORS.border,
    font: `700 20px ${FONT_BODY}`,
    height: 40,
    padX: 16,
  });

  y += brandRowH + 26;

  // 3. Topic Hero Card
  ctx.save();
  ctx.shadowColor = 'rgba(28, 25, 23, 0.07)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  fillRoundRect(ctx, PAD_X, y, INNER_W, heroCardH, 28, COLORS.surface, COLORS.border, 2);
  ctx.restore();

  const hx = PAD_X + 36;
  let hy = y + heroPadTop;

  ctx.font = `700 20px ${FONT_BODY}`;
  ctx.fillStyle = COLORS.ink3;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `ROUND ${round.number}  ·  ${results.voterCount} OF ${results.eligibleCount} VOTED`,
    hx,
    hy + 19
  );

  // Mode pills on right side of hero meta row
  const selfPillTxt = rules.selfLabel;
  const visPillTxt = isOpen ? 'Open votes' : 'Anonymous';
  ctx.font = `700 18px ${FONT_BODY}`;
  const spW = Math.ceil(ctx.measureText(selfPillTxt).width + 26);
  const vpW = Math.ceil(ctx.measureText(visPillTxt).width + 28);
  drawPill(ctx, PAD_X + INNER_W - 36 - spW, hy + 2, selfPillTxt, {
    bg: COLORS.inset,
    fg: COLORS.ink2,
    font: `700 18px ${FONT_BODY}`,
    height: 34,
    padX: 13,
  });
  drawPill(ctx, PAD_X + INNER_W - 36 - spW - 10 - vpW, hy + 2, visPillTxt, {
    bg: isOpen ? COLORS.goldSoft : COLORS.sageSoft,
    fg: isOpen ? COLORS.goldInk : COLORS.sageInk,
    font: `700 18px ${FONT_BODY}`,
    height: 34,
    padX: 14,
  });

  hy += heroMetaH + 18;
  ctx.font = `800 ${topicFontSize}px ${FONT_DISPLAY}`;
  ctx.fillStyle = COLORS.ink1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  topicLines.forEach((line, idx) => {
    ctx.fillText(line, hx, hy + idx * topicLineH);
  });

  hy += heroTopicH + 22;
  ctx.font = `500 21px ${FONT_BODY}`;
  ctx.fillStyle = COLORS.ink3;
  ctx.textBaseline = 'middle';
  ctx.fillText(`${rules.shortTag}  ·  ${layout.label}`, hx, hy + heroSubH / 2);

  y += heroCardH;

  // 4. Optional Private Self vs Group Card (only when opted in on strict anonymous rounds)
  if (showPrivateBox) {
    y += privateGap;
    const insight = results.mySelfInsight;
    const hasOthers = insight.othersAvg !== null && insight.othersCount > 0;
    fillRoundRect(ctx, PAD_X, y, INNER_W, privateBoxH, 24, COLORS.sageSoft, COLORS.borderSage, 2);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 17px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.sageInk;
    ctx.fillText(`${insight.name.toUpperCase()}’S SELF CHECK-IN (OPTIONAL)`, PAD_X + 30, y + 24);

    let note = 'Only you scored yourself this round.';
    if (hasOthers && insight.delta !== null) {
      if (insight.delta >= 0.45) note = `Rated self ${formatDelta(insight.delta)} higher than the group.`;
      else if (insight.delta <= -0.45) note = `Rated self ${formatDelta(insight.delta)} below the group average.`;
      else note = 'Spot on with the group average!';
    }
    ctx.font = `700 24px ${FONT_DISPLAY}`;
    ctx.fillText(truncateText(ctx, note, 540), PAD_X + 30, y + 54);

    const drawMiniStat = (cx, label, val) => {
      ctx.textAlign = 'left';
      ctx.font = `700 15px ${FONT_BODY}`;
      ctx.fillStyle = 'rgba(18, 78, 63, 0.78)';
      ctx.fillText(label, cx, y + 25);
      ctx.font = `800 34px ${FONT_DISPLAY}`;
      ctx.fillStyle = COLORS.sageInk;
      ctx.fillText(val, cx, y + 49);
    };
    drawMiniStat(PAD_X + INNER_W - 320, 'SELF', String(insight.selfScore));
    drawMiniStat(PAD_X + INNER_W - 220, 'GROUP', hasOthers ? formatScore(insight.othersAvg) : '—');
    drawMiniStat(PAD_X + INNER_W - 110, 'GAP', hasOthers ? formatDelta(insight.delta) : '—');

    y += privateBoxH;
  }

  // 5. Compact Awards Row (up to 3 highlights)
  if (displayAwards.length > 0) {
    y += awardsGap;
    const gap = 16;
    const cardW = (INNER_W - gap * (displayAwards.length - 1)) / displayAwards.length;
    displayAwards.forEach((a, i) => {
      const ax = PAD_X + i * (cardW + gap);
      fillRoundRect(ctx, ax, y, cardW, awardsH, 20, COLORS.surface, COLORS.border, 1.5);
      const toneColor =
        a.tone === 'gold'
          ? COLORS.gold
          : a.tone === 'accent'
            ? COLORS.accent
            : a.tone === 'sage'
              ? COLORS.sage
              : COLORS.slate;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `700 16px ${FONT_BODY}`;
      ctx.fillStyle = toneColor;
      ctx.fillText(a.label.toUpperCase(), ax + 22, y + 20);

      ctx.font = `700 25px ${FONT_DISPLAY}`;
      ctx.fillStyle = COLORS.ink1;
      ctx.fillText(truncateText(ctx, a.names, cardW - 44), ax + 22, y + 46);

      ctx.font = `500 18px ${FONT_BODY}`;
      ctx.fillStyle = COLORS.ink2;
      ctx.fillText(truncateText(ctx, a.detail, cardW - 44), ax + 22, y + 78);
    });
    y += awardsH;
  }

  // 6. Section Title & Legend Row
  y += 28;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `800 27px ${FONT_DISPLAY}`;
  ctx.fillStyle = COLORS.ink1;
  ctx.fillText(
    layout.mode === 'split' ? 'Top 10 & Bottom 10' : 'Ranked Results',
    PAD_X + 4,
    y + legendH / 2
  );

  if (layout.mode === 'bars' && results.showPublicSelfGap) {
    // Visual bar legend right-aligned
    let lx = PAD_X + INNER_W - 6;
    ctx.textAlign = 'right';
    ctx.font = `600 19px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink2;
    ctx.fillText('Self', lx, y + legendH / 2);
    lx -= ctx.measureText('Self').width + 18;
    ctx.save();
    ctx.translate(lx, y + legendH / 2);
    ctx.rotate(Math.PI / 4);
    fillRoundRect(ctx, -6, -6, 12, 12, 2, COLORS.accent);
    ctx.restore();
    lx -= 28;

    ctx.fillStyle = COLORS.ink2;
    ctx.fillText('Group avg', lx, y + legendH / 2);
    lx -= ctx.measureText('Group avg').width + 14;
    fillRoundRect(ctx, lx - 2, y + legendH / 2 - 9, 4, 18, 2, COLORS.slate);
  } else if (layout.mode !== 'bars') {
    ctx.textAlign = 'right';
    ctx.font = `600 19px ${FONT_BODY}`;
    ctx.fillStyle = COLORS.ink3;
    ctx.fillText(
      results.showPublicSelfGap ? 'Format: avg (self) · gap vs group' : 'Format: avg / 10 (range)',
      PAD_X + INNER_W - 4,
      y + legendH / 2
    );
  }

  y += legendH + 14;

  // 7. Adaptive Leaderboard Body
  if (layout.mode === 'bars') {
    const rows = layout.sections[0].rows;
    rows.forEach((row, idx) => {
      drawBarModeRow(ctx, y, row, results, BAR_ROW_H);
      y += BAR_ROW_H + (idx < rows.length - 1 ? BAR_ROW_GAP : 0);
    });
  } else {
    layout.sections.forEach((sec, sIdx) => {
      const boxH = COMPACT_HEAD_H + sec.rows.length * COMPACT_ROW_H + 10;
      ctx.save();
      ctx.shadowColor = 'rgba(28, 25, 23, 0.055)';
      ctx.shadowBlur = 18;
      ctx.shadowOffsetY = 5;
      fillRoundRect(ctx, PAD_X, y, INNER_W, boxH, 24, COLORS.surface, COLORS.border, 2);
      ctx.restore();

      // Compact card column header
      ctx.fillStyle = COLORS.surfaceSoft;
      roundedRectPath(ctx, PAD_X + 1, y + 1, INNER_W - 2, COMPACT_HEAD_H, 22);
      ctx.fill();
      ctx.fillRect(PAD_X + 1, y + COMPACT_HEAD_H - 18, INNER_W - 2, 18);
      ctx.fillStyle = 'rgba(28, 25, 23, 0.08)';
      ctx.fillRect(PAD_X + 1, y + COMPACT_HEAD_H, INNER_W - 2, 1.5);

      ctx.font = `700 16px ${FONT_BODY}`;
      ctx.fillStyle = COLORS.ink3;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(sec.title ? `${sec.title} · PLAYER` : 'PLAYER', PAD_X + 24, y + COMPACT_HEAD_H / 2);

      if (results.showPublicSelfGap) {
        const hdrRightX = PAD_X + INNER_W - 24;
        const avgRightX = hdrRightX - 70;
        ctx.textAlign = 'center';
        ctx.fillText('GAP', avgRightX - 96 - 38, y + COMPACT_HEAD_H / 2);
        ctx.textAlign = 'right';
        ctx.fillText('AVG', avgRightX, y + COMPACT_HEAD_H / 2);
        ctx.textAlign = 'left';
        ctx.fillText('(SELF)', avgRightX + 8, y + COMPACT_HEAD_H / 2);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText('RANGE  ·  AVG', PAD_X + INNER_W - 24, y + COMPACT_HEAD_H / 2);
      }

      let ry = y + COMPACT_HEAD_H + 5;
      sec.rows.forEach((row, rIdx) => {
        drawCompactRow(
          ctx,
          PAD_X,
          ry,
          INNER_W,
          COMPACT_ROW_H,
          row,
          results.showPublicSelfGap,
          rIdx === sec.rows.length - 1
        );
        ry += COMPACT_ROW_H;
      });
      y += boxH;

      // Divider between Top 10 & Bottom 10
      if (sIdx === 0 && layout.mode === 'split') {
        const divY = y + 31;
        ctx.strokeStyle = 'rgba(28, 25, 23, 0.18)';
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 7]);
        ctx.beginPath();
        ctx.moveTo(PAD_X + 40, divY);
        ctx.lineTo(PAD_X + INNER_W - 40, divY);
        ctx.stroke();
        ctx.setLineDash([]);

        const midTxt = `${layout.omittedCount} middle player${layout.omittedCount === 1 ? '' : 's'} hidden`;
        ctx.font = `700 18px ${FONT_BODY}`;
        const mw = Math.ceil(ctx.measureText(midTxt).width + 34);
        drawPill(ctx, (CARD_WIDTH - mw) / 2, divY - 17, midTxt, {
          bg: COLORS.canvasBottom,
          fg: COLORS.ink2,
          border: COLORS.border,
          font: `700 18px ${FONT_BODY}`,
          height: 34,
          padX: 17,
        });
        y += 62;
      }
    });
  }

  // 8. Footer watermark with date (handy when looking back at saved photos!)
  const footMidY = totalHeight - footerH / 2;
  const roundTs = round.revealedAt || round.startedAt || Date.now();
  let dateLabel = '';
  try {
    dateLabel = new Date(roundTs).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    dateLabel = '';
  }
  const footParts = ['Out of Ten', 'Scale 0–10'];
  if (dateLabel) footParts.push(dateLabel);
  ctx.font = `600 19px ${FONT_BODY}`;
  ctx.fillStyle = COLORS.ink3;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(footParts.join('  ·  '), CARD_WIDTH / 2, footMidY);

  // Convert to PNG blob + data URL (data URL also enables reliable long-press "Save to Photos" on iOS Safari)
  const dataUrl = canvas.toDataURL('image/png');
  const blob = await new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } else {
      resolve(null);
    }
  });
  const filename = buildShareFilename(round);
  let file = null;
  if (blob && typeof File !== 'undefined') {
    try {
      file = new File([blob], filename, { type: 'image/png' });
    } catch {
      file = null;
    }
  }

  return {
    dataUrl,
    blob,
    file,
    filename,
    width: CARD_WIDTH,
    height: totalHeight,
    layout,
    results,
  };
}

/**
 * Checks whether the current browser supports sharing a PNG file via the native
 * Web Share sheet (iOS Safari 15+, Android Chrome, etc.).
 */
export function canNativeShareFile(file) {
  if (!file || typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    return Boolean(navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}
