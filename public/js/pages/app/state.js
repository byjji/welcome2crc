/* ============================================================
   pages/app/state.js — 크루 공간 공유 상태
   ------------------------------------------------------------
   화면 모듈들이 함께 읽는 데이터. import 한 쪽에서는 값이
   실시간으로 보이고(라이브 바인딩), 바꿀 때는 set* 함수를 씁니다.
   ============================================================ */
export const DEFAULT_EVENT_CATS = ["대회", "정기런", "모임"];
export const ATT_CAT = "정기런"; // 출석 현황(출첵)으로 집계되는 카테고리

/* ---------- 로그인 세션 ---------- */
export let me = null;          // 로그인한 auth 유저
export let myProfile = null;   // members/{uid} 문서 데이터
export let isAdmin = false;

export function setMe(v) { me = v; }
export function setMyProfile(v) { myProfile = v; }
export function setIsAdmin(v) { isAdmin = v; }

/* 가입신청서에서 받은 정보 (members 문서 생성 시 사용) */
export let signupName = "";
export let signupExtra = null;
export function setSignupName(v) { signupName = v; }
export function setSignupExtra(v) { signupExtra = v; }

/* ---------- 실시간 데이터 ---------- */
export const state = {
  notices: [],
  events: [],
  polls: [],
  members: [],
  attendance: {},   // eventId → { uid: {name, status, dist?, sec?} }
  votes: {},        // pollId → { uid: {name, option} }
  eventCats: [...DEFAULT_EVENT_CATS],  // 일정 카테고리 (site/eventCategories)
  mileage: {},      // uid → { name, note(각오), goal(목표km), km(현재km) }
};

/* ---------- 화면 상태 ---------- */
export let eventCatFilter = "all";   // 일정 목록 카테고리 필터
export let statMonth = null;         // 출석 현황·랭킹에서 보고 있는 달 ("2026-07")
export let monthAtt = {};            // eventId → 출석 맵 (지난 일정 캐시)
export const monthLoaded = new Set(); // 출석 데이터를 받아온 달
export let attDayId = null;          // '출석 현황'에서 칩으로 선택한 정기런

export function setEventCatFilter(v) { eventCatFilter = v; }
export function setStatMonth(v) { statMonth = v; }
export function setAttDayId(v) { attDayId = v; }

/* 로그아웃/계정 전환 시 데이터 초기화 (리스너 해제는 init.js 가 담당) */
export function resetData() {
  state.notices = [];
  state.events = [];
  state.polls = [];
  state.members = [];
  state.attendance = {};
  state.votes = {};
  state.eventCats = [...DEFAULT_EVENT_CATS];
  state.mileage = {};
  eventCatFilter = "all";
  statMonth = null;
  monthAtt = {};
  monthLoaded.clear();
  attDayId = null;
}
