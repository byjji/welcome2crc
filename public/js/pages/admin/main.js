/* ============================================================
   페이지 관리 (admin.html) — 운영진 전용
   ------------------------------------------------------------
   소개 페이지(index.html)의 문구 / 크루 공식 기록을 Firestore 에
   저장합니다. 저장된 내용은 소개 페이지가 열릴 때 자동으로
   불러와 표시됩니다.
   ============================================================ */

import { $ } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
import { onSwipe } from "../../lib/swipe.js";
import { esc, escMultiline } from "../../lib/format.js";
import { toAuthEmail, displayAccount } from "../../lib/account.js";

/* ---------- 화면 요소 ---------- */
const views = {
  loading: $("viewLoading"),
  config: $("viewConfig"),
  login: $("viewLogin"),
  denied: $("viewDenied"),
  admin: $("viewAdmin"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => (el.hidden = k !== name));
}

/* ---------- 관리 상단 탭 (소개 관리 · 앞으로 늘어날 탭들) ---------- */
$("adminTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".admin-tab");
  if (!btn) return;
  document.querySelectorAll("#adminTabs .admin-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  document.querySelectorAll("#viewAdmin .admin-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `apanel-${btn.dataset.atab}`));
  window.scrollTo(0, 0);
});

/* 관리 화면에서 오른쪽으로 스와이프 → 크루 공간 '멤버' 탭으로 복귀
   (크루 공간의 스와이프 순서상 관리 바로 왼쪽이 멤버) */
onSwipe((dir) => {
  if (dir === "right") location.href = "app.html#tab=members";
}, { enabled: () => !$("viewAdmin").hidden });

/* ---------- Firebase 설정 확인 ---------- */
if (!window.FIREBASE_READY) {
  showView("config");
  throw new Error("Firebase 설정이 필요합니다 (js/firebase-config.js)");
}

/* ---------- Firebase (공통 초기화 모듈) ---------- */
const {
  auth, db,
  onAuthStateChanged, signOut, signInWithEmailAndPassword,
  collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp,
} = await import("../../lib/firebase.js");

function authErrorMsg(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/invalid-email": "계정 형식이 올바르지 않아요.",
    "auth/user-not-found": "등록되지 않은 계정이에요.",
    "auth/wrong-password": "비밀번호가 틀렸어요.",
    "auth/invalid-credential": "계정 또는 비밀번호가 올바르지 않아요.",
    "auth/too-many-requests": "시도가 너무 많았어요. 잠시 후 다시 시도해 주세요.",
    "auth/popup-closed-by-user": "로그인 창이 닫혔어요. 다시 시도해 주세요.",
    "auth/network-request-failed": "네트워크 오류예요. 인터넷 연결을 확인해 주세요.",
  };
  return map[code] || `오류가 발생했어요. (${code || err})`;
}

/* 저장 완료 표시 (버튼 옆 메시지) */
function flashSaved(form, text = "저장했어요") {
  const el = form.querySelector(".save-msg");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 3000);
}

/* 종목(거리) 표시 순서 — 짧은 거리부터 (소개 페이지의 종목 탭과 동일) */
const EVENT_OPTIONS = ["3km", "5km", "10km", "하프", "풀코스"];
const eventOrder = (ev) => {
  const i = EVENT_OPTIONS.indexOf(ev);
  return i === -1 ? 99 : i; // 목록에 없는 종목은 맨 뒤로
};

/* ============================================================
   1. 인증 + 운영진 확인
   ------------------------------------------------------------
   계정(아이디) 변환 규칙은 lib/account.js 공용 (크루 공간과 동일)
   ============================================================ */
$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  try {
    await signInWithEmailAndPassword(auth, toAuthEmail($("authEmail").value), $("authPw").value);
  } catch (err) {
    showAuthError(err);
  }
});

function showAuthError(err) {
  const el = $("authError");
  el.hidden = false;
  el.textContent = authErrorMsg(err);
}
function hideAuthError() {
  $("authError").hidden = true;
}

$("btnLogout").addEventListener("click", () => signOut(auth));
$("btnLogoutDenied").addEventListener("click", () => signOut(auth));

