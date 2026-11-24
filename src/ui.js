/**
 * Safe DOM, HTML escaping, SVG icons, toast, and modal helpers for "Out of Ten".
 */

import { getAvatarColor, getInitials } from './engine.js';

const ESC_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

export function renderAvatar(name, colorIndex = 0, sizeClass = '') {
  const palette = getAvatarColor(colorIndex);
  const initials = getInitials(name);
  const cls = sizeClass ? `avatar ${sizeClass}` : 'avatar';
  return `<span class="${cls}" style="background:${palette.bg};color:${palette.fg}" aria-hidden="true">${esc(initials)}</span>`;
}

export const ICONS = {
  lock: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  eye: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 10s3.2-5 8-5 8 5 8 5-3.2 5-8 5-8-5-8-5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>`,
  copy: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.8" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 13V5.5A1.5 1.5 0 0 1 6 4h7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  shuffle: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 6h3.5l5.5 8H17M3 14h3.5l1.8-2.6M11.6 8.2L13 6h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 3.8L17 6l-2.5 2.2M14.5 11.8L17 14l-2.5 2.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  list: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  chevron: `<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 8l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  share: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v9M6.5 6.5L10 3l3.5 3.5M4 12v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  unlock: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M7 9V6.5a3 3 0 0 1 5.6-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  image: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="8.2" r="1.2" fill="currentColor"/><path d="M4.5 14l3.5-3.5 2.5 2.5 2-2 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  download: `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3.5v9M6.5 9.5L10 13l3.5-3.5M4 15.5h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

export function showToast(message, tone = 'neutral', durationMs = 2600) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${tone === 'error' ? 'is-error' : tone === 'success' ? 'is-success' : ''}`;
  el.textContent = message;
  const existingSame = Array.from(stack.children).find((c) => c.textContent === message);
  if (existingSame) existingSame.remove();

  stack.appendChild(el);

  while (stack.children.length > 2) {
    stack.removeChild(stack.firstElementChild);
  }

  setTimeout(() => {
    el.style.transition = 'opacity 180ms ease, transform 180ms ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 200);
  }, durationMs);
}

export async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy textarea fallback
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

let modalCleanup = null;

export function openModal({ title, bodyHtml, footerHtml = '', onMount = null }) {
  const backdrop = document.getElementById('modal-backdrop');
  const titleEl = document.getElementById('modal-title');
  const bodyEl = document.getElementById('modal-body');
  const footerEl = document.getElementById('modal-footer');
  const closeBtn = document.getElementById('modal-close');

  if (modalCleanup) modalCleanup();

  titleEl.textContent = title;
  bodyEl.innerHTML = bodyHtml;
  if (footerHtml) {
    footerEl.innerHTML = footerHtml;
    footerEl.hidden = false;
  } else {
    footerEl.innerHTML = '';
    footerEl.hidden = true;
  }

  backdrop.hidden = false;
  document.body.style.overflow = 'hidden';

  const handleClose = () => closeModal();
  const handleBackdropClick = (e) => {
    if (e.target === backdrop) handleClose();
  };
  const handleKey = (e) => {
    if (e.key === 'Escape') handleClose();
  };

  closeBtn.addEventListener('click', handleClose);
  backdrop.addEventListener('click', handleBackdropClick);
  document.addEventListener('keydown', handleKey);

  modalCleanup = () => {
    closeBtn.removeEventListener('click', handleClose);
    backdrop.removeEventListener('click', handleBackdropClick);
    document.removeEventListener('keydown', handleKey);
    document.body.style.overflow = '';
    modalCleanup = null;
  };

  if (onMount) {
    onMount({ bodyEl, footerEl, close: handleClose });
  }
  const panel = document.getElementById('modal-panel');
  if (panel) {
    panel.setAttribute('tabindex', '-1');
    panel.focus({ preventScroll: true });
  }
}

export function closeModal() {
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  if (modalCleanup) modalCleanup();
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: `<p style="margin:0;color:var(--ink-2);line-height:1.55;">${esc(message)}</p>`,
      footerHtml: `
        <button type="button" class="btn btn-ghost btn-sm" id="confirm-cancel">Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger-soft' : 'btn-primary'} btn-sm" id="confirm-ok">${esc(confirmLabel)}</button>
      `,
      onMount: ({ footerEl, close }) => {
        const cancelBtn = footerEl.querySelector('#confirm-cancel');
        const okBtn = footerEl.querySelector('#confirm-ok');
        let settled = false;
        const finish = (val) => {
          if (settled) return;
          settled = true;
          close();
          resolve(val);
        };
        cancelBtn.addEventListener('click', () => finish(false));
        okBtn.addEventListener('click', () => finish(true));
        const origCleanup = modalCleanup;
        modalCleanup = () => {
          if (origCleanup) origCleanup();
          if (!settled) {
            settled = true;
            resolve(false);
          }
        };
      },
    });
  });
}
