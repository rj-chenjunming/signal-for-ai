/** Local, fixed SVG paths only. Task names and messages never enter this markup. */
(() => {
  const paths: Record<string, string> = {
    codex: '<path d="M12 6V3.8"/><circle cx="12" cy="2.8" r="1"/><rect x="4.5" y="6" width="15" height="14" rx="4"/><path d="M4.5 11H2v4h2.5M19.5 11H22v4h-2.5M9 16q3 2 6 0"/><rect x="8" y="10" width="2" height="3" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="10" width="2" height="3" rx="1" fill="currentColor" stroke="none"/>',
    dsh: '<path d="M9 5V2.5M9 3.5 6.8 2.8M9 3.5l2.2-.7"/><path d="M3 11.5C3.7 8.7 6 7 9.5 7c4 0 6.7 2.5 7.2 6 2-.1 3.6-1.3 4.8-3-.1 3.6-1.5 5.6-4.4 6C15.1 19.3 8.3 21 4.4 18.2 2.1 16.6 1.7 13.9 3 11.5Z"/><circle cx="6.6" cy="11.2" r=".65" fill="currentColor" stroke="none"/><path d="M4.8 14.2q1.8 1.8 3.7.1M10.5 16l1.7 2.1"/>',
    workbuddy: '<path d="M5 9V3.5L9 6a11 11 0 0 1 6 0l4-2.5V9a7 7 0 0 1 2 5c0 4-4 6.5-9 6.5S3 18 3 14a7 7 0 0 1 2-5Z"/><circle cx="8.3" cy="11.8" r=".75" fill="currentColor" stroke="none"/><circle cx="15.7" cy="11.8" r=".75" fill="currentColor" stroke="none"/><path d="m11 14 1 1 1-1M12 15v1m0 0q-1.2 1.8-2.4.4M12 16q1.2 1.8 2.4.4M5.5 14l-3.5-1M5.5 16H2M18.5 14l3.5-1M18.5 16H22"/>',
    'dsh-web': '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="M2.5 7.5h19"/><circle cx="5.5" cy="5.3" r=".55" fill="currentColor" stroke="none"/><circle cx="8" cy="5.3" r=".55" fill="currentColor" stroke="none"/><path d="M5.5 14c0-2.2 1.8-3.6 4.1-3.6 2.5 0 4.3 1.7 4.6 4 1.3-.1 2.5-.9 3.3-1.9-.1 2.2-1.1 3.5-3.1 3.8-1.7 2.1-5 2.7-7.1 1.2-1.3-.9-1.8-2.2-1.8-3.5Z"/><circle cx="8.6" cy="13.4" r=".55" fill="currentColor" stroke="none"/>',
    generic: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    // SPEC-025：目标清单图标（靶心 + 十字刻度，与既有工具图标同一线宽/圆角风格）
    goals: '<circle cx="12" cy="12" r="7.4"/><circle cx="12" cy="12" r="3.4"/><path d="M12 2.2v2.9M12 18.9v2.9M2.2 12h2.9M18.9 12h2.9"/><circle cx="12" cy="12" r=".9" fill="currentColor" stroke="none"/>',
  };
  window.aiIndicatorUi = {
    icon: kind => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] ?? paths.generic}</svg>`,
  };
})();
