/* ============================================================
   크루 공간 (app.html) — Firebase Auth + Firestore
   ------------------------------------------------------------
   기능: 로그인/회원가입 → 운영진 승인 → 공지 / 일정·출석체크 /
        투표 / 멤버 관리(운영진)
   ============================================================ */

/* ---------- 화면 요소 (SDK 로딩 전에 준비) ---------- */
const $ = (id) => document.getElementById(id);
const views = {
  loading: $("viewLoading"),
  config: $("viewConfig"),
  login: $("viewLogin"),
  pending: $("viewPending"),
  rejected: $("viewRejected"),
  app: $("viewApp"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => (el.hidden = k !== name));
}

/* ---------- Firebase 설정 확인 ---------- */
if (!window.FIREBASE_READY) {
  showView("config");
  throw new Error("Firebase 설정이 필요합니다 (js/firebase-config.js)");
}

/* ---------- Firebase SDK (CDN) ---------- */
const SDK = window.FIREBASE_SDK;

const { initializeApp } = await import(`${SDK}/firebase-app.js`);
const {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} = await import(`${SDK}/firebase-auth.js`);
const {
  getFirestore, collection, doc,
  getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} = await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- 전역 상태 ---------- */
let me = null;          // 로그인한 auth 유저
let myProfile = null;   // members/{uid} 문서 데이터
let isAdmin = false;

let state = {
  notices: [],
  events: [],
  polls: [],
  members: [],
  applications: [],
  attendance: {},   // eventId → { uid: {name, status} }
  votes: {},        // pollId → { uid: {name, option} }
};

// onSnapshot 해제 함수 모음
let unsubs = [];                 // 컬렉션 리스너
let attendanceUnsubs = {};       // eventId → unsub
let voteUnsubs = {};             // pollId → unsub
let profileUnsub = null;

/* ---------- 유틸 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function parseDateParts(dateStr) {
  // "2026-07-08" → {month: "7월", day: "8", dow: "수"}
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = DOW[new Date(y, m - 1, d).getDay()];
  return { month: `${m}월`, day: String(d), dow: `${dow}요일` };
}

function authErrorMsg(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/invalid-email": "이메일 형식이 올바르지 않아요.",
    "auth/user-not-found": "등록되지 않은 이메일이에요. 회원가입을 먼저 해주세요.",
    "auth/wrong-password": "비밀번호가 틀렸어요.",
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않아요.",
    "auth/email-already-in-use": "이미 가입된 이메일이에요. 로그인해 주세요.",
    "auth/weak-password": "비밀번호는 6자 이상으로 해주세요.",
    "auth/too-many-requests": "시도가 너무 많았어요. 잠시 후 다시 시도해 주세요.",
    "auth/popup-closed-by-user": "로그인 창이 닫혔어요. 다시 시도해 주세요.",
    "auth/network-request-failed": "네트워크 오류예요. 인터넷 연결을 확인해 주세요.",
  };
  return map[code] || `오류가 발생했어요. (${code || err})`;
}

/* ============================================================
   1. 인증 (로그인 / 회원가입 / 로그아웃)
   ============================================================ */
let authMode = "login"; // 'login' | 'signup'
let signupName = "";

document.querySelectorAll(".auth-mode").forEach((btn) => {
  btn.addEventListener("click", () => {
    authMode = btn.dataset.mode;
    document.querySelectorAll(".auth-mode").forEach((b) =>
      b.classList.toggle("active", b === btn));
    $("rowName").hidden = authMode !== "signup";
    $("btnEmailSubmit").textContent = authMode === "signup" ? "회원가입" : "로그인";
    hideAuthError();
  });
});

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  const email = $("authEmail").value.trim();
  const pw = $("authPw").value;

  try {
    if (authMode === "signup") {
      signupName = $("authName").value.trim();
      if (!signupName) {
        showAuthError({ code: "", message: "" }, "크루에서 쓸 이름을 입력해 주세요.");
        return;
      }
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      await updateProfile(cred.user, { displayName: signupName });
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
  } catch (err) {
    showAuthError(err);
  }
});

