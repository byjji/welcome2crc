/* ============================================================
   당근러닝크루 공개 페이지(index.html) 스크립트
   ------------------------------------------------------------
   — 기본 내용은 js/site-data.js 의 값으로 먼저 그려지고,
     운영진이 관리자 페이지(admin.html)에서 저장한 내용이
     Firestore 에 있으면 불러와서 자동으로 덮어씁니다.
   — 가입 신청서는 Firebase Firestore(applications)에 저장됩니다.
   ============================================================ */

/* 현재 화면에 그릴 콘텐츠 (기본값: site-data.js → Firestore 로 덮어씀) */
const content = {
  site: { ...SITE },
  stats: STATS,
  values: VALUES,
  schedule: SCHEDULE,
};

/* 종목(거리) 탭 표시 순서 */
const EVENT_ORDER = ["풀코스", "하프", "10km", "5km", "3km"];

let db = null; // Firestore 인스턴스 (원격 콘텐츠 로드 후 갤러리에서 재사용)
const albumPhotoCache = {}; // albumId → photos[]

document.addEventListener("DOMContentLoaded", () => {
  applySiteInfo();
  renderStats();
  renderValues();
  renderSchedule();
  renderRecords(recordsFromSiteData());
  renderGalleryFallback();
  renderJoinSteps();
  setupNav();
  setupReveal();
  setupRecordTabs();
  setupGalleryViewer();
  setupJoinForm();
  document.getElementById("year").textContent = new Date().getFullYear();

  loadRemoteContent(); // Firestore 에 저장된 내용이 있으면 자동 반영
});

/* ---------- HTML 이스케이프 (운영진 입력값 안전 처리) ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escMultiline(s) {
  return esc(s).replace(/\n/g, "<br />");
}

/* ============================================================
   Firestore 원격 콘텐츠 로드
   ============================================================ */
