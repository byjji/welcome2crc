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

/* ---------- 러닝 시간 · 페이스 ---------- */
/* "30:00" 또는 "1:05:30" → 초 (형식이 틀리면 null) */
export function parseTimeStr(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const sec = m[3] !== undefined
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    : Number(m[1]) * 60 + Number(m[2]);
  return sec > 0 ? sec : null;
}

export function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtPace(secPerKm) {
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) { m++; s = 0; }
  return `${m}'${String(s).padStart(2, "0")}"`;
}

/* ---------- 일정 카테고리 색 ---------- */
/* 기본 카테고리는 고정 색, 새로 만든 카테고리는 이름 기반 자동 배정
   (러닝·이벤트는 예전 기본값으로 만든 일정을 위해 색만 유지) */
export const CAT_COLORS = { "대회": "#d94f2b", "정기런": "#e8871e", "모임": "#2f9e6e", "러닝": "#e8871e", "이벤트": "#7c5cd6" };
const CAT_FALLBACK_COLORS = ["#3a7bd5", "#c4527a", "#5f8f3e", "#b8860b", "#5e6ad2"];

export function catColor(cat) {
  if (CAT_COLORS[cat]) return CAT_COLORS[cat];
  let h = 0;
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