/* ---------- 모달 공통 (열기/닫기) ---------- */
function openModal(id) {
  $(id).hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal(id) {
  $(id).hidden = true;
  document.body.style.overflow = "";
}

document.querySelectorAll(".modal").forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-close]")) closeModal(modal.id);
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".modal").forEach((m) => {
    if (!m.hidden) closeModal(m.id);
  });
});

function showFormMsg(id, text, type) {
  const el = $(id);
  el.hidden = false;
  el.textContent = text;
  el.className = `form-msg ${type}`;
}

/* ---------- 비밀번호 재설정 (메일 링크로 새 비밀번호 설정) ---------- */
$("btnReset").addEventListener("click", () => {
  $("resetEmail").value = $("authEmail").value.trim();
  $("resetMsg").hidden = true;
  openModal("resetModal");
});

$("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("resetEmail").value.trim();
  try {
    await sendPasswordResetEmail(auth, email);
    showFormMsg("resetMsg", `${email} 로 재설정 메일을 보냈어요! 메일의 링크에서 새 비밀번호를 설정한 뒤, 그 비밀번호로 로그인해 주세요. (메일이 안 보이면 스팸함 확인)`, "ok");
  } catch (err) {
    showFormMsg("resetMsg", authErrorMsg(err), "error");
  }
});

/* ---------- 내 정보 수정 (이름 · 비밀번호) ---------- */
$("userName").addEventListener("click", () => {
  if (!me || !myProfile) return;
  $("profileName").value = myProfile.name || "";
  $("nameMsg").hidden = true;
  $("pwMsg").hidden = true;
  $("pwForm").reset();
  openModal("profileModal");
});

$("nameForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("profileName").value.trim();
  if (!name) return;
  try {
    await updateDoc(doc(db, "members", me.uid), { name });
    await updateProfile(me, { displayName: name });
    showFormMsg("nameMsg", "이름을 변경했어요 ✅", "ok");
  } catch (err) {
    showFormMsg("nameMsg", "이름 변경에 실패했어요: " + err.message, "error");
  }
});

$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    // 본인 확인(현재 비밀번호) 후 새 비밀번호 적용
    const cred = EmailAuthProvider.credential(me.email, $("pwCurrent").value);
    await reauthenticateWithCredential(me, cred);
    await updatePassword(me, $("pwNew").value);
    e.target.reset();
    showFormMsg("pwMsg", "비밀번호를 변경했어요 ✅ 다음 로그인부터 새 비밀번호를 사용하세요.", "ok");
  } catch (err) {
    const map = {
      "auth/invalid-credential": "현재 비밀번호가 올바르지 않아요.",
      "auth/wrong-password": "현재 비밀번호가 올바르지 않아요.",
      "auth/weak-password": "새 비밀번호는 6자 이상으로 해주세요.",
    };
    showFormMsg("pwMsg", map[err.code] || authErrorMsg(err), "error");
  }
});

function showAuthError(err, custom) {
  const el = $("authError");
  el.hidden = false;
  el.textContent = custom || authErrorMsg(err);
}

function hideAuthError() {
  $("authError").hidden = true;
}

$("btnLogout").addEventListener("click", () => signOut(auth));
$("btnLogoutPending").addEventListener("click", () => signOut(auth));
$("btnLogoutRejected").addEventListener("click", () => signOut(auth));

