/* ============================================================
   pages/app/init.js — 크루 공간 본체
   ------------------------------------------------------------
   로그인 상태 라우팅 · 실시간 구독 시작/정리 · 하단 탭 전환.
   각 화면의 렌더링/폼 처리는 화면 모듈이 담당합니다.
   ============================================================ */
import { $, closeModal, initModals } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
import { onSwipe } from "../../lib/swipe.js";
import { esc, todayStr, setCatColors } from "../../lib/format.js";
import {
  auth, db, onAuthStateChanged, signOut,
  collection, doc, getDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp,
} from "../../lib/firebase.js";
import { showView } from "./views.js";
import {
  state, DEFAULT_EVENT_CATS,
  me, setMe, myProfile, setMyProfile, isAdmin, setIsAdmin,
  signupName, signupExtra, resetData,
} from "./state.js";
import "./auth.js"; // 로그인·가입신청·비밀번호 찾기·내 정보 폼 바인딩
import { renderHome } from "./home.js";
import { renderNotices, renderPolls } from "./news.js";
import { renderMembers } from "./members.js";
import {
  renderEventCatRow, renderEvents, renderStatsIfLoaded,
  ensureMonthData, renderMileage,
} from "./events.js";

initModals();

/* ---------- 로그아웃 ---------- */
$("btnLogout").addEventListener("click", () => signOut(auth));
$("btnLogoutPending").addEventListener("click", () => signOut(auth));
$("btnLogoutRejected").addEventListener("click", () => signOut(auth));

/* ============================================================
   1. 로그인 상태 → 화면 라우팅
   ============================================================ */
let profileUnsub = null;

onAuthStateChanged(auth, async (user) => {
  cleanupAll();
  closeModal("resetModal");
  closeModal("profileModal");
  setMe(user);

  if (!user) {
    $("appUser").hidden = true;
    showView("login");
    return;
  }

  showView("loading");

  // 멤버 문서가 없으면 '승인 대기' 상태로 생성
  const myRef = doc(db, "members", user.uid);
  try {
    const snap = await getDoc(myRef);
    if (!snap.exists()) {
      await setDoc(myRef, {
        name: user.displayName || signupName || user.email.split("@")[0],
        email: user.email || "",
        role: "pending",
        createdAt: serverTimestamp(),
        ...(signupExtra || {}), // 가입신청서 정보 (성별·연락처·사는 곳·연령대·대회 경력·하고 싶은 말)
      });
    }
  } catch (err) {
    console.error("멤버 문서 확인 실패:", err);
  }

  // 내 문서를 실시간 구독 → 운영진이 승인하면 자동으로 화면 전환
  profileUnsub = onSnapshot(myRef, (snap) => {
    if (!snap.exists()) {
      // 운영진이 기록까지 삭제한 경우 → 다시 대기 상태로
      setMyProfile(null);
      setIsAdmin(false);
      showView("pending");
      $("pendingName").textContent = user.displayName || user.email;
      return;
    }
    setMyProfile(snap.data());
    setIsAdmin(myProfile.role === "admin");

    $("appUser").hidden = false;
    $("userName").innerHTML = `${esc(myProfile.name)}${isAdmin ? ` ${ic("crown", "ic-crown")}` : ""}`;
    $("adminPageLink").hidden = !isAdmin;

    if (myProfile.role === "pending") {
      $("pendingName").textContent = myProfile.name;
      showView("pending");
    } else if (myProfile.role === "rejected" || myProfile.role === "removed") {
      // 거절/내보내기 공용 안내 화면 (문구만 다르게)
      const removed = myProfile.role === "removed";
      $("rejectedName").textContent = myProfile.name;
      $("rejectedTitle").textContent = removed ? "크루에서 나가게 되었어요" : "가입이 승인되지 않았어요";
      $("rejectedDesc").textContent = removed
        ? "운영진에 의해 크루에서 나가게 되었어요."
        : "아쉽지만 이번 가입 신청은 승인되지 않았어요.";
      showView("rejected");
    } else {
      enterApp();
    }
  }, (err) => {
    console.error("프로필 구독 오류:", err);
  });
});

let appEntered = false;