let me = null;
let unsubs = [];
let adminStarted = false;

onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];
  adminStarted = false;
  me = user;

  if (!user) {
    $("appUser").hidden = true;
    showView("login");
    return;
  }

  showView("loading");

  let role = "";
  try {
    const snap = await getDoc(doc(db, "members", user.uid));
    role = snap.exists() ? snap.data().role : "";
  } catch (err) {
    console.error("권한 확인 실패:", err);
  }

  if (role !== "admin") {
    $("deniedName").textContent = user.displayName || displayAccount(user.email) || "";
    showView("denied");
    return;
  }

  $("appUser").hidden = false;
  $("userName").innerHTML = `${esc(user.displayName || displayAccount(user.email))} ${ic("crown", "ic-crown")}`;
  showView("admin");
  startAdmin();
});

function startAdmin() {
  if (adminStarted) return;
  adminStarted = true;
  loadSiteContent();
  startRecordsListener();
}

/* ============================================================
   2. 소개 문구 (site/content 문서)
   ------------------------------------------------------------
   한 화면에 소개 페이지 순서대로 섹션(미리보기 + 폼)을 나열
   ============================================================ */
const contentRef = doc(db, "site", "content");

/* site-data.js 의 값을 기본값으로 사용 */
let siteData = { ...SITE };
let statsData = STATS.map((s) => ({ ...s }));
let valuesData = VALUES.map((v) => ({ ...v }));
let scheduleData = SCHEDULE.map((s) => ({ ...s }));
let joinData = [];      // 가입 안내 절차 (기본값 없음 — 저장해야 소개 페이지에 표시)
let contactData = "";   // 가입 문의 문구 (기본값 없음)

async function loadSiteContent() {
  try {
    const snap = await getDoc(contentRef);
    if (snap.exists()) {
      const d = snap.data();
      if (d.site) Object.assign(siteData, d.site);
      // 빈 목록도 그대로 반영 (항목을 모두 지워 저장하면 소개 페이지에서 해당 섹션이 숨겨짐)
      if (Array.isArray(d.stats)) statsData = d.stats;
      if (Array.isArray(d.values)) valuesData = d.values;
      if (Array.isArray(d.schedule)) scheduleData = d.schedule;
      if (Array.isArray(d.joinSteps)) joinData = d.joinSteps;
      if (typeof d.joinContact === "string") contactData = d.joinContact;
    }
  } catch (err) {
    console.error("사이트 콘텐츠 로드 실패:", err);
  }
  fillContentForms();
}

function fillContentForms() {
  $("siteCrewName").value = siteData.crewName || "";
  $("siteSlogan").value = siteData.slogan || "";
  $("siteSubSlogan").value = siteData.subSlogan || "";
  $("siteAboutDesc").value = siteData.aboutDesc || "";
  $("siteInstagram").value = siteData.instagram || "";

  $("statRows").innerHTML = statsData.map(statRowHtml).join("");
  $("valueRows").innerHTML = valuesData.map(valueRowHtml).join("");
  $("scheduleRows").innerHTML = scheduleData.map(scheduleRowHtml).join("");
  $("joinRows").innerHTML = joinData.map(joinRowHtml).join("");
  $("joinContactInput").value = contactData;
  renderPreviews();
}

/* ----- 폼의 현재 값 읽기 (저장 · 미리보기 공용) ----- */
function readSite() {
  return {
    crewName: $("siteCrewName").value.trim(),
    slogan: $("siteSlogan").value.trim(),
    subSlogan: $("siteSubSlogan").value.trim(),
    aboutDesc: $("siteAboutDesc").value.trim(),
    instagram: $("siteInstagram").value.trim().replace(/^@/, ""),
  };
}

function readStats() {
  return [...$("statRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      value: row.querySelector(".f-value").value.trim(),
      label: row.querySelector(".f-label").value.trim(),
    }))
    .filter((s) => s.value && s.label);
}

