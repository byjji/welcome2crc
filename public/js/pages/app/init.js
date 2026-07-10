/* ============================================================
   pages/app/init.js — 크루 공간 본체
   ------------------------------------------------------------
   로그인 상태 라우팅 · 실시간 구독 시작/정리 · 하단 탭 전환.
   각 화면의 렌더링/폼 처리는 화면 모듈이 담당합니다.
   ============================================================ */
import { $, closeModal, initModals } from "../../lib/ui.js";
import { todayStr } from "../../lib/format.js";
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
      // 내보내기된 경우 → 다시 대기 상태로
      setMyProfile(null);
      setIsAdmin(false);
      showView("pending");
      $("pendingName").textContent = user.displayName || user.email;
      return;
    }
    setMyProfile(snap.data());
    setIsAdmin(myProfile.role === "admin");

    $("appUser").hidden = false;
    $("userName").textContent = `${myProfile.name}${isAdmin ? " 👑" : ""}`;
    $("adminPageLink").hidden = !isAdmin;

    if (myProfile.role === "pending") {
      $("pendingName").textContent = myProfile.name;
      showView("pending");
    } else if (myProfile.role === "rejected") {
      $("rejectedName").textContent = myProfile.name;
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
      const list = snap.exists() ? snap.data().list : null;
      state.eventCats = Array.isArray(list) && list.length ? list : [...DEFAULT_EVENT_CATS];
      renderEventCatRow();
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
function switchTab(name) {
  document.querySelectorAll(".app-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `tab-${name}`));
  window.scrollTo(0, 0);
}

$("appTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".app-tab");
  if (btn && btn.dataset.tab) switchTab(btn.dataset.tab); // ⚙️(admin.html 링크)는 그대로 이동
});

/* 홈 화면의 바로가기 (D-day 카드, 공지 배너, '전체 보기' 등) */
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) switchTab(go.dataset.goto);
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
