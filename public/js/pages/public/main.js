/* ============================================================
   당근러닝크루 공개 페이지(index.html) 스크립트
   ------------------------------------------------------------
   — 첫 화면은 ①localStorage 에 캐시된 마지막 저장 콘텐츠,
     없으면 ②site-data.js 기본값으로 그려지고, 이어서
     ③Firestore 의 최신 저장 내용으로 갱신(+캐시 저장)됩니다.
     → 운영진이 바꾼 내용이 기본값 깜빡임 없이 바로 보입니다.
   — 항목이 하나도 없는 섹션(크루 현황 숫자·핵심 가치·정기런 일정)은
     자동으로 숨겨지고, 공식 기록·갤러리 섹션은 운영진이 저장한
     내용이 있을 때만 표시됩니다.
   — 가입 신청은 폼 없이 인스타그램 DM 으로만 받습니다.
   ============================================================ */

import { esc, escMultiline } from "../../lib/format.js";
import { ic } from "../../lib/icons.js";

/* 현재 화면에 그릴 콘텐츠 (기본값: site-data.js → Firestore 로 덮어씀) */
const content = {
  site: { ...SITE },
  stats: STATS,
  values: VALUES,
  schedule: SCHEDULE,
  joinSteps: [],   // 가입 안내 절차 — 운영진이 저장한 내용만 표시 (기본값 없음)
  joinContact: "", // 가입 문의 문구 — 운영진이 저장한 내용만 표시 (기본값 없음)
};

/* 종목(거리) 탭 표시 순서 */
const EVENT_ORDER = ["풀코스", "하프", "10km", "5km", "3km"];

let db = null; // Firestore 인스턴스 (원격 콘텐츠 로드 후 갤러리에서 재사용)
const albumPhotoCache = {}; // albumId → photos[]

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
  setupGalleryViewer();
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
    const fb = await import("../../lib/firebase.js");
    const { doc, getDoc, collection, getDocs } = fb;
    db = fb.db;

    const [siteSnap, recordSnap, gallerySnap] = await Promise.all([
      getDoc(doc(db, "site", "content")).catch(() => null),
      getDocs(collection(db, "records")).catch(() => null),
      getDocs(collection(db, "gallery")).catch(() => null),
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

    // 갤러리 — 운영진이 저장한 앨범이 있을 때만 섹션 표시
    if (gallerySnap && gallerySnap.size) {
      const albums = gallerySnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderAlbums(albums);
      toggleSection("gallery", true);
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

/* "3:28:41" / "45:10" → 초 (정렬용) */
function timeToSeconds(t) {
  const parts = String(t || "").trim().split(":").map(Number);
  if (parts.some(isNaN) || !parts.length) return Infinity;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
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
      .sort((a, b) => timeToSeconds(a.time) - timeToSeconds(b.time))
      .map((r, rank) => `
        <tr>
          <td class="rank">${rank + 1}</td>
          <td>${esc(r.name)}</td>
          <td class="time">${esc(r.time)}</td>
        </tr>`).join("");
    return `
      <div class="event-panel ${i === 0 ? "active" : ""}" data-event="${esc(ev)}" role="tabpanel">
        <div class="table-scroll">
          <table class="record-table slim">
            <thead><tr><th></th><th>이름</th><th>기록</th></tr></thead>
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

/* ============================================================
   갤러리 — Firestore 앨범 (운영진이 저장한 앨범만 표시)
   ============================================================ */
/* Firestore 앨범 목록 */
function renderAlbums(albums) {
  const grid = document.getElementById("galleryGrid");
  grid.innerHTML = albums.map((a, i) => {
    const cover = a.cover
      ? `<img src="${a.cover}" alt="${esc(a.name)}" loading="lazy" />`
      : `<div class="gallery-placeholder p${(i % 4) + 1}"><span>${ic("carrot")}</span></div>`;
    return `
      <button class="gallery-item album-card reveal" data-album="${esc(a.id)}" data-name="${esc(a.name)}">
        ${cover}
        <span class="album-caption">
          <span class="album-name">${esc(a.name)}</span>
          <span class="album-count">${a.photoCount || 0}장</span>
        </span>
      </button>`;
  }).join("");
  observeReveals(grid);
}

/* 앨범 뷰어 (모바일 전체화면 오버레이) */
function setupGalleryViewer() {
  const viewer = document.createElement("div");
  viewer.className = "album-viewer";
  viewer.hidden = true;
  viewer.innerHTML = `
    <div class="viewer-head">
      <strong class="viewer-title"></strong>
      <button class="viewer-close" aria-label="닫기">✕</button>
    </div>
    <div class="viewer-body"></div>`;
  document.body.appendChild(viewer);

  const close = () => {
    viewer.hidden = true;
    document.body.style.overflow = "";
  };
  viewer.querySelector(".viewer-close").addEventListener("click", close);
  viewer.addEventListener("click", (e) => {
    if (e.target === viewer) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !viewer.hidden) close();
  });

  document.getElementById("galleryGrid").addEventListener("click", async (e) => {
    const card = e.target.closest(".album-card");
    if (!card || !db) return;

    viewer.querySelector(".viewer-title").textContent = card.dataset.name;
    const body = viewer.querySelector(".viewer-body");
    body.innerHTML = `<p class="viewer-loading">사진 불러오는 중...</p>`;
    viewer.hidden = false;
    document.body.style.overflow = "hidden";

    try {
      const photos = await loadAlbumPhotos(card.dataset.album);
      body.innerHTML = photos.length
        ? photos.map((p) => `<img src="${p.data}" alt="${esc(card.dataset.name)}" loading="lazy" />`).join("")
        : `<p class="viewer-loading">아직 사진이 없어요.</p>`;
    } catch (err) {
      console.error("사진 로드 실패:", err);
      body.innerHTML = `<p class="viewer-loading">사진을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>`;
    }
  });
}

async function loadAlbumPhotos(albumId) {
  if (albumPhotoCache[albumId]) return albumPhotoCache[albumId];
  const { collection, getDocs, query, orderBy } = await import("../../lib/firebase.js");
  const qs = await getDocs(
    query(collection(db, "gallery", albumId, "photos"), orderBy("createdAt", "asc"))
  );
  const photos = qs.docs.map((d) => d.data());
  albumPhotoCache[albumId] = photos;
  return photos;
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