function readValues() {
  return [...$("valueRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      icon: row.querySelector(".f-icon").value.trim() || "🥕",
      title: row.querySelector(".f-title").value.trim(),
      desc: row.querySelector(".f-desc").value.trim(),
    }))
    .filter((v) => v.title);
}

function readSchedule() {
  return [...$("scheduleRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      day: row.querySelector(".f-day").value.trim(),
      time: row.querySelector(".f-time").value.trim(),
      place: row.querySelector(".f-place").value.trim(),
      course: row.querySelector(".f-course").value.trim(),
      note: row.querySelector(".f-note").value.trim(),
    }))
    .filter((s) => s.day && s.time);
}

function readJoin() {
  return [...$("joinRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      title: row.querySelector(".f-title").value.trim(),
      desc: row.querySelector(".f-desc").value.trim(),
    }))
    .filter((s) => s.title);
}

/* ============================================================
   미리보기 — 소개 페이지(index.html)와 같은 마크업·스타일로 렌더
   (입력할 때마다 다시 그려서, 저장하기 전에 실제 모습을 확인)
   ============================================================ */
const pvEmpty = (msg) => `<p class="pv-empty">${msg}</p>`;

function renderPvBasic() {
  const s = readSite();
  $("pvBasic").innerHTML = `
  <section class="hero">
    <div class="container hero-inner">
      <p class="hero-eyebrow">ULSAN · CARROT RUNNING CREW</p>
      <h1 class="hero-title"><span>${escMultiline(s.slogan) || "메인 슬로건"}</span></h1>
      <p class="hero-sub">${escMultiline(s.subSlogan)}</p>
    </div>
  </section>
  <section class="section">
    <div class="container">
      <p class="section-eyebrow">ABOUT US</p>
      <h2 class="section-title">${esc(s.crewName || "당근러닝크루")}를 소개합니다</h2>
      <p class="section-desc">${escMultiline(s.aboutDesc)}</p>
      <p class="section-note">Instagram → <span class="inline-link">@${esc(s.instagram)}</span></p>
    </div>
  </section>`;
}

function renderPvStats() {
  const stats = readStats();
  $("pvStats").innerHTML = stats.length
    ? `<section class="hero"><div class="container">
        <ul class="stats">${stats.map((st) =>
          `<li><strong>${esc(st.value)}</strong><span>${esc(st.label)}</span></li>`).join("")}</ul>
      </div></section>`
    : pvEmpty("항목이 없어요 — 소개 페이지에서 이 통계가 숨겨져요.");
}

function renderPvValues() {
  const values = readValues();
  $("pvValues").innerHTML = values.length
    ? `<section class="section"><div class="container">
        <p class="section-eyebrow">ABOUT US</p>
        <h2 class="section-title">당근러닝크루를 소개합니다</h2>
        <div class="value-grid">${values.map((v) => `
          <article class="value-card">
            <div class="value-icon">${esc(v.icon)}</div>
            <h3>${esc(v.title)}</h3>
            <p>${esc(v.desc)}</p>
          </article>`).join("")}</div>
      </div></section>`
    : pvEmpty("카드가 없어요 — 소개 페이지에서 핵심 가치가 숨겨져요.");
}

function renderPvSchedule() {
  const schedule = readSchedule();
  $("pvSchedule").innerHTML = schedule.length
    ? `<section class="section section-alt"><div class="container">
        <p class="section-eyebrow">WEEKLY RUN</p>
        <h2 class="section-title">정기런 일정</h2>
        <div class="schedule-grid">${schedule.map((s) => `
          <article class="schedule-card">
            <div class="schedule-day">${esc(s.day)}</div>
            <div class="schedule-time">${esc(s.time)}</div>
            <dl class="schedule-info">
              <div><dt>집결</dt><dd>${esc(s.place)}</dd></div>
              <div><dt>코스</dt><dd>${esc(s.course)}</dd></div>
            </dl>
            <p class="schedule-note">${esc(s.note)}</p>
          </article>`).join("")}</div>
      </div></section>`
    : pvEmpty("일정이 없어요 — 소개 페이지에서 정기런 섹션이 숨겨져요.");
}