function enterApp() {
  document.querySelectorAll(".admin-form").forEach((el) => (el.hidden = !isAdmin));
  $("adminSection").hidden = !isAdmin;
  showView("app");

  // 관리 화면의 하단 탭에서 넘어온 경우: #tab=events 같은 해시로 해당 탭 열기
  const wanted = location.hash.match(/^#tab=(events|news|members)$/);
  if (wanted) {
    switchTab(wanted[1]);
    history.replaceState(null, "", location.pathname); // 해시 소비 (새로고침하면 홈부터)
  }

  if (appEntered) {
    renderAll();
    return;
  }
  appEntered = true;
  startListeners();
}

/* ---------- 리스너 해제 + 데이터 초기화 ---------- */
let unsubs = [];                 // 컬렉션 리스너
let attendanceUnsubs = {};       // eventId → unsub
let voteUnsubs = {};             // pollId → unsub

function cleanupAll() {
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.values(attendanceUnsubs).forEach((u) => u());
  attendanceUnsubs = {};
  Object.values(voteUnsubs).forEach((u) => u());
  voteUnsubs = {};
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  appEntered = false;
  resetData();
}

/* ============================================================
   2. 실시간 데이터 구독
   ============================================================ */
function startListeners() {
  unsubs.push(onSnapshot(
    query(collection(db, "notices"), orderBy("createdAt", "desc")),
    (qs) => {
      state.notices = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotices();
      renderHome();
    },
    (e) => console.error("공지 구독 오류:", e)
  ));

  unsubs.push(onSnapshot(
    query(collection(db, "events"), orderBy("date", "asc")),
    (qs) => {
      state.events = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      syncAttendanceListeners();
      renderEvents();
      renderHome();
      renderStatsIfLoaded();
    },
    (e) => console.error("일정 구독 오류:", e)
  ));

  // 일정 카테고리 목록 (운영진이 추가/삭제한 내용 실시간 반영)
  unsubs.push(onSnapshot(
    doc(db, "site", "eventCategories"),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const list = data.list;
      state.eventCats = Array.isArray(list) && list.length ? list : [...DEFAULT_EVENT_CATS];
      state.eventCatColors = data.colors || {};
      setCatColors(state.eventCatColors); // 카테고리 색을 format.js 에 반영 (배지·D-day 등 전역)
      renderEventCatRow();
      renderEvents();  // 색 바뀐 걸 일정 카드에도 반영
      renderHome();
    },
    (e) => console.error("일정 카테고리 구독 오류:", e)
  ));

  unsubs.push(onSnapshot(
    query(collection(db, "polls"), orderBy("createdAt", "desc")),
    (qs) => {
      state.polls = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      syncVoteListeners();
      renderPolls();
      renderHome();
    },
    (e) => console.error("투표 구독 오류:", e)
  ));

  unsubs.push(onSnapshot(
    collection(db, "members"),
    (qs) => {
      state.members = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMembers();
      renderHome();
      renderMileage();
      renderStatsIfLoaded();
    },
    (e) => console.error("멤버 구독 오류:", e)
  ));

  // 마일리지 보드 (기록 보기)
  unsubs.push(onSnapshot(
    collection(db, "mileage"),
    (qs) => {
      state.mileage = {};
      qs.docs.forEach((d) => (state.mileage[d.id] = d.data()));
      renderMileage();
    },
    (e) => console.error("마일리지 구독 오류:", e)
  ));
}

/* 다가오는 일정의 출석 현황만 실시간 구독 (최대 10개) */
function syncAttendanceListeners() {
  const today = todayStr();
  const upcoming = state.events.filter((ev) => ev.date >= today).slice(0, 10);
  const wanted = new Set(upcoming.map((ev) => ev.id));

  Object.keys(attendanceUnsubs).forEach((id) => {
    if (!wanted.has(id)) {
      attendanceUnsubs[id]();
      delete attendanceUnsubs[id];
      delete state.attendance[id];
    }
  });

  upcoming.forEach((ev) => {
    if (attendanceUnsubs[ev.id]) return;
    attendanceUnsubs[ev.id] = onSnapshot(
      collection(db, "events", ev.id, "attendance"),
      (qs) => {
        const map = {};
        qs.docs.forEach((d) => (map[d.id] = d.data()));
        state.attendance[ev.id] = map;
        renderEvents();
        renderStatsIfLoaded();
      },
      (e) => console.error("출석 구독 오류:", e)
    );
  });
}