/* ============================================================
   2. 로그인 상태 → 화면 라우팅
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
  cleanupAll();
  closeModal("resetModal");
  closeModal("profileModal");
  me = user;

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
      });
    }
  } catch (err) {
    console.error("멤버 문서 확인 실패:", err);
  }

  // 내 문서를 실시간 구독 → 운영진이 승인하면 자동으로 화면 전환
  profileUnsub = onSnapshot(myRef, (snap) => {
    if (!snap.exists()) {
      // 내보내기된 경우 → 다시 대기 상태로
      myProfile = null;
      isAdmin = false;
      showView("pending");
      $("pendingName").textContent = user.displayName || user.email;
      return;
    }
    myProfile = snap.data();
    isAdmin = myProfile.role === "admin";

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
    // 이미 접속 중에 운영진으로 승격된 경우 → 가입신청 구독 추가
    if (isAdmin && !appsSubscribed) startApplicationsListener();
    renderAll();
    return;
  }
  appEntered = true;
  startListeners();
}

function cleanupAll() {
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.values(attendanceUnsubs).forEach((u) => u());
  attendanceUnsubs = {};
  Object.values(voteUnsubs).forEach((u) => u());
  voteUnsubs = {};
  if (profileUnsub) { profileUnsub(); profileUnsub = null; }
  appEntered = false;
  appsSubscribed = false;
  state = { notices: [], events: [], polls: [], members: [], applications: [], attendance: {}, votes: {} };
}

/* ============================================================
   3. 실시간 데이터 구독
   ============================================================ */
function startListeners() {
  unsubs.push(onSnapshot(
    query(collection(db, "notices"), orderBy("createdAt", "desc")),
    (qs) => {
      state.notices = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotices();
    },
    (e) => console.error("공지 구독 오류:", e)
  ));

  unsubs.push(onSnapshot(
    query(collection(db, "events"), orderBy("date", "asc")),
    (qs) => {
      state.events = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      syncAttendanceListeners();
      renderEvents();
    },
    (e) => console.error("일정 구독 오류:", e)
  ));

  unsubs.push(onSnapshot(
    query(collection(db, "polls"), orderBy("createdAt", "desc")),
    (qs) => {
      state.polls = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      syncVoteListeners();
      renderPolls();
    },
    (e) => console.error("투표 구독 오류:", e)
  ));

  unsubs.push(onSnapshot(
    collection(db, "members"),
    (qs) => {
      state.members = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMembers();
    },
    (e) => console.error("멤버 구독 오류:", e)
  ));

  if (isAdmin) startApplicationsListener();
}

let appsSubscribed = false;

function startApplicationsListener() {
  appsSubscribed = true;
  unsubs.push(onSnapshot(
    query(collection(db, "applications"), orderBy("createdAt", "desc")),
    (qs) => {
      state.applications = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMembers();
    },
    (e) => console.error("가입신청 구독 오류:", e)
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
  renderNotices();
  renderEvents();
  renderPolls();
  renderMembers();
}

/* ============================================================
   4. 탭 전환
   ============================================================ */
$("appTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".app-tab");
  if (!btn) return;
  document.querySelectorAll(".app-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
});

/* ============================================================
   5. 공지
   ============================================================ */
$("noticeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "notices"), {
      title: $("noticeTitle").value.trim(),
      body: $("noticeBody").value.trim(),
      pinned: $("noticePinned").checked,
      author: myProfile.name,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $("noticeAdmin").open = false;
  } catch (err) {
    alert("공지 등록에 실패했어요: " + err.message);
  }
});