function renderPvJoin() {
  const steps = readJoin();
  const contact = $("joinContactInput").value.trim();
  const joinHtml = steps.length
    ? `<section class="section join-section"><div class="container">
        <p class="section-eyebrow">JOIN US</p>
        <h2 class="section-title">크루 가입 안내</h2>
        <div class="join-steps">${steps.map((s, i) => `
          <article class="join-step">
            <span class="join-step-num">${String(i + 1).padStart(2, "0")}</span>
            <h3>${esc(s.title)}</h3>
            <p>${escMultiline(s.desc)}</p>
          </article>`).join("")}</div>
      </div></section>`
    : pvEmpty("절차가 없어요 — 소개 페이지에서 가입 안내(JOIN US)가 숨겨져요.");
  const contactHtml = contact
    ? `<section class="section"><div class="container">
        <p class="section-eyebrow">CONTACT</p>
        <h2 class="section-title">가입 문의</h2>
        <p class="section-desc">${escMultiline(contact)}</p>
      </div></section>`
    : pvEmpty("문구가 없어요 — 소개 페이지에서 가입 문의가 숨겨져요.");
  $("pvJoin").innerHTML = joinHtml + contactHtml;
}

const PV_BY_SEC = {
  "sec-basic": renderPvBasic,
  "sec-stats": renderPvStats,
  "sec-values": renderPvValues,
  "sec-schedule": renderPvSchedule,
  "sec-join": renderPvJoin,
};

function renderPreviews() {
  Object.values(PV_BY_SEC).forEach((fn) => fn());
}

/* 입력하는 즉시 해당 섹션의 미리보기 갱신 */
$("viewAdmin").addEventListener("input", (e) => {
  const sec = e.target.closest(".edit-sec");
  const fn = sec && PV_BY_SEC[sec.id];
  if (fn) fn();
});

/* ----- 동적 행 템플릿 ----- */
function statRowHtml(s = {}) {
  return `
  <div class="dyn-row stat-row">
    <input class="f-value" maxlength="20" placeholder="값 (예: 40+)" value="${esc(s.value || "")}" />
    <input class="f-label" maxlength="20" placeholder="설명 (예: 크루 멤버)" value="${esc(s.label || "")}" />
    <button type="button" class="row-del" aria-label="이 항목 삭제">✕</button>
  </div>`;
}

function valueRowHtml(v = {}) {
  return `
  <div class="dyn-row value-row">
    <input class="f-icon" maxlength="4" placeholder="🥕" value="${esc(v.icon || "")}" />
    <input class="f-title" maxlength="30" placeholder="제목 (예: 함께 달리기)" value="${esc(v.title || "")}" />
    <button type="button" class="row-del" aria-label="이 카드 삭제">✕</button>
    <textarea class="f-desc" rows="2" maxlength="200" placeholder="설명">${esc(v.desc || "")}</textarea>
  </div>`;
}

function scheduleRowHtml(s = {}) {
  return `
  <div class="dyn-row schedule-row">
    <input class="f-day" maxlength="10" placeholder="요일 (예: 화요일)" value="${esc(s.day || "")}" />
    <input class="f-time" maxlength="10" placeholder="시간 (예: 19:20)" value="${esc(s.time || "")}" />
    <button type="button" class="row-del" aria-label="이 일정 삭제">✕</button>
    <input class="f-place" maxlength="40" placeholder="집결 장소" value="${esc(s.place || "")}" />
    <input class="f-course" maxlength="40" placeholder="코스 (예: 트랙런 5~7km)" value="${esc(s.course || "")}" />
    <input class="f-note" maxlength="60" placeholder="비고 (한 줄 소개)" value="${esc(s.note || "")}" />
  </div>`;
}

function joinRowHtml(s = {}) {
  return `
  <div class="dyn-row join-row">
    <input class="f-title" maxlength="30" placeholder="제목 (예: 가입 신청)" value="${esc(s.title || "")}" />
    <button type="button" class="row-del" aria-label="이 절차 삭제">✕</button>
    <textarea class="f-desc" rows="2" maxlength="200" placeholder="설명 (예: 크루 가입하기 버튼으로 신청해 주세요)">${esc(s.desc || "")}</textarea>
  </div>`;
}

