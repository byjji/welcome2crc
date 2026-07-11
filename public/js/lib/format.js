/* ============================================================
   lib/format.js — 표시/계산 공통 유틸
   ------------------------------------------------------------
   HTML 이스케이프 · 날짜/월 · 러닝 시간/페이스 · 카테고리 색
   (화면과 무관한 순수 함수만 — Firebase 의존 없음)
   ============================================================ */

/* ---------- HTML 이스케이프 (사용자 입력 안전 처리) ---------- */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function escMultiline(s) {
  return esc(s).replace(/\n/g, "<br />");
}

/* ---------- 날짜 ---------- */
export const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtDate(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

export function parseDateParts(dateStr) {
  // "2026-07-08" → {month: "7월", day: "8", dow: "수요일"}
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return { month: `${m}월`, day: String(d), dow: `${dow}요일` };
}

export function dday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}

export function addDaysStr(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function thisMonthKey() { return todayStr().slice(0, 7); }   // "2026-07"

export function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return `${y}년 ${m}월`;
}

/* ---------- 일정 카테고리 색 ---------- */
/* 기본 카테고리는 고정 색, 새로 만든 카테고리는 이름 기반 자동 배정
   (러닝·이벤트는 예전 기본값으로 만든 일정을 위해 색만 유지)
   → 로고 팔레트(차분한 테라코타·잎색)에 맞춘 뮤트 톤 */
const CAT_COLORS = { "대회": "#39bdff", "정기런": "#d4502f", "모임": "#44b135", "번개런": "#dcd32a", "이벤트": "#6b5bb5" };
const CAT_FALLBACK_COLORS = ["#d7a47d", "#e5e5e5", "#004f3b", "#00c0c0", "#5a63b8"];

/* 운영진이 카테고리 만들 때 고른 색 (site/eventCategories 의 colors 맵) — init.js 가 주입 */
let customCatColors = {};
export function setCatColors(map) { customCatColors = map || {}; }

export function catColor(cat) {
  if (customCatColors[cat]) return customCatColors[cat]; // 사용자가 고른 색이 최우선
  if (CAT_COLORS[cat]) return CAT_COLORS[cat];           // 기본 카테고리 고정색
  let h = 0;                                             // 그 외엔 이름 기반 자동 배정
  for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAT_FALLBACK_COLORS[h % CAT_FALLBACK_COLORS.length];
}

/* D-day 카드 그라데이션용: 색을 살짝 어둡게 */
export function shadeColor(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

/* 파스텔 배지용: 색을 흰색과 혼합해 밝게 (f=0~1, 클수록 밝음) */
function tintColor(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v) => Math.round(v + (255 - v) * f);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

/* 카테고리 배지 인라인 스타일: 파스텔 배경 + 진한 글자 (대비 확보 원칙) */
export function catBadgeStyle(cat) {
  const c = catColor(cat);
  return `background:${tintColor(c, 0.84)};color:${shadeColor(c, 0.62)}`;
}