function renderNotices() {
  const list = $("noticeList");
  const sorted = [...state.notices].sort((a, b) => (b.pinned === true) - (a.pinned === true));

  if (!sorted.length) {
    list.innerHTML = `<p class="empty-note">아직 공지가 없습니다.</p>`;
    return;
  }

  list.innerHTML = sorted.map((n) => `
    <article class="app-card">
      <div class="app-card-head">
        <div>
          <h4>${n.pinned ? '<span class="pin-badge">📌 고정</span>' : ""}${esc(n.title)}</h4>
          <p class="app-card-meta">${esc(n.author || "")} · ${fmtDate(n.createdAt)}${n.updatedAt ? " (수정됨)" : ""}</p>
        </div>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="edit-notice" data-id="${n.id}">수정</button>
          <button class="btn-mini dark" data-action="pin-notice" data-id="${n.id}" data-pinned="${!!n.pinned}">${n.pinned ? "고정 해제" : "고정"}</button>
          <button class="btn-mini danger" data-action="del-notice" data-id="${n.id}">삭제</button>
        </div>` : ""}
      </div>
      <div class="app-card-body">${esc(n.body)}</div>
    </article>
  `).join("");
}

$("noticeList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  try {
    if (action === "del-notice" && confirm("이 공지를 삭제할까요?")) {
      await deleteDoc(doc(db, "notices", id));
    } else if (action === "pin-notice") {
      await updateDoc(doc(db, "notices", id), { pinned: btn.dataset.pinned !== "true" });
    } else if (action === "edit-notice") {
      const n = state.notices.find((x) => x.id === id);
      if (!n) return;
      editNoticeId = id;
      $("editNoticeTitle").value = n.title || "";
      $("editNoticeBody").value = n.body || "";
      $("editNoticeMsg").hidden = true;
      openModal("editNoticeModal");
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});

let editNoticeId = null;

$("editNoticeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editNoticeId) return;
  try {
    await updateDoc(doc(db, "notices", editNoticeId), {
      title: $("editNoticeTitle").value.trim(),
      body: $("editNoticeBody").value.trim(),
      updatedAt: serverTimestamp(),
    });
    closeModal("editNoticeModal");
  } catch (err) {
    showFormMsg("editNoticeMsg", "수정에 실패했어요: " + err.message, "error");
  }
});

/* ============================================================
   6. 일정 · 출석체크
   ============================================================ */
$("eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "events"), {
      title: $("eventTitle").value.trim(),
      date: $("eventDate").value,          // "YYYY-MM-DD"
      time: $("eventTime").value,          // "HH:MM"
      place: $("eventPlace").value.trim(),
      note: $("eventNote").value.trim(),
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $("eventTime").value = "19:20";
    $("eventAdmin").open = false;
  } catch (err) {
    alert("일정 등록에 실패했어요: " + err.message);
  }
});

function eventCardHtml(ev, isPast) {
  const dp = parseDateParts(ev.date);
  const att = state.attendance[ev.id] || null;
  let attendHtml = "";

  if (!isPast) {
    const entries = att ? Object.entries(att) : [];
    const yes = entries.filter(([, v]) => v.status === "yes");
    const no = entries.filter(([, v]) => v.status === "no");
    const mine = att && me && att[me.uid] ? att[me.uid].status : null;

    attendHtml = `
      <div class="rsvp-row">
        <button class="rsvp-btn ${mine === "yes" ? "on-yes" : ""}" data-action="rsvp" data-id="${ev.id}" data-status="yes">🙋 참석 ${yes.length}</button>
        <button class="rsvp-btn ${mine === "no" ? "on-no" : ""}" data-action="rsvp" data-id="${ev.id}" data-status="no">🙅 불참 ${no.length}</button>
      </div>
      ${yes.length ? `<p class="attend-names"><span class="leaf">참석</span> ${yes.map(([, v]) => esc(v.name)).join(", ")}</p>` : ""}
    `;
  } else {
    attendHtml = `<div class="rsvp-row"><button class="btn-mini dark" data-action="load-past-att" data-id="${ev.id}">참석 명단 보기</button><span class="attend-names" id="pastAtt-${ev.id}"></span></div>`;
  }

  return `
    <article class="app-card event-card ${isPast ? "past" : ""}">
      <div class="event-date-box">
        <div class="d-month">${dp.month}</div>
        <div class="d-day">${dp.day}</div>
        <div class="d-dow">${dp.dow}</div>
      </div>
      <div class="event-main">
        <div class="app-card-head">
          <h4>${esc(ev.title)}</h4>
          ${isAdmin ? `
          <div class="card-actions">
            <button class="btn-mini dark" data-action="edit-event" data-id="${ev.id}">수정</button>
            <button class="btn-mini danger" data-action="del-event" data-id="${ev.id}">삭제</button>
          </div>` : ""}
        </div>
        <p class="event-info">🕖 ${esc(ev.time)} · 📍 ${esc(ev.place)}${ev.note ? ` · ${esc(ev.note)}` : ""}${ev.updatedAt ? ` <span class="muted">(수정됨)</span>` : ""}</p>
        ${attendHtml}
      </div>
    </article>
  `;
}

function renderEvents() {
  const today = todayStr();
  const upcoming = state.events.filter((ev) => ev.date >= today);
  const past = state.events.filter((ev) => ev.date < today).reverse(); // 최근 것부터

  $("eventUpcoming").innerHTML = upcoming.length
    ? upcoming.map((ev) => eventCardHtml(ev, false)).join("")
    : `<p class="empty-note">예정된 일정이 없습니다.${isAdmin ? " 위의 '일정 만들기'로 등록해 보세요!" : ""}</p>`;

  $("eventPast").innerHTML = past.length
    ? past.slice(0, 20).map((ev) => eventCardHtml(ev, true)).join("")
    : `<p class="empty-note">지난 일정이 없습니다.</p>`;
}

async function handleEventClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  try {
    if (action === "rsvp") {
      const current = state.attendance[id] && me ? state.attendance[id][me.uid] : null;
      const status = btn.dataset.status;
      const ref = doc(db, "events", id, "attendance", me.uid);
      if (current && current.status === status) {
        await deleteDoc(ref); // 같은 버튼 다시 누르면 취소
      } else {
        await setDoc(ref, { name: myProfile.name, status, at: serverTimestamp() });
      }
    } else if (action === "del-event" && confirm("이 일정을 삭제할까요? (출석 기록도 함께 사라져요)")) {
      await deleteDoc(doc(db, "events", id));
    } else if (action === "edit-event") {
      const ev = state.events.find((x) => x.id === id);
      if (!ev) return;
      editEventId = id;
      $("editEventTitle").value = ev.title || "";
      $("editEventDate").value = ev.date || "";
      $("editEventTime").value = ev.time || "";
      $("editEventPlace").value = ev.place || "";
      $("editEventNote").value = ev.note || "";
      $("editEventMsg").hidden = true;
      openModal("editEventModal");
    } else if (action === "load-past-att") {
      const qs = await getDocs(collection(db, "events", id, "attendance"));
      const yes = qs.docs.map((d) => d.data()).filter((v) => v.status === "yes");
      const target = $(`pastAtt-${id}`);
      if (target) {
        target.innerHTML = yes.length
          ? `<span class="leaf">참석 ${yes.length}명</span> · ${yes.map((v) => esc(v.name)).join(", ")}`
          : "출석 기록이 없어요.";
      }
      btn.remove();
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
}

$("eventUpcoming").addEventListener("click", handleEventClick);
$("eventPast").addEventListener("click", handleEventClick);

let editEventId = null;

$("editEventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editEventId) return;
  try {
    await updateDoc(doc(db, "events", editEventId), {
      title: $("editEventTitle").value.trim(),
      date: $("editEventDate").value,
      time: $("editEventTime").value,
      place: $("editEventPlace").value.trim(),
      note: $("editEventNote").value.trim(),
      updatedAt: serverTimestamp(),
    });
    closeModal("editEventModal");
  } catch (err) {
    showFormMsg("editEventMsg", "수정에 실패했어요: " + err.message, "error");
  }
});

/* ============================================================
   7. 투표
   ============================================================ */
$("pollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const options = $("pollOptions").value
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) {
    alert("선택지를 2개 이상 입력해 주세요.");
    return;
  }
  try {
    await addDoc(collection(db, "polls"), {
      question: $("pollQuestion").value.trim(),
      options,
      closed: false,
      author: myProfile.name,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $("pollAdmin").open = false;
  } catch (err) {
    alert("투표 등록에 실패했어요: " + err.message);
  }
});

function renderPolls() {
  const list = $("pollList");
  if (!state.polls.length) {
    list.innerHTML = `<p class="empty-note">진행 중인 투표가 없습니다.</p>`;
    return;
  }

  list.innerHTML = state.polls.map((p) => {
    const votes = state.votes[p.id] || {};
    const entries = Object.entries(votes);
    const total = entries.length;
    const myVote = me && votes[me.uid] ? votes[me.uid].option : null;
    const counts = p.options.map((_, i) => entries.filter(([, v]) => v.option === i).length);

    return `
    <article class="app-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(p.question)}</h4>
          <p class="app-card-meta">${esc(p.author || "")} · ${fmtDate(p.createdAt)}${p.updatedAt ? " (수정됨)" : ""} ·
            <span class="poll-status ${p.closed ? "closed" : "open"}">${p.closed ? "마감" : "진행 중"}</span>
          </p>
        </div>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="edit-poll" data-id="${p.id}">수정</button>
          <button class="btn-mini dark" data-action="toggle-poll" data-id="${p.id}" data-closed="${!!p.closed}">${p.closed ? "재개" : "마감"}</button>
          <button class="btn-mini danger" data-action="del-poll" data-id="${p.id}">삭제</button>
        </div>` : ""}
      </div>
      <div class="poll-options">
        ${p.options.map((opt, i) => {
          const pct = total ? Math.round((counts[i] / total) * 100) : 0;
          return `
          <button class="poll-option ${myVote === i ? "mine" : ""}"
                  data-action="vote" data-id="${p.id}" data-option="${i}"
                  ${p.closed ? "disabled" : ""}>
            <span class="bar" style="width:${pct}%"></span>
            <span class="opt-label"><span>${esc(opt)}</span><span class="opt-count">${counts[i]}표 (${pct}%)</span></span>
          </button>`;
        }).join("")}
      </div>
      <p class="poll-total">총 ${total}명 참여${p.closed ? "" : " · 선택지를 누르면 투표됩니다 (다시 누르면 변경)"}</p>
    </article>`;
  }).join("");
}