/* ----- 행 추가 / 삭제 (변경 즉시 미리보기 갱신) ----- */
document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.add;
    const target = { stat: "statRows", value: "valueRows", schedule: "scheduleRows", join: "joinRows" }[kind];
    const html = { stat: statRowHtml, value: valueRowHtml, schedule: scheduleRowHtml, join: joinRowHtml }[kind]();
    $(target).insertAdjacentHTML("beforeend", html);
    const fn = PV_BY_SEC[btn.closest(".edit-sec")?.id];
    if (fn) fn();
  });
});

$("viewAdmin").addEventListener("click", (e) => {
  const del = e.target.closest(".row-del");
  if (!del || !del.closest(".dyn-row")) return; // 공식 기록 섹션의 ✕는 raceList 핸들러가 처리
  const sec = del.closest(".edit-sec");
  del.closest(".dyn-row").remove();
  const fn = sec && PV_BY_SEC[sec.id];
  if (fn) fn();
});

/* ----- 저장 ----- */

/* 소개 페이지 첫 화면 캐시 갱신 (public/main.js 의 CACHE_KEY 와 동일)
   — 저장 직후 이 기기에서 소개 페이지를 열어도 이전 값 깜빡임 없이 새 내용이 바로 보이게 */
const CACHE_KEY = "crc-site-content-v1";
function updateContentCache(patch) {
  try {
    const cur = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* localStorage 불가 환경이면 건너뜀 (소개 페이지가 Firestore 로 갱신함) */
  }
}

