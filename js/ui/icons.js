const P = {
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  target: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  alert: '<path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18v.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  cam: '<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  gear: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M16 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
export const icon = (name, style = '') => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${style ? ` style="${style}"` : ''}>${P[name]}</svg>`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTime = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };

/** 같은 그룹(data-single) 안에서 하나만 눌리게 하는 칩 동작. */
export function bindChips(root) {
  root.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip, .rate button');
    if (!chip || !root.contains(chip)) return;
    const box = chip.parentElement;
    if (box.hasAttribute('data-single')) box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === chip)));
    else chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
    box.dispatchEvent(new CustomEvent('chipchange', { bubbles: true }));
  });
}
export const pressedValue = (box) => box.querySelector('[aria-pressed="true"]')?.dataset.v;