$("pollList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  try {
    if (action === "vote") {
      await setDoc(doc(db, "polls", id, "votes", me.uid), {
        name: myProfile.name,
        option: Number(btn.dataset.option),
        at: serverTimestamp(),
      });
    } else if (action === "toggle-poll") {
      await updateDoc(doc(db, "polls", id), { closed: btn.dataset.closed !== "true" });
    } else if (action === "del-poll" && confirm("이 투표를 삭제할까요?")) {
      await deleteDoc(doc(db, "polls", id));
    } else if (action === "edit-poll") {
      const p = state.polls.find((x) => x.id === id);
      if (!p) return;
      editPollId = id;
      $("editPollQuestion").value = p.question || "";
      $("editPollOptions").value = (p.options || []).join("\n");
      $("editPollMsg").hidden = true;
      openModal("editPollModal");
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});

let editPollId = null;

$("editPollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editPollId) return;
  const options = $("editPollOptions").value
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) {
    showFormMsg("editPollMsg", "선택지를 2개 이상 입력해 주세요.", "error");
    return;
  }
  try {
    await updateDoc(doc(db, "polls", editPollId), {
      question: $("editPollQuestion").value.trim(),
      options,
      updatedAt: serverTimestamp(),
    });
    closeModal("editPollModal");
  } catch (err) {
    showFormMsg("editPollMsg", "수정에 실패했어요: " + err.message, "error");
  }
});

