/* ============================================================
   페이지 관리 (admin.html) — 운영진 전용
   ------------------------------------------------------------
   소개 페이지(index.html)의 문구 / 크루 공식 기록 / 갤러리를
   Firestore 에 저장합니다. 저장된 내용은 소개 페이지가 열릴 때
   자동으로 불러와 표시됩니다.
   ============================================================ */

/* ---------- 화면 요소 ---------- */
const $ = (id) => document.getElementById(id);
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
  GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
} = await import(`${SDK}/firebase-auth.js`);
const {
  getFirestore, collection, doc,
  getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} = await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- 유틸 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function authErrorMsg(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/invalid-email": "이메일 형식이 올바르지 않아요.",
    "auth/user-not-found": "등록되지 않은 이메일이에요.",
    "auth/wrong-password": "비밀번호가 틀렸어요.",
    "auth/invalid-credential": "이메일 또는 비밀번호가 올바르지 않아요.",
    "auth/too-many-requests": "시도가 너무 많았어요. 잠시 후 다시 시도해 주세요.",
    "auth/popup-closed-by-user": "로그인 창이 닫혔어요. 다시 시도해 주세요.",
    "auth/network-request-failed": "네트워크 오류예요. 인터넷 연결을 확인해 주세요.",
  };
  return map[code] || `오류가 발생했어요. (${code || err})`;
}

/* 저장 완료 표시 (버튼 옆 메시지) */
function flashSaved(form, text = "저장했어요 ✅") {
  const el = form.querySelector(".save-msg");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 3000);
}

const EVENT_OPTIONS = ["풀코스", "하프", "10km", "5km", "3km"];

/* ============================================================
   1. 인증 + 운영진 확인
   ============================================================ */
$("btnGoogle").addEventListener("click", async () => {
  hideAuthError();
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    showAuthError(err);
  }
});

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  try {
    await signInWithEmailAndPassword(auth, $("authEmail").value.trim(), $("authPw").value);
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
    $("deniedName").textContent = user.displayName || user.email || "";
    showView("denied");
    return;
  }

  $("appUser").hidden = false;
  $("userName").textContent = `${user.displayName || user.email} 👑`;
  showView("admin");
  startAdmin();
});

function startAdmin() {
  if (adminStarted) return;
  adminStarted = true;
  loadSiteContent();
  startRecordsListener();
  startGalleryListener();
}

/* ============================================================
   2. 탭 전환
   ============================================================ */
$("adminTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".app-tab");
  if (!btn) return;
  document.querySelectorAll("#adminTabs .app-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  document.querySelectorAll("#viewAdmin .tab-panel").forEach((p) =>
    p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
});

/* ============================================================
   3. 소개 문구 (site/content 문서)
   ============================================================ */
const contentRef = doc(db, "site", "content");

/* site-data.js 의 값을 기본값으로 사용 */
let siteData = { ...SITE };
let statsData = STATS.map((s) => ({ ...s }));
let valuesData = VALUES.map((v) => ({ ...v }));
let scheduleData = SCHEDULE.map((s) => ({ ...s }));

async function loadSiteContent() {
  try {
    const snap = await getDoc(contentRef);
    if (snap.exists()) {
      const d = snap.data();
      if (d.site) Object.assign(siteData, d.site);
      if (Array.isArray(d.stats) && d.stats.length) statsData = d.stats;
      if (Array.isArray(d.values) && d.values.length) valuesData = d.values;
      if (Array.isArray(d.schedule) && d.schedule.length) scheduleData = d.schedule;
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
}

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

/* ----- 행 추가 / 삭제 ----- */
document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.add;
    const target = { stat: "statRows", value: "valueRows", schedule: "scheduleRows" }[kind];
    const html = { stat: statRowHtml, value: valueRowHtml, schedule: scheduleRowHtml }[kind]();
    $(target).insertAdjacentHTML("beforeend", html);
  });
});

$("tab-content").addEventListener("click", (e) => {
  const del = e.target.closest(".row-del");
  if (del) del.closest(".dyn-row").remove();
});

