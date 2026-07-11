/* ============================================================
   icons.js — 인라인 SVG 라인 아이콘 (레이스 데이 디자인)
   2px 스트로크 · 각진 끝처리(square/miter) · currentColor 상속
   크기는 글자 크기(1em)를 따라가므로 font-size로 조절
   ============================================================ */

const PATHS = {
  /* 당근 — 잎 3갈래 + 삼각 몸통 (로고·출석 스탬프·갤러리 자리표시) */
  carrot: '<path d="M12 8.5 7.5 3.5M12 8.5V2.8M12 8.5l4.5-5"/><path d="M8.2 9h7.6L12 21.5 8.2 9z"/><path d="M9.8 13h4.4M10.9 16.8h2.2"/>',
  home: '<path d="M4 11.5 12 4.5l8 7"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5.5h4V20"/>',
  calendar: '<rect x="4.5" y="6.5" width="15" height="13.5"/><path d="M4.5 10.5h15M8.5 3.5V7M15.5 3.5V7"/>',
  megaphone: '<path d="M4 10v4h4.5l10 5.5v-15L8.5 10H4z"/><path d="M7.2 14.5 8.5 20"/>',
  users: '<circle cx="9" cy="7.8" r="3.3"/><path d="M3.5 19.5v-.4c0-3 2.4-4.8 5.5-4.8s5.5 1.8 5.5 4.8v.4"/><path d="M15.6 4.9a3.3 3.3 0 0 1 0 5.8M17.4 14.8c2 .7 3.1 2.2 3.1 4.3v.4"/>',
  sliders: '<path d="M4 8h8.7M17.3 8H20"/><rect x="12.7" y="5.7" width="4.6" height="4.6"/><path d="M4 16h2.7M11.3 16H20"/><rect x="6.7" y="13.7" width="4.6" height="4.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21 6.8 13.7A6.5 6.5 0 1 1 17.2 13.7L12 21z"/><circle cx="12" cy="9.6" r="2"/>',
  pushpin: '<path d="M9 3.5h6l-.8 6 2.8 2v2H7v-2l2.8-2-.8-6z"/><path d="M12 13.5V20"/>',
  crown: '<path d="M5 18.5 4 9.5l5 2.5 3-6 3 6 5-2.5-1 9H5z"/>',
  pencil: '<path d="m4.5 19.5 1-4 10-10 3 3-10 10-4 1z"/><path d="m13.5 7.5 3 3"/>',
  flag: '<path d="M6 21V4h11.5L15 8l2.5 4H6"/>',
  key: '<circle cx="8" cy="16" r="4"/><path d="m11 13 8.5-8.5M16.5 7.5 19 10"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5"/><path d="M8.2 11V7.3a3.8 3.8 0 0 1 7.6 0V11"/><path d="M12 14.5v2.5"/>',
  vote: '<rect x="4.5" y="4.5" width="15" height="15"/><path d="m8 12.5 3 3L16.5 9"/>',
};

export function ic(name, cls = "") {
  const d = PATHS[name];
  if (!d) return "";
  return `<svg class="svg-ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${d}</svg>`;
}

/* 로고용 두 색 당근 마크 (몸통 주황 + 잎 초록) — 헤더·스피너·auth 로고 */
export function carrotMark(cls = "") {
  return `<svg class="svg-ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path stroke="var(--leaf, #3a7e31)" d="M12 8.5 7.5 3.5M12 8.5V2.8M12 8.5l4.5-5"/><path stroke="var(--carrot-vivid, #e07a2c)" d="M8.2 9h7.6L12 21.5 8.2 9zM9.8 13h4.4M10.9 16.8h2.2"/></svg>`;
}
