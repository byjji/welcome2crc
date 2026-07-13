/* ============================================================
   당근러닝크루 공개 페이지(index.html) 스크립트
   ------------------------------------------------------------
   — 첫 화면은 ①localStorage 에 캐시된 마지막 저장 콘텐츠,
     없으면 ②site-data.js 기본값으로 그려지고, 이어서
     ③Firestore 의 최신 저장 내용으로 갱신(+캐시 저장)됩니다.
     → 운영진이 바꾼 내용이 기본값 깜빡임 없이 바로 보입니다.
   — 항목이 하나도 없는 섹션(크루 현황 숫자·핵심 가치·정기런 일정)은
     자동으로 숨겨지고, 공식 기록 섹션은 운영진이 저장한 내용이
     있을 때만 표시됩니다.
   — 가입 신청은 폼 없이 인스타그램 DM 으로만 받습니다.
   ============================================================ */

import { esc, escMultiline } from "../../lib/format.js";

/* 현재 화면에 그릴 콘텐츠 (기본값: site-data.js → Firestore 로 덮어씀) */
const content = {
  site: { ...SITE },
  stats: STATS,
  values: VALUES,
  schedule: SCHEDULE,
  joinSteps: [],   // 가입 안내 절차 — 운영진이 저장한 내용만 표시 (기본값 없음)
  joinContact: "", // 가입 문의 문구 — 운영진이 저장한 내용만 표시 (기본값 없음)
};

/* 종목(거리) 탭 표시 순서 — 짧은 거리부터 (페이지 관리의 종목 선택과 동일) */
const EVENT_ORDER = ["3km", "5km", "10km", "하프", "풀코스"];

document.addEventListener("DOMContentLoaded", () => {
  applyCachedContent(); // 지난 방문 때 저장해 둔 운영진 콘텐츠로 먼저 그림 (기본값 깜빡임 방지)
  applySiteInfo();
  renderStats();
  renderValues();
  renderSchedule();
  renderJoinSteps();
  renderJoinContact();
  setupNav();
  setupReveal();
  setupRecordTabs();
  document.getElementById("year").textContent = new Date().getFullYear();

  loadRemoteContent(); // Firestore 에 저장된 내용이 있으면 자동 반영
});

/* ============================================================
   운영진 저장 콘텐츠 반영 + 로컬 캐시
   ------------------------------------------------------------
   Firestore 응답이 오기 전까지 기본값(site-data.js)이 잠깐 보이는
   깜빡임을 없애기 위해, 마지막으로 불러온 저장 내용을 localStorage
   에 보관했다가 다음 방문의 첫 화면부터 그 값으로 그립니다.
   ============================================================ */
const CACHE_KEY = "crc-site-content-v1";

/* 저장 문서(site/content)의 내용을 화면 데이터에 반영
   — 빈 목록도 그대로 반영해 운영진이 항목을 모두 지우면 섹션이 숨겨집니다 */
function mergeSiteData(data) {
  if (data.site) Object.assign(content.site, data.site);
  if (Array.isArray(data.stats)) content.stats = data.stats;
  if (Array.isArray(data.values)) content.values = data.values;
  if (Array.isArray(data.schedule)) content.schedule = data.schedule;
  if (Array.isArray(data.joinSteps)) content.joinSteps = data.joinSteps;
  if (typeof data.joinContact === "string") content.joinContact = data.joinContact;
}

function applyCachedContent() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) mergeSiteData(JSON.parse(raw));
  } catch {
    /* 사생활 보호 모드 등 localStorage 불가·캐시 손상 → 기본값으로 진행 */
  }
}

function saveContentCache(data) {
  try {
    // 화면에 쓰는 필드만 저장 (updatedAt 같은 Firestore 타입 제외)
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      site: data.site,
      stats: data.stats,
      values: data.values,
      schedule: data.schedule,
      joinSteps: data.joinSteps,
      joinContact: data.joinContact,
    }));
  } catch {
    /* 저장 실패해도 화면 동작에는 영향 없음 */
  }
}

/* 첫 방문 스플래시 걷기 (index.html 의 인라인 스크립트가 캐시 없을 때 띄움) */
function hideSplash() {
  document.documentElement.classList.remove("splash");
}

/* ============================================================
   Firestore 원격 콘텐츠 로드
   ============================================================ */
async function loadRemoteContent() {
  if (!window.FIREBASE_READY) {
    hideSplash();
    return;
  }

  try {
    const { db, doc, getDoc, collection, getDocs } = await import("../../lib/firebase.js");

    const [siteSnap, recordSnap] = await Promise.all([
      getDoc(doc(db, "site", "content")).catch(() => null),
      getDocs(collection(db, "records")).catch(() => null),
    ]);

    // 소개 문구/통계/핵심가치/정기런 — 최신 내용 반영 + 다음 방문용 캐시
    if (siteSnap && siteSnap.exists()) {
      const data = siteSnap.data();
      mergeSiteData(data);
      saveContentCache(data);
      applySiteInfo();
      renderStats();
      renderValues();
      renderSchedule();
      renderJoinSteps();
      renderJoinContact();
    } else if (siteSnap) {
      // 문서가 아예 없으면(저장 전 초기 상태) 낡은 캐시가 남지 않게 정리
      try { localStorage.removeItem(CACHE_KEY); } catch { /* 무시 */ }
    }

    // 크루 공식 기록 — 운영진이 저장한 대회가 있을 때만 섹션 표시
    if (recordSnap && recordSnap.size) {
      renderRecords(recordsFromDocs(recordSnap.docs));
      toggleSection("records", true);
    }
  } catch (err) {
    console.warn("원격 콘텐츠 로드 실패 (기본 내용으로 표시):", err);
  } finally {
    hideSplash(); // 성공·실패와 무관하게 콘텐츠 준비가 끝나면 스플래시 걷기
  }
}