/* ============================================================
   8. 멤버 (목록 + 운영진 관리)
   ============================================================ */
function renderMembers() {
  const approved = state.members
    .filter((m) => m.role === "member" || m.role === "admin")
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  const pending = state.members.filter((m) => m.role === "pending");
  const rejected = state.members
    .filter((m) => m.role === "rejected")
    .sort((a, b) => (b.rejectedAt?.seconds || 0) - (a.rejectedAt?.seconds || 0));

  $("memberCount").textContent = `${approved.length}명`;

  $("memberList").innerHTML = approved.length ? approved.map((m) => `
    <div class="member-card">
      <div class="member-avatar">${esc((m.name || "?").charAt(0))}</div>
      <div class="member-info">
        <div class="member-name">${esc(m.name)}</div>
        <div class="member-since">${fmtDate(m.createdAt)} 합류</div>
        ${isAdmin && m.id !== me.uid ? `
        <div class="member-admin-actions">
          <button class="btn-mini dark" data-action="toggle-admin" data-id="${m.id}" data-role="${m.role}">${m.role === "admin" ? "운영진 해제" : "운영진 지정"}</button>
          <button class="btn-mini danger" data-action="remove-member" data-id="${m.id}" data-name="${esc(m.name)}">내보내기</button>
        </div>` : ""}
      </div>
      <span class="role-badge ${m.role === "admin" ? "admin" : ""}">${m.role === "admin" ? "👑 운영진" : "멤버"}</span>
    </div>
  `).join("") : `<p class="empty-note">아직 승인된 멤버가 없습니다.</p>`;

  if (!isAdmin) return;

  $("pendingCount").textContent = pending.length;
  $("rejectedCount").textContent = rejected.length;

  $("pendingList").innerHTML = pending.length ? pending.map((m) => `
    <article class="app-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(m.name)}</h4>
          <p class="app-card-meta">${esc(m.email || "")} · ${fmtDate(m.createdAt)} 신청</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini leaf" data-action="approve" data-id="${m.id}">✓ 승인</button>
          <button class="btn-mini danger" data-action="reject" data-id="${m.id}" data-name="${esc(m.name)}">거절</button>
        </div>
      </div>
    </article>
  `).join("") : `<p class="empty-note">대기 중인 멤버가 없습니다.</p>`;

  $("rejectedList").innerHTML = rejected.length ? rejected.map((m) => `
    <article class="app-card rejected-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(m.name)} <span class="rejected-badge">거절됨</span></h4>
          <p class="app-card-meta">${esc(m.email || "")} · ${fmtDate(m.createdAt)} 신청 · ${fmtDate(m.rejectedAt)} 거절</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini leaf" data-action="approve" data-id="${m.id}">✓ 승인으로 변경</button>
          <button class="btn-mini danger" data-action="del-rejected" data-id="${m.id}" data-name="${esc(m.name)}">기록 삭제</button>
        </div>
      </div>
    </article>
  `).join("") : `<p class="empty-note">거절 기록이 없습니다.</p>`;

  $("applicationList").innerHTML = state.applications.length ? state.applications.map((a) => `
    <article class="app-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(a.name)} <span class="muted">${esc(a.age || "")} ${esc(a.level || "")}</span></h4>
          <p class="app-card-meta">📱 ${esc(a.contact)} · ${fmtDate(a.createdAt)}</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini danger" data-action="del-application" data-id="${a.id}">처리 완료 (삭제)</button>
        </div>
      </div>
      ${a.message ? `<div class="app-card-body">${esc(a.message)}</div>` : ""}
    </article>
  `).join("") : `<p class="empty-note">새 신청서가 없습니다.</p>`;
}