/* ----- 저장 ----- */
$("formSite").addEventListener("submit", async (e) => {
  e.preventDefault();
  const site = {
    ...siteData,
    crewName: $("siteCrewName").value.trim(),
    slogan: $("siteSlogan").value.trim(),
    subSlogan: $("siteSubSlogan").value.trim(),
    aboutDesc: $("siteAboutDesc").value.trim(),
    instagram: $("siteInstagram").value.trim().replace(/^@/, ""),
  };
  try {
    await setDoc(contentRef, { site, updatedAt: serverTimestamp() }, { merge: true });
    siteData = site;
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formStats").addEventListener("submit", async (e) => {
  e.preventDefault();
  const stats = [...$("statRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      value: row.querySelector(".f-value").value.trim(),
      label: row.querySelector(".f-label").value.trim(),
    }))
    .filter((s) => s.value && s.label);
  try {
    await setDoc(contentRef, { stats, updatedAt: serverTimestamp() }, { merge: true });
    statsData = stats;
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formValues").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = [...$("valueRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      icon: row.querySelector(".f-icon").value.trim() || "🥕",
      title: row.querySelector(".f-title").value.trim(),
      desc: row.querySelector(".f-desc").value.trim(),
    }))
    .filter((v) => v.title);
  try {
    await setDoc(contentRef, { values, updatedAt: serverTimestamp() }, { merge: true });
    valuesData = values;
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

$("formSchedule").addEventListener("submit", async (e) => {
  e.preventDefault();
  const schedule = [...$("scheduleRows").querySelectorAll(".dyn-row")]
    .map((row) => ({
      day: row.querySelector(".f-day").value.trim(),
      time: row.querySelector(".f-time").value.trim(),
      place: row.querySelector(".f-place").value.trim(),
      course: row.querySelector(".f-course").value.trim(),
      note: row.querySelector(".f-note").value.trim(),
    }))
    .filter((s) => s.day && s.time);
  try {
    await setDoc(contentRef, { schedule, updatedAt: serverTimestamp() }, { merge: true });
    scheduleData = schedule;
    flashSaved(e.target);
  } catch (err) {
    alert("저장에 실패했어요: " + err.message);
  }
});

/* ============================================================
   4. 크루 공식 기록 (records 컬렉션)
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
    const events = Object.keys(groups).sort(
      (a, b) => (EVENT_OPTIONS.indexOf(a) + 99) % 99 - (EVENT_OPTIONS.indexOf(b) + 99) % 99
    );

    const recordsHtml = events.length
      ? events.map((ev) => `
        <div class="rec-group">
          <span class="event-badge">${esc(ev)}</span>
          <ul class="rec-list">
            ${groups[ev].map((r) => `
              <li>
                <span class="rec-name">${esc(r.name)}</span>
                <span class="rec-time">${esc(r.time)}</span>
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
        <input class="f-time" required maxlength="10" placeholder="기록 (3:28:41)" inputmode="numeric" />
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

  const time = form.querySelector(".f-time").value.trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(time)) {
    alert("기록은 45:10 또는 3:28:41 형식으로 입력해 주세요.");
    return;
  }

  const race = races.find((r) => r.id === form.dataset.id);
  if (!race) return;

  try {
    await updateDoc(doc(db, "records", race.id), {
      results: [
        ...(race.results || []),
        {
          name: form.querySelector(".f-name").value.trim(),
          event: form.querySelector(".f-event").value,
          time,
        },
      ],
    });
    form.querySelector(".f-name").value = "";
    form.querySelector(".f-time").value = "";
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

/* ============================================================
   5. 갤러리 (gallery 컬렉션 + photos 하위 컬렉션)
   ============================================================ */
let albums = [];
const photosCache = {};      // albumId → [{id, data}]
const openAlbums = new Set(); // 사진 목록이 펼쳐진 앨범

function startGalleryListener() {
  unsubs.push(onSnapshot(
    collection(db, "gallery"),
    (qs) => {
      albums = qs.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderAlbums();
    },
    (e) => console.error("갤러리 구독 오류:", e)
  ));
}

function renderAlbums() {
  const list = $("albumList");
  if (!albums.length) {
    list.innerHTML = `<p class="empty-note">아직 앨범이 없습니다. 위의 '앨범 만들기'로 시작해 보세요!</p>`;
    return;
  }

  list.innerHTML = albums.map((a) => `
    <article class="app-card album-admin" data-id="${a.id}">
      <div class="app-card-head">
        <div class="album-head-info">
          ${a.cover ? `<img class="album-cover-thumb" src="${a.cover}" alt="" />` : `<span class="album-cover-thumb empty">🥕</span>`}
          <div>
            <h4>${esc(a.name)}</h4>
            <p class="app-card-meta">사진 ${a.photoCount || 0}장</p>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-mini dark" data-action="rename-album" data-id="${a.id}">이름 수정</button>
          <button class="btn-mini danger" data-action="del-album" data-id="${a.id}">앨범 삭제</button>
        </div>
      </div>

      <div class="album-actions">
        <label class="btn-mini leaf upload-label">
          ＋ 사진 추가
          <input type="file" accept="image/*" multiple hidden data-upload="${a.id}" />
        </label>
        <button class="btn-mini dark" data-action="toggle-photos" data-id="${a.id}">
          ${openAlbums.has(a.id) ? "사진 접기" : "사진 보기·삭제"}
        </button>
      </div>
      <p class="upload-status" id="upStatus-${a.id}" hidden></p>
      <div class="photo-grid" id="photoGrid-${a.id}" ${openAlbums.has(a.id) ? "" : "hidden"}></div>
    </article>
  `).join("");

  // 펼쳐져 있던 앨범은 사진 그리드 다시 채우기
  openAlbums.forEach((id) => {
    if (photosCache[id]) renderPhotoGrid(id);
  });
}

function renderPhotoGrid(albumId) {
  const grid = $(`photoGrid-${albumId}`);
  if (!grid) return;
  const photos = photosCache[albumId] || [];
  grid.innerHTML = photos.length
    ? photos.map((p) => `
        <div class="photo-cell">
          <img src="${p.data}" alt="" loading="lazy" />
          <button type="button" class="photo-del" data-action="del-photo" data-album="${albumId}" data-photo="${p.id}" aria-label="사진 삭제">✕</button>
        </div>`).join("")
    : `<p class="empty-note">아직 사진이 없어요.</p>`;
}

async function fetchPhotos(albumId) {
  const qs = await getDocs(
    query(collection(db, "gallery", albumId, "photos"), orderBy("createdAt", "asc"))
  );
  photosCache[albumId] = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
  return photosCache[albumId];
}

/* 사진 수/커버 최신화 (업로드·삭제 후) */
async function syncAlbumMeta(albumId) {
  const photos = photosCache[albumId] || [];
  let cover = "";
  if (photos.length) {
    try {
      cover = await thumbFromDataUrl(photos[0].data);
    } catch (err) {
      console.warn("커버 생성 실패:", err);
    }
  }
  await updateDoc(doc(db, "gallery", albumId), {
    photoCount: photos.length,
    cover,
    updatedAt: serverTimestamp(),
  });
}

/* 앨범 만들기 */
$("albumForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "gallery"), {
      name: $("albumName").value.trim(),
      photoCount: 0,
      cover: "",
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    e.target.closest("details").open = false;
  } catch (err) {
    alert("앨범 만들기에 실패했어요: " + err.message);
  }
});