/* ---------- 기본 정보 반영 (인스타 링크 등) ---------- */
function applySiteInfo() {
  const instaUrl = `https://www.instagram.com/${content.site.instagram}/`;
  document.querySelectorAll("[data-insta-link]").forEach((a) => (a.href = instaUrl));
  document.querySelectorAll("[data-insta-handle]").forEach((el) => (el.textContent = `@${content.site.instagram}`));
  document.querySelectorAll("[data-site]").forEach((el) => {
    const key = el.dataset.site;
    if (content.site[key]) el.innerHTML = escMultiline(content.site[key]);
  });
}

/* ---------- 섹션 표시/숨김 (내용 없는 섹션은 메뉴 링크까지 숨김) ---------- */
function toggleSection(id, show) {
  const section = document.getElementById(id);
  if (section) section.hidden = !show;
  document.querySelectorAll(`a[href="#${id}"]`).forEach((a) => (a.hidden = !show));
}

/* ---------- 크루 현황 통계 (항목이 없으면 숨김) ---------- */
function renderStats() {
  const ul = document.getElementById("statsList");
  ul.hidden = !content.stats.length;
  ul.innerHTML = content.stats.map(
    (s) => `<li><strong>${esc(s.value)}</strong><span>${esc(s.label)}</span></li>`
  ).join("");
}

/* ---------- 핵심 가치 카드 (항목이 없으면 숨김) ---------- */
function renderValues() {
  const grid = document.getElementById("valueGrid");
  grid.hidden = !content.values.length;
  grid.innerHTML = content.values.map(
    (v) => `
    <article class="value-card reveal">
      <div class="value-icon">${esc(v.icon)}</div>
      <h3>${esc(v.title)}</h3>
      <p>${esc(v.desc)}</p>
    </article>`
  ).join("");
  observeReveals(grid);
}

/* ---------- 정기런 일정 (항목이 없으면 섹션 전체 숨김) ---------- */
function renderSchedule() {
  toggleSection("schedule", content.schedule.length > 0);
  const grid = document.getElementById("scheduleGrid");
  grid.innerHTML = content.schedule.map(
    (s) => `
    <article class="schedule-card reveal">
      <div class="schedule-day">${esc(s.day)}</div>
      <div class="schedule-time">${esc(s.time)}</div>
      <dl class="schedule-info">
        <div><dt>집결</dt><dd>${esc(s.place)}</dd></div>
        <div><dt>코스</dt><dd>${esc(s.course)}</dd></div>
      </dl>
      <p class="schedule-note">${esc(s.note)}</p>
    </article>`
  ).join("");
  observeReveals(grid);
}

/* ============================================================
   공식 기록 — 연도 탭 → 대회 카드 → 종목(거리) 탭
   ============================================================ */

/* Firestore records 문서들 → 공통 구조로 변환 */
function recordsFromDocs(docs) {
  const races = docs.map((d) => {
    const r = d.data();
    const [y, m] = String(r.month || "").split("-");
    return {
      race: r.race,
      month: r.month || "",
      date: y ? `${y}. ${Number(m)}.` : "",
      year: String(r.year || y || ""),
      results: r.results || [],
    };
  });

  const byYear = {};
  races.forEach((r) => {
    if (!r.year) return;
    (byYear[r.year] = byYear[r.year] || []).push(r);
  });

  return Object.keys(byYear)
    .sort((a, b) => b - a)
    .map((year) => ({
      year,
      races: byYear[year].sort((a, b) => (a.month < b.month ? 1 : -1)),
    }));
}

/* 입상 순위 — 예전에 저장한 완주 기록(time)도 그대로 보여줍니다 */
function recordText(r) {
  return r.rank || r.time || "";
}

/* "1위" → 1 (정렬용). 숫자로 시작하지 않는 값("우승" 등)은 맨 뒤로 */
function rankOrder(r) {
  const n = parseInt(String(recordText(r)).trim(), 10);
  return Number.isNaN(n) ? Infinity : n;
}