/* 승인 대기 / 거절 서브탭 전환 */
$("memberSubTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".sub-tab");
  if (!btn) return;
  document.querySelectorAll("#memberSubTabs .sub-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  document.querySelectorAll("#adminSection .sub-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `subtab-${btn.dataset.subtab}`));
});

$("tab-members").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  try {
    if (action === "approve") {
      await updateDoc(doc(db, "members", id), { role: "member" });
    } else if (action === "reject" && confirm(`${btn.dataset.name}님의 가입을 거절할까요?\n(거절 기록은 '거절' 탭에 남고, 나중에 승인으로 바꿀 수 있어요)`)) {
      await updateDoc(doc(db, "members", id), { role: "rejected", rejectedAt: serverTimestamp() });
    } else if (action === "del-rejected" && confirm(`${btn.dataset.name}님의 거절 기록을 완전히 삭제할까요?\n(삭제하면 이 사람이 다시 로그인할 때 '승인 대기'로 새로 등록돼요)`)) {
      await deleteDoc(doc(db, "members", id));
    } else if (action === "toggle-admin") {
      const newRole = btn.dataset.role === "admin" ? "member" : "admin";
      if (confirm(newRole === "admin" ? "운영진으로 지정할까요?" : "운영진에서 해제할까요?")) {
        await updateDoc(doc(db, "members", id), { role: newRole });
      }
    } else if (action === "remove-member" && confirm(`${btn.dataset.name}님을 크루에서 내보낼까요?`)) {
      await deleteDoc(doc(db, "members", id));
    } else if (action === "del-application" && confirm("이 신청서를 삭제할까요?")) {
      await deleteDoc(doc(db, "applications", id));
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});