/* 앨범 버튼들 */
$("albumList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action } = btn.dataset;

  try {
    if (action === "toggle-photos") {
      const id = btn.dataset.id;
      const grid = $(`photoGrid-${id}`);
      if (openAlbums.has(id)) {
        openAlbums.delete(id);
        grid.hidden = true;
        btn.textContent = "사진 보기·삭제";
      } else {
        openAlbums.add(id);
        grid.hidden = false;
        btn.textContent = "사진 접기";
        if (!photosCache[id]) {
          grid.innerHTML = `<p class="empty-note">사진 불러오는 중...</p>`;
          await fetchPhotos(id);
        }
        renderPhotoGrid(id);
      }
    } else if (action === "rename-album") {
      const album = albums.find((a) => a.id === btn.dataset.id);
      const name = prompt("앨범 이름 수정:", album ? album.name : "");
      if (name && name.trim()) {
        await updateDoc(doc(db, "gallery", btn.dataset.id), { name: name.trim() });
      }
    } else if (action === "del-album") {
      const album = albums.find((a) => a.id === btn.dataset.id);
      if (!album) return;
      if (!confirm(`'${album.name}' 앨범과 사진 ${album.photoCount || 0}장을 모두 삭제할까요?`)) return;
      const photos = photosCache[album.id] || (await fetchPhotos(album.id));
      for (const p of photos) {
        await deleteDoc(doc(db, "gallery", album.id, "photos", p.id));
      }
      delete photosCache[album.id];
      openAlbums.delete(album.id);
      await deleteDoc(doc(db, "gallery", album.id));
    } else if (action === "del-photo") {
      if (!confirm("이 사진을 삭제할까요?")) return;
      const albumId = btn.dataset.album;
      await deleteDoc(doc(db, "gallery", albumId, "photos", btn.dataset.photo));
      photosCache[albumId] = (photosCache[albumId] || []).filter((p) => p.id !== btn.dataset.photo);
      renderPhotoGrid(albumId);
      await syncAlbumMeta(albumId);
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});

/* 사진 업로드 */
$("albumList").addEventListener("change", async (e) => {
  const input = e.target.closest("[data-upload]");
  if (!input || !input.files.length) return;

  const albumId = input.dataset.upload;
  const files = [...input.files];
  input.value = "";

  // 스냅샷 갱신으로 카드가 다시 그려져도 상태 표시가 유지되도록 매번 다시 찾음
  const setStatus = (text, hide = false) => {
    const el = $(`upStatus-${albumId}`);
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    clearTimeout(el._t);
    if (hide) el._t = setTimeout(() => (el.hidden = true), 4000);
  };

  let done = 0;
  const failed = [];

  if (!photosCache[albumId]) {
    try {
      await fetchPhotos(albumId);
    } catch (err) {
      console.warn("사진 목록 로드 실패:", err);
      photosCache[albumId] = [];
    }
  }

  for (const file of files) {
    setStatus(`사진 올리는 중... (${done + 1}/${files.length})`);
    try {
      const data = await compressFile(file, 1400, 850000);
      const ref = await addDoc(collection(db, "gallery", albumId, "photos"), {
        data,
        createdAt: serverTimestamp(),
      });
      photosCache[albumId].push({ id: ref.id, data });
      done++;
    } catch (err) {
      console.error("사진 업로드 실패:", file.name, err);
      failed.push(file.name);
    }
  }

  try {
    await syncAlbumMeta(albumId);
  } catch (err) {
    console.error("앨범 정보 갱신 실패:", err);
  }

  if (openAlbums.has(albumId)) renderPhotoGrid(albumId);

  setStatus(
    failed.length
      ? `⚠️ ${done}장 완료, ${failed.length}장 실패 (${failed.join(", ")})`
      : `✅ 사진 ${done}장을 올렸어요!`,
    true
  );
});

/* ============================================================
   6. 이미지 압축 (Firestore 문서 1MB 제한에 맞춤)
   ============================================================ */
async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("이미지를 열 수 없어요"));
      };
      img.src = url;
    });
  }
}

function drawScaled(src, maxDim) {
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // 투명 PNG → JPEG 변환 시 검은 배경 방지
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* 파일 → 리사이즈 + 품질을 낮춰가며 maxChars 이하의 dataURL 로 */
async function compressFile(file, maxDim, maxChars) {
  const bmp = await loadBitmap(file);
  let dim = maxDim;

  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = drawScaled(bmp, dim);
    let q = 0.82;
    let url = canvas.toDataURL("image/jpeg", q);
    while (url.length > maxChars && q > 0.45) {
      q -= 0.08;
      url = canvas.toDataURL("image/jpeg", q);
    }
    if (url.length <= maxChars) return url;
    dim = Math.round(dim * 0.72); // 그래도 크면 크기를 더 줄여서 재시도
  }
  throw new Error("사진 용량을 충분히 줄이지 못했어요");
}

/* 앨범 커버용 작은 썸네일 */
function thumbFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = drawScaled(img, 480);
      resolve(canvas.toDataURL("image/jpeg", 0.62));
    };
    img.onerror = () => reject(new Error("썸네일 생성 실패"));
    img.src = dataUrl;
  });
}