$("formSite").addEventListener("submit", async (e) => {
  e.preventDefault();
  const site = { ...siteData, ...readSite() };
  try {
    await setDoc(contentRef, { site, updatedAt: serverTimestamp() }, { merge: true });
    siteData = site;
    updateContentCache({ site });
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formStats").addEventListener("submit", async (e) => {
  e.preventDefault();
  const stats = readStats();
  try {
    await setDoc(contentRef, { stats, updatedAt: serverTimestamp() }, { merge: true });
    statsData = stats;
    updateContentCache({ stats });
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formValues").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = readValues();
  try {
    await setDoc(contentRef, { values, updatedAt: serverTimestamp() }, { merge: true });
    valuesData = values;
    updateContentCache({ values });
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formSchedule").addEventListener("submit", async (e) => {
  e.preventDefault();
  const schedule = readSchedule();
  try {
    await setDoc(contentRef, { schedule, updatedAt: serverTimestamp() }, { merge: true });
    scheduleData = schedule;
    updateContentCache({ schedule });
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formJoin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const joinSteps = readJoin();
  try {
    await setDoc(contentRef, { joinSteps, updatedAt: serverTimestamp() }, { merge: true });
    joinData = joinSteps;
    updateContentCache({ joinSteps });
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formContact").addEventListener("submit", async (e) => {
  e.preventDefault();
  const joinContact = $("joinContactInput").value.trim();
  try {
    await setDoc(contentRef, { joinContact, updatedAt: serverTimestamp() }, { merge: true });
    contactData = joinContact;
    updateContentCache({ joinContact });
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

/* ============================================================
   3. 크루 공식 기록 (records 컬렉션)
   ============================================================ */
let races = [];

function startRecordsListener() {
  unsubs.push(onSnapshot(
    collection(db, "records"),
    (qs) => {
      races = qs.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.month < b.month ? 1 : -1));
      renderRaces();
    },
    (e) => console.error("기록 구독 오류:", e)
  ));
}

function fmtMonth(month) {
  const [y, m] = String(month || "").split("-");
  return y ? `${y}. ${Number(m)}.` : "";
}

/* 입상 순위 — 예전에 저장한 완주 기록(time)도 그대로 보여줍니다 */
function recordText(r) {
  return r.rank || r.time || "";
}

function renderRaces() {
  const list = $("raceList");
  if (!races.length) {
    list.innerHTML = `<p class="empty-note">아직 등록된 대회가 없습니다. 위의 '대회 추가'로 시작해 보세요!</p>`;
    return;
  }

  list.innerHTML = races.map((race) => {
    const results = race.results || [];
    const groups = {};
    results.forEach((r, idx) => {
      (groups[r.event] = groups[r.event] || []).push({ ...r, idx });
    });
    const events = Object.keys(groups).sort((a, b) => eventOrder(a) - eventOrder(b));

    const recordsHtml = events.length
      ? events.map((ev) => `
        <div class="rec-group">
          <span class="event-badge">${esc(ev)}</span>
          <ul class="rec-list">
            ${groups[ev].map((r) => `
              <li>
                <span class="rec-name">${esc(r.name)}</span>
                <span class="rec-rank">${esc(recordText(r))}</span>
                <button type="button" class="row-del" data-action="del-rec" data-id="${race.id}" data-idx="${r.idx}" aria-label="기록 삭제">✕</button>
              </li>`).join("")}
          </ul>
        </div>`).join("")
      : `<p class="empty-note">아직 기록이 없어요. 아래에서 추가해 주세요.</p>`;

    return `
    <article class="app-card race-admin">
      <div class="app-card-head">
        <div>
          <h4>${esc(race.race)}</h4>
          <p class="app-card-meta">${fmtMonth(race.month)}</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini dark" data-action="edit-race" data-id="${race.id}">이름 수정</button>
          <button class="btn-mini danger" data-action="del-race" data-id="${race.id}">대회 삭제</button>
        </div>
      </div>
      <div class="admin-records">${recordsHtml}</div>
      <form class="rec-add" data-id="${race.id}">
        <input class="f-name" required maxlength="20" placeholder="이름" />
        <select class="f-event">
          ${EVENT_OPTIONS.map((o) => `<option>${o}</option>`).join("")}
        </select>
        <input class="f-rank" required maxlength="20" placeholder="입상 순위" />
        <button type="submit" class="btn-mini leaf">추가</button>
      </form>
    </article>`;
  }).join("");
}

/* 대회 등록 */
$("raceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const month = $("raceMonth").value; // "YYYY-MM"
  try {
    await addDoc(collection(db, "records"), {
      race: $("raceName").value.trim(),
      month,
      year: Number(month.split("-")[0]),
      results: [],
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    e.target.closest("details").open = false;
  } catch (err) {
    alert("대회 등록에 실패했어요: " + err.message);
  }
});

/* 기록 추가 (대회 카드 안의 폼) */
$("raceList").addEventListener("submit", async (e) => {
  const form = e.target.closest(".rec-add");
  if (!form) return;
  e.preventDefault();

  const rank = form.querySelector(".f-rank").value.trim();
  if (!rank) return;

  const race = races.find((r) => r.id === form.dataset.id);
  if (!race) return;

  try {
    await updateDoc(doc(db, "records", race.id), {
      results: [
        ...(race.results || []),
        {
          name: form.querySelector(".f-name").value.trim(),
          event: form.querySelector(".f-event").value,
          rank,
        },
      ],
    });
    form.querySelector(".f-name").value = "";
    form.querySelector(".f-rank").value = "";
  } catch (err) {
    alert("기록 추가에 실패했어요: " + err.message);
  }
});

/* 대회/기록 관리 버튼 */
$("raceList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const race = races.find((r) => r.id === id);
  if (!race) return;

  try {
    if (action === "del-race") {
      if (confirm(`'${race.race}' 대회와 기록을 모두 삭제할까요?`)) {
        await deleteDoc(doc(db, "records", id));
      }
    } else if (action === "edit-race") {
      const name = prompt("대회명 수정:", race.race);
      if (name && name.trim() && name.trim() !== race.race) {
        await updateDoc(doc(db, "records", id), { race: name.trim() });
      }
    } else if (action === "del-rec") {
      const idx = Number(btn.dataset.idx);
      const target = (race.results || [])[idx];
      if (target && confirm(`${target.name}님의 ${target.event} 기록을 삭제할까요?`)) {
        await updateDoc(doc(db, "records", id), {
          results: race.results.filter((_, i) => i !== idx),
        });
      }
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});