/* 투표 결과 실시간 구독 (최근 15개) */
function syncVoteListeners() {
  const shown = state.polls.slice(0, 15);
  const wanted = new Set(shown.map((p) => p.id));

  Object.keys(voteUnsubs).forEach((id) => {
    if (!wanted.has(id)) {
      voteUnsubs[id]();
      delete voteUnsubs[id];
      delete state.votes[id];
    }
  });

  shown.forEach((p) => {
    if (voteUnsubs[p.id]) return;
    voteUnsubs[p.id] = onSnapshot(
      collection(db, "polls", p.id, "votes"),
      (qs) => {
        const map = {};
        qs.docs.forEach((d) => (map[d.id] = d.data()));
        state.votes[p.id] = map;
        renderPolls();
      },
      (e) => console.error("투표결과 구독 오류:", e)
    );
  });
}

function renderAll() {
  renderHome();
  renderNotices();
  renderEventCatRow();
  renderEvents();
  renderPolls();
  renderMembers();
  renderMileage();
}

/* ============================================================
   3. 탭 전환 (하단 고정 탭: 홈 / 일정·출첵 / 소식 / 멤버)
   ============================================================ */
const SWIPE_TABS = ["home", "events", "news", "members"]; // 관리는 별도 페이지라 제외

function activeTabName() {
  return document.querySelector(".app-tab.active")?.dataset.tab || null;
}

function switchTab(name) {
  const from = SWIPE_TABS.indexOf(activeTabName());
  document.querySelectorAll(".app-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `tab-${name}`));

  // 방향 있는 슬라이드 인 (하단 탭 클릭·좌우 스와이프 공통)
  const to = SWIPE_TABS.indexOf(name);
  const panel = document.getElementById(`tab-${name}`);
  if (panel && from >= 0 && to >= 0 && from !== to) {
    const dir = to > from ? "tabSlideNext" : "tabSlidePrev";
    panel.style.animation = "none";
    void panel.offsetWidth;                 // 리플로우 → 애니메이션 재실행 보장
    panel.style.animation = `${dir} 0.24s ease`;
  }
  window.scrollTo(0, 0);
}

$("appTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".app-tab");
  if (btn && btn.dataset.tab) switchTab(btn.dataset.tab); // 관리(admin.html 링크)는 그대로 이동
});

/* ---------- 좌/우 스와이프로 탭 이동 (크루 공간 본화면일 때만) ---------- */
onSwipe((dir) => {
  const cur = SWIPE_TABS.indexOf(activeTabName());
  if (cur < 0) return;
  const next = cur + (dir === "left" ? 1 : -1); // 왼쪽으로 밀면 다음 탭, 오른쪽이면 이전 탭
  if (next >= SWIPE_TABS.length) {
    // 마지막(멤버)에서 더 왼쪽으로 밀면 — 운영진만 '관리' 페이지로 이동
    if (isAdmin) location.href = "admin.html";
    return;
  }
  if (next < 0) return; // 첫 탭(홈)에서 오른쪽으로 더 밀어도 밖으로 나가지 않음
  switchTab(SWIPE_TABS[next]);
}, { enabled: () => !$("viewApp").hidden });

/* 홈 화면의 바로가기 (D-day 카드, 공지 배너, 일정 행, 투표 등)
   data-goto="탭" 또는 "탭:하위" — 예) "events", "news:poll", "news:notice" */
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (!go) return;
  const [tab, sub] = go.dataset.goto.split(":");
  switchTab(tab);
  // 일정·출첵 바로가기는 항상 '일정' 서브탭부터 보여줌
  if (tab === "events") {
    $("eventSubTabs").querySelector('[data-subtab="ev-list"]').click();
  }
  // 소식 바로가기: 공지/투표 필터 지정 (지정 없으면 전체)
  if (tab === "news") {
    $("newsFilter").querySelector(`[data-news="${sub || "all"}"]`)?.click();
  }
});

/* 일정·출첵 서브탭: 일정 / 출석 현황 / 이달의 기록 */
$("eventSubTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".sub-tab");
  if (!btn) return;
  document.querySelectorAll("#eventSubTabs .sub-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  document.querySelectorAll("#tab-events > .sub-panel").forEach((p) =>
    p.classList.toggle("active", p.id === btn.dataset.subtab));
  // 출석 현황·이달의 기록 모두 그 달의 출석 데이터가 필요
  if (btn.dataset.subtab === "ev-att" || btn.dataset.subtab === "ev-rec") ensureMonthData();
});