function raceCardHtml(race, uid) {
  // 종목별로 묶기 (표시 순서: EVENT_ORDER 우선, 그 외는 뒤에)
  const groups = {};
  (race.results || []).forEach((r) => {
    (groups[r.event] = groups[r.event] || []).push(r);
  });
  const events = Object.keys(groups).sort((a, b) => {
    const ia = EVENT_ORDER.indexOf(a), ib = EVENT_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const tabs = events.map((ev, i) => `
    <button class="event-tab ${i === 0 ? "active" : ""}" role="tab"
            aria-selected="${i === 0}" data-event="${esc(ev)}">
      ${esc(ev)} <span class="event-cnt">${groups[ev].length}</span>
    </button>`).join("");

  const panels = events.map((ev, i) => {
    const rows = groups[ev]
      .slice()
      .sort((a, b) => rankOrder(a) - rankOrder(b))
      .map((r) => `
        <tr>
          <td>${esc(r.name)}</td>
          <td class="place">${esc(recordText(r))}</td>
        </tr>`).join("");
    return `
      <div class="event-panel ${i === 0 ? "active" : ""}" data-event="${esc(ev)}" role="tabpanel">
        <div class="table-scroll">
          <table class="record-table slim">
            <thead><tr><th>이름</th><th>입상 순위</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join("");

  return `
    <article class="race-card reveal">
      <header class="race-head">
        <h3>${esc(race.race)}</h3>
        <span class="race-date">${esc(race.date)}</span>
      </header>
      ${events.length
        ? `<div class="event-tabs" role="tablist">${tabs}</div>${panels}`
        : `<p class="empty-note race-empty">등록된 기록이 없습니다.</p>`}
    </article>`;
}

function renderRecords(yearGroups) {
  const tabs = document.getElementById("recordTabs");
  const panels = document.getElementById("recordPanels");

  if (!yearGroups.length) {
    tabs.innerHTML = "";
    panels.innerHTML = `<p class="empty-note">아직 등록된 기록이 없습니다.</p>`;
    return;
  }

  tabs.innerHTML = yearGroups.map(
    (g, i) => `
      <button class="record-tab ${i === 0 ? "active" : ""}" role="tab"
              aria-selected="${i === 0}" data-year="${esc(g.year)}">${esc(g.year)}</button>`
  ).join("");

  panels.innerHTML = yearGroups.map(
    (g, i) => `
      <div class="record-panel ${i === 0 ? "active" : ""}" data-year="${esc(g.year)}" role="tabpanel">
        ${g.races.map((race) => raceCardHtml(race)).join("")}
      </div>`
  ).join("");

  observeReveals(panels);
}

/* 연도 탭 + 종목 탭 클릭 (한 번만 바인딩, 재렌더링에도 동작) */
function setupRecordTabs() {
  const tabs = document.getElementById("recordTabs");
  const panels = document.getElementById("recordPanels");

  tabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".record-tab");
    if (!btn) return;
    tabs.querySelectorAll(".record-tab").forEach((t) => {
      t.classList.toggle("active", t === btn);
      t.setAttribute("aria-selected", t === btn);
    });
    panels.querySelectorAll(".record-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.year === btn.dataset.year);
    });
  });

  panels.addEventListener("click", (e) => {
    const btn = e.target.closest(".event-tab");
    if (!btn) return;
    const card = btn.closest(".race-card");
    card.querySelectorAll(".event-tab").forEach((t) => {
      t.classList.toggle("active", t === btn);
      t.setAttribute("aria-selected", t === btn);
    });
    card.querySelectorAll(".event-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.event === btn.dataset.event);
    });
  });
}

/* ---------- 가입 안내 (JOIN US) — 운영진이 저장한 절차가 있을 때만 표시 ---------- */
function renderJoinSteps() {
  const steps = content.joinSteps || [];
  toggleSection("join", steps.length > 0);
  const wrap = document.getElementById("joinSteps");
  wrap.innerHTML = steps.map(
    (s, i) => `
    <article class="join-step reveal">
      <span class="join-step-num">${String(i + 1).padStart(2, "0")}</span>
      <h3>${esc(s.title)}</h3>
      <p>${escMultiline(s.desc)}</p>
    </article>`
  ).join("");
  observeReveals(wrap);
}

/* ---------- 가입 문의 — 운영진이 저장한 문구가 있을 때만 표시 ---------- */
function renderJoinContact() {
  const text = String(content.joinContact || "").trim();
  toggleSection("contact", text.length > 0);
  document.getElementById("joinContactText").innerHTML = escMultiline(text);
}

/* ---------- 내비게이션 (모바일 메뉴 + 스크롤 헤더) ---------- */
function setupNav() {
  const toggle = document.getElementById("navToggle");
  const nav = document.getElementById("mainNav");
  const header = document.getElementById("siteHeader");

  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open);
  });

  // 메뉴 링크 클릭 시 모바일 메뉴 닫기
  nav.addEventListener("click", (e) => {
    if (e.target.tagName === "A") {
      nav.classList.remove("open");
      toggle.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });

  // 스크롤 시 헤더 배경 처리
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 10);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* ---------- 스크롤 등장 애니메이션 ---------- */
let revealObserver = null;

function setupReveal() {
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
}

/* 재렌더링된 요소도 등장 애니메이션 적용
   (setupReveal 실행 전 최초 렌더링 시에는 setupReveal 이 일괄 등록하므로 건너뜀) */
function observeReveals(root) {
  if (!root || !revealObserver) return;
  root.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
}