async function loadRemoteContent() {
  if (!window.FIREBASE_READY) return;

  try {
    const { initializeApp, getApps } = await import(`${window.FIREBASE_SDK}/firebase-app.js`);
    const { getFirestore, doc, getDoc, collection, getDocs } = await import(
      `${window.FIREBASE_SDK}/firebase-firestore.js`
    );

    const app = getApps().length ? getApps()[0] : initializeApp(window.FIREBASE_CONFIG);
    db = getFirestore(app);

    const [siteSnap, recordSnap, gallerySnap] = await Promise.all([
      getDoc(doc(db, "site", "content")).catch(() => null),
      getDocs(collection(db, "records")).catch(() => null),
      getDocs(collection(db, "gallery")).catch(() => null),
    ]);

    // 소개 문구/통계/핵심가치/정기런
    if (siteSnap && siteSnap.exists()) {
      const data = siteSnap.data();
      if (data.site) Object.assign(content.site, data.site);
      if (Array.isArray(data.stats) && data.stats.length) content.stats = data.stats;
      if (Array.isArray(data.values) && data.values.length) content.values = data.values;
      if (Array.isArray(data.schedule) && data.schedule.length) content.schedule = data.schedule;
      applySiteInfo();
      renderStats();
      renderValues();
      renderSchedule();
    }

    // 크루 공식 기록
    if (recordSnap && recordSnap.size) {
      renderRecords(recordsFromDocs(recordSnap.docs));
    }

    // 갤러리 앨범
    if (gallerySnap && gallerySnap.size) {
      const albums = gallerySnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderAlbums(albums);
    }
  } catch (err) {
    console.warn("원격 콘텐츠 로드 실패 (기본 내용으로 표시):", err);
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

/* ---------- 크루 현황 통계 ---------- */
function renderStats() {
  const ul = document.getElementById("statsList");
  ul.innerHTML = content.stats.map(
    (s) => `<li><strong>${esc(s.value)}</strong><span>${esc(s.label)}</span></li>`
  ).join("");
}

/* ---------- 핵심 가치 카드 ---------- */
function renderValues() {
  const grid = document.getElementById("valueGrid");
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

/* ---------- 정기런 일정 ---------- */
function renderSchedule() {
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

/* site-data.js 의 RECORDS → 공통 구조로 변환 */
function recordsFromSiteData() {
  return Object.keys(RECORDS)
    .sort((a, b) => b - a)
    .map((year) => ({ year, races: RECORDS[year] }));
}

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
   갤러리 — 기본(색상 카드) / Firestore 앨범
   ============================================================ */
function renderGalleryFallback() {
  const grid = document.getElementById("galleryGrid");
  grid.innerHTML = GALLERY.map((g, i) => {
    const media = g.image
      ? `<img src="${esc(g.image)}" alt="${esc(g.caption)}" loading="lazy" />`
      : `<div class="gallery-placeholder p${(i % 4) + 1}"><span>🥕</span></div>`;
    return `
      <figure class="gallery-item reveal">
        ${media}
        <figcaption>${esc(g.caption)}</figcaption>
      </figure>`;
  }).join("");
}

/* Firestore 앨범 목록 */
function renderAlbums(albums) {
  const grid = document.getElementById("galleryGrid");
  grid.innerHTML = albums.map((a, i) => {
    const cover = a.cover
      ? `<img src="${a.cover}" alt="${esc(a.name)}" loading="lazy" />`
      : `<div class="gallery-placeholder p${(i % 4) + 1}"><span>🥕</span></div>`;
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
    body.innerHTML = `<p class="viewer-loading">사진 불러오는 중... 🥕</p>`;
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
  const { collection, getDocs, query, orderBy } = await import(
    `${window.FIREBASE_SDK}/firebase-firestore.js`
  );
  const qs = await getDocs(
    query(collection(db, "gallery", albumId, "photos"), orderBy("createdAt", "asc"))
  );
  const photos = qs.docs.map((d) => d.data());
  albumPhotoCache[albumId] = photos;
  return photos;
}

/* ---------- 가입 절차 ---------- */
function renderJoinSteps() {
  const wrap = document.getElementById("joinSteps");
  wrap.innerHTML = JOIN_STEPS.map(
    (s) => `
    <article class="join-step reveal">
      <span class="join-step-num">${s.step}</span>
      <h3>${s.title}</h3>
      <p>${s.desc}</p>
    </article>`
  ).join("");
}

/* ---------- 가입 신청 폼 → Firestore ---------- */
function setupJoinForm() {
  const form = document.getElementById("joinForm");
  const msg = document.getElementById("joinMsg");
  const submitBtn = document.getElementById("joinSubmit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!window.FIREBASE_READY) {
      showMsg("아직 신청서 저장소(Firebase)가 연결되지 않았어요. 인스타그램 DM으로 연락해 주세요! 🙏", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "신청서 보내는 중...";

    try {
      // Firebase SDK는 필요할 때만 불러옵니다 (페이지 로딩 속도 보호)
      const { initializeApp, getApps } = await import(`${window.FIREBASE_SDK}/firebase-app.js`);
      const { getFirestore, collection, addDoc, serverTimestamp } = await import(
        `${window.FIREBASE_SDK}/firebase-firestore.js`
      );

      const app = getApps().length ? getApps()[0] : initializeApp(window.FIREBASE_CONFIG);
      const db = getFirestore(app);

      await addDoc(collection(db, "applications"), {
        name: form.name.value.trim(),
        contact: form.contact.value.trim(),
        age: form.age.value,
        level: form.level.value,
        message: form.message.value.trim(),
        createdAt: serverTimestamp(),
      });

      form.reset();
      showMsg("가입 신청이 접수되었습니다! 운영진이 확인 후 연락드릴게요 🥕", "ok");
    } catch (err) {
      console.error("가입 신청 저장 실패:", err);
      showMsg("전송에 실패했어요. 잠시 후 다시 시도하거나 인스타그램 DM으로 연락해 주세요.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "가입 신청하기 🥕";
    }
  });

  function showMsg(text, type) {
    msg.hidden = false;
    msg.textContent = text;
    msg.className = `form-msg ${type}`;
  }
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
