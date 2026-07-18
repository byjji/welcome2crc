/* ============================================================
   pages/app/gallery.js — 갤러리 탭 (앨범 + 사진)
   ------------------------------------------------------------
   · 앨범 목록 ↔ 앨범 보기(사진 그리드) 화면 전환
   · 업로드: 사진을 고르면 먼저 '미리보기'에서 확인/빼기 후 [올리기]
     → 브라우저가 자동으로 썸네일(400px)·디스플레이(1600px) WebP 를
     만들어 3종 업로드 (JPEG·PNG 원본은 그대로 보존, HEIC 등만 고화질 JPEG 변환)
   · 라이트박스: 디스플레이 보기 + 원본 다운로드(60일) + 삭제
   · 데이터: albums/{id} + albums/{id}/photos/{pid} (Firestore)
     파일:   gallery/live/{albumId}/{pid}/thumb·display  → 감상용, 영구 보관
             gallery/expiring/{albumId}/{pid}/original     → 원본
     — 감상용(live)은 영구, 원본(expiring)만 업로드 60일 뒤 수명주기 자동 삭제
   ============================================================ */
import { $, openModal, closeModal } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
import { esc, todayStr, parseDateParts, catColor, catBadgeStyle } from "../../lib/format.js";
import {
  db, collection, doc, setDoc, updateDoc, deleteDoc, deleteField,
  onSnapshot, query, orderBy, serverTimestamp, increment,
} from "../../lib/firebase.js";
import { state, me, myProfile, isAdmin } from "./state.js";
import { switchTab } from "./init.js";

export const MAX_PHOTOS = 20;   // 앨범당 최대 장수
const KEEP_DAYS = 60;           // 원본 보관 기간(일) — Storage 수명주기 규칙과 동일하게
const THUMB_PX = 400;           // 그리드 썸네일 (긴 변)
const DISPLAY_PX = 1600;        // 풀스크린 보기 (긴 변)
const REENCODE_MAX_PX = 4096;   // HEIC→JPEG 변환 시 상한 (모바일 캔버스 한계 보호)
const ORIGINAL_MAX_MB = 30;     // storage.rules 의 원본 크기 제한과 동일

/* ---------- 화면 상태 ---------- */
let openId = null;       // 열려 있는 앨범 id (null = 앨범 목록)
let photos = [];         // 열린 앨범의 사진 (createdAt 순)
let photosUnsub = null;
let lbIndex = -1;        // 라이트박스에서 보고 있는 사진 index
let uploading = false;
let staged = [];         // 업로드 전 미리보기에 올려둔 파일 [{ file, url }]
let galCat = null;       // 앨범 목록에서 선택한 카테고리 책갈피 (null = 첫 탭 자동)
let cameFromEvents = false; // 일정 카드에서 앨범을 열었는지 (뒤로가기 시 일정으로 복귀)
const UNCAT = "기타";    // 카테고리 없는(옛) 앨범이 모이는 탭 이름

const album = () => (openId ? state.albums.find((a) => a.id === openId) : null);

/* 로그아웃/계정 전환 시 초기화 (init.js cleanupAll 이 호출) */
export function resetGallery() {
  if (photosUnsub) { photosUnsub(); photosUnsub = null; }
  openId = null;
  photos = [];
  lbIndex = -1;
  uploading = false;
  galCat = null;
  cameFromEvents = false;
  clearStaged();
  const lb = $("lightbox");
  if (lb && !lb.hidden) closeModal("lightbox");
  const gp = $("galPreview");
  if (gp && !gp.hidden) closeModal("galPreview");
  if ($("galProgress")) $("galProgress").hidden = true;
}

/* ============================================================
   렌더링 — 앨범 목록 / 앨범 보기
   ============================================================ */
export function renderGallery() {
  if (!$("galAlbums")) return;

  // 열려 있던 앨범이 삭제되면 목록으로 복귀
  if (openId && state.albumsLoaded && !album()) closeAlbumView();

  const open = !!openId;
  $("galAlbums").hidden = open;
  $("galAlbum").hidden = !open;

  if (open) {
    renderAlbumView();
    if (!$("lightbox").hidden) renderLightbox(); // 열린 사진 정보도 최신으로
  } else {
    renderAlbumList();
  }
}

function albumDateLabel(a) {
  if (!a.date) return "";
  const dp = parseDateParts(a.date);
  return `${dp.month} ${dp.day}일 (${dp.dow.charAt(0)})`;
}

/* 앨범 만들기 폼의 카테고리 선택지 (일정 카테고리와 연동)
   forceSel: 특정 카테고리로 고정 / locked: 일정 연결로 자동 설정돼 편집 잠금 */
function renderAlbumCatPicker(forceSel = null, locked = false) {
  const row = $("albumCatRow");
  if (!row) return;
  const sel = forceSel || row.querySelector("input:checked")?.value || state.eventCats[0] || "";
  const list = sel && !state.eventCats.includes(sel) ? [...state.eventCats, sel] : state.eventCats;
  row.classList.toggle("is-locked", locked);
  row.innerHTML = list.map((c) => {
    const cc = catColor(c);
    return `
    <label class="radio-pill cat-pill" style="${catBadgeStyle(c)};border-color:${cc};--cat:${cc}">
      <input type="radio" name="albumCat" value="${esc(c)}" required${c === sel ? " checked" : ""}${locked ? " disabled" : ""} />
      <span>${esc(c)}</span>
    </label>`;
  }).join("");
}

/* 앨범 만들기 폼: 아직 앨범이 없는 일정을 고를 수 있는 드롭다운 (선택 유지) */
function renderAlbumEventOptions() {
  const sel = $("albumEvent");
  if (!sel) return;
  const keep = sel.value;
  const avail = state.events
    .filter((ev) => !(ev.albumId && state.albums.some((a) => a.id === ev.albumId)))
    .slice()
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")); // 최근 날짜 먼저
  sel.innerHTML = `<option value="">일정 없이 직접 입력</option>` +
    avail.map((ev) => {
      const dp = ev.date ? parseDateParts(ev.date) : null;
      const d = dp ? `${dp.month} ${dp.day}일 · ` : "";
      const cat = ev.category ? ` (${esc(ev.category)})` : "";
      return `<option value="${ev.id}">${d}${esc(ev.title)}${cat}</option>`;
    }).join("");
  sel.value = keep && avail.some((ev) => ev.id === keep) ? keep : "";
}

/* 선택한 일정에 맞춰 날짜·카테고리를 자동 채우고 잠금 (없으면 편집 가능) */
function syncAlbumFormFromEvent() {
  const sel = $("albumEvent");
  const dateInput = $("albumDate");
  if (!sel || !dateInput) return;
  const ev = sel.value ? state.events.find((e) => e.id === sel.value) : null;
  if (ev) {
    dateInput.value = ev.date || "";
    dateInput.disabled = true;
    if (!$("albumTitle").value.trim()) $("albumTitle").value = ev.title || "";
    renderAlbumCatPicker(ev.category, true);
  } else {
    dateInput.disabled = false;
    if (!dateInput.value) dateInput.value = todayStr();
    renderAlbumCatPicker(null, false);
  }
}

/* 앨범이 실제로 존재하는 카테고리만 (일정 카테고리 순서 우선, 미분류는 맨 끝) */
function albumCategories() {
  const present = new Set(state.albums.map((a) => a.category || UNCAT));
  const ordered = state.eventCats.filter((c) => present.has(c));
  for (const c of present) {                     // 삭제된 카테고리로 만든 앨범 등
    if (c !== UNCAT && !ordered.includes(c)) ordered.push(c);
  }
  if (present.has(UNCAT)) ordered.push(UNCAT);   // 카테고리 없는 옛 앨범
  return ordered;
}

function renderAlbumList() {
  renderAlbumEventOptions();   // 일정 드롭다운 갱신
  syncAlbumFormFromEvent();    // 선택된 일정에 맞춰 날짜·카테고리 채움(없으면 편집 가능)

  const grid = $("albumGrid");
  const tabs = $("galCatTabs");
  if (!state.albumsLoaded) {
    tabs.innerHTML = "";
    grid.innerHTML = `<p class="empty-note">앨범을 불러오는 중...</p>`;
    return;
  }
  if (!state.albums.length) {
    tabs.innerHTML = "";
    grid.innerHTML = `<p class="empty-note">아직 앨범이 없어요. 일정 카드의 ${ic("camera")} 버튼으로 첫 앨범을 만들어 보세요!</p>`;
    return;
  }

  // 카테고리 책갈피 탭 — 앨범이 있는 카테고리만 노출
  const cats = albumCategories();
  if (!cats.includes(galCat)) galCat = cats[0] || null;
  tabs.innerHTML = cats.map((c) => {
    const cc = c === UNCAT ? "var(--ink-soft)" : catColor(c);
    return `<button type="button" class="gal-cat${c === galCat ? " active" : ""}" data-gal-cat="${esc(c)}" style="--cat:${cc}">${esc(c)}</button>`;
  }).join("");

  const shown = state.albums.filter((a) => (a.category || UNCAT) === galCat);
  grid.innerHTML = shown.map((a) => {
    const cover = a.coverUrl
      ? `<img class="al-cover" src="${esc(a.coverUrl)}" loading="lazy" alt="" />`
      : `<div class="al-cover al-empty">${ic("photo")}</div>`;
    return `
    <button type="button" class="album-card" data-open-album="${a.id}">
      <span class="al-cover-wrap">
        ${cover}
        <span class="al-count">${a.photoCount || 0}장</span>
      </span>
      <span class="al-meta">
        <strong class="al-title">${esc(a.title)}</strong>
        <span class="al-date">${albumDateLabel(a)}</span>
      </span>
    </button>`;
  }).join("");
}

function renderAlbumView() {
  const a = album();
  if (!a) return;

  const cnt = a.photoCount || 0;
  const full = cnt >= MAX_PHOTOS;

  $("galAlbumHead").innerHTML = `
  <div class="gal-head">
    <button type="button" class="gal-back" id="galBack">‹ 앨범</button>
    <div class="gal-title-wrap">
      <h3 class="gal-title">${esc(a.title)}</h3>
      <p class="gal-sub">${albumDateLabel(a)} · ${cnt}/${MAX_PHOTOS}장</p>
    </div>
    ${isAdmin ? `<button type="button" class="btn-mini btn-icon btn-x" id="galDelAlbum" title="앨범 삭제" aria-label="앨범 삭제">✕</button>` : ""}
  </div>
  <div class="gal-tools">
    <button type="button" class="btn-mini leaf" id="btnGalUpload"${full || uploading ? " disabled" : ""}>${ic("camera")} 사진 올리기</button>
    <span class="muted">${full ? "이 앨범은 가득 찼어요 (최대 " + MAX_PHOTOS + "장)" : "사진을 고르면 미리보기에서 확인한 뒤 올려요"}</span>
  </div>`;

  $("galGrid").innerHTML = photos.length
    ? photos.map((p, i) =>
        `<button type="button" class="ph" data-ph="${i}"><img src="${esc(p.thumbUrl)}" loading="lazy" alt="" /></button>`).join("")
    : `<p class="empty-note">아직 사진이 없어요. 첫 사진을 올려보세요!</p>`;

  const hint = $("galHint");
  hint.hidden = false;
  hint.textContent = "보기용 사진은 계속 남고, 원본 파일만 60일 뒤 자동 정리돼요. (원본 다운로드는 그 전까지)";
}

/* ============================================================
   앨범 열기/닫기 · 일정 카드에서 진입 (B안: 없으면 그 자리에서 생성)
   ============================================================ */
export function openAlbum(id, { pickAfter = false } = {}) {
  if (photosUnsub) photosUnsub();
  openId = id;
  photos = [];
  lbIndex = -1;

  photosUnsub = onSnapshot(
    query(collection(db, "albums", id, "photos"), orderBy("createdAt", "asc")),
    (qs) => {
      photos = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (openId === id) renderGallery();
    },
    (e) => console.error("사진 구독 오류:", e)
  );

  renderGallery();
  window.scrollTo(0, 0);
  if (pickAfter) setTimeout(() => $("galFile").click(), 60); // 브라우저가 막으면 버튼으로
}

function closeAlbumView() {
  if (photosUnsub) { photosUnsub(); photosUnsub = null; }
  openId = null;
  photos = [];
  lbIndex = -1;
}

/* 일정 카드의 사진 버튼 → 앨범 열기 (없으면 만들고 바로 올리기) */
export async function openEventAlbum(ev) {
  let id = ev.albumId && state.albums.some((a) => a.id === ev.albumId) ? ev.albumId : null;
  let created = false;

  if (!id) {
    const ref = doc(collection(db, "albums"));
    await setDoc(ref, {
      title: ev.title,
      date: ev.date,
      category: ev.category || UNCAT, // 일정 카테고리를 그대로 이어받아 올바른 탭에 생성
      eventId: ev.id,
      photoCount: 0,
      coverUrl: "",
      createdBy: me.uid,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "events", ev.id), { albumId: ref.id });
    id = ref.id;
    created = true;
  }

  galCat = ev.category || UNCAT; // 뒤로 나갔을 때 이 앨범이 있는 탭이 보이도록
  cameFromEvents = true;         // 뒤로가기 시 일정 화면으로 복귀
  switchTab("gallery");
  openAlbum(id, { pickAfter: created });
}

/* ============================================================
   앨범 만들기 (갤러리 탭 — 운영진)
   · 일정을 고르면: 날짜·카테고리 자동 설정 + 그 일정의 앨범으로 연결
   · 일정 없이: 날짜·카테고리 직접 입력한 단독 앨범
   ============================================================ */
$("albumEvent").addEventListener("change", syncAlbumFormFromEvent);

// 폼을 펼칠 때 일정 목록을 최신으로 (일정 구독은 갤러리를 다시 그리지 않으므로)
$("albumAdmin").addEventListener("toggle", () => {
  if ($("albumAdmin").open) { renderAlbumEventOptions(); syncAlbumFormFromEvent(); }
});

$("albumForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  // 일정을 골랐으면 그 일정의 카테고리·날짜를 그대로 쓰고, 앨범을 일정에 연결
  const evId = $("albumEvent").value;
  const ev = evId ? state.events.find((x) => x.id === evId) : null;
  const category = ev ? ev.category : document.querySelector('input[name="albumCat"]:checked')?.value;
  if (!category) return alert("카테고리를 선택해 주세요.");
  try {
    const ref = doc(collection(db, "albums"));
    const data = {
      title: $("albumTitle").value.trim(),
      date: ev ? (ev.date || "") : $("albumDate").value,
      category,
      photoCount: 0,
      coverUrl: "",
      createdBy: me.uid,
      createdAt: serverTimestamp(),
    };
    if (ev) data.eventId = ev.id;
    await setDoc(ref, data);
    if (ev) await updateDoc(doc(db, "events", ev.id), { albumId: ref.id }); // 일정 카드에도 앨범 연결
    galCat = category; // 만든 앨범이 있는 탭으로
    e.target.reset();
    $("albumDate").disabled = false; // reset 후 잠금 해제
    $("albumAdmin").open = false;
    openAlbum(ref.id);
  } catch (err) {
    alert("앨범 만들기에 실패했어요: " + err.message);
  }
});

/* ============================================================
   업로드 — 브라우저에서 리사이즈·WebP 변환 후 3종 업로드
   ============================================================ */
/* 이미지 파일 디코딩 (HEIC 등 못 읽는 파일은 오류) */
async function decodeImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지를 읽을 수 없어요")); };
      img.src = url;
    });
  }
}

function srcSize(src) {
  return { w: src.width || src.naturalWidth, h: src.height || src.naturalHeight };
}

/* 긴 변 maxSide 이하로 축소해 캔버스에 그림 (총 화소도 함께 제한) */
function drawScaled(src, maxSide) {
  const { w, h } = srcSize(src);
  let scale = Math.min(1, maxSide / Math.max(w, h));
  const MAX_AREA = 16000000; // 모바일 캔버스 한계(약 16MP) 보호
  if (w * scale * h * scale > MAX_AREA) scale = Math.sqrt(MAX_AREA / (w * h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext("2d").drawImage(src, 0, 0, cw, ch);
  return canvas;
}

const canvasBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

/* WebP 인코딩 (미지원 브라우저는 JPEG 로 대체) */
async function encode(src, maxSide, quality, type = "image/webp") {
  const canvas = drawScaled(src, maxSide);
  let blob = await canvasBlob(canvas, type, quality);
  if (!blob || (type === "image/webp" && blob.type !== "image/webp")) {
    blob = await canvasBlob(canvas, "image/jpeg", quality);
  }
  if (!blob) throw new Error("이미지 변환에 실패했어요");
  return blob;
}

const PASSTHROUGH_RE = /^image\/(jpeg|png|webp|gif)$/; // 그대로 저장하는 원본 포맷
const extOf = (type) =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[type] || "jpg");

async function uploadOne(st, file, a, photoRef) {
  const bitmap = await decodeImage(file);

  const thumb = await encode(bitmap, THUMB_PX, 0.72);
  const display = await encode(bitmap, DISPLAY_PX, 0.8);

  // 원본: JPEG·PNG·WebP·GIF 는 손대지 않고 그대로 (화질·EXIF 보존),
  // HEIC 등 브라우저·타기기 호환이 안 되는 포맷만 고화질 JPEG 로 변환
  let original = file;
  if (!PASSTHROUGH_RE.test(file.type)) {
    original = await encode(bitmap, REENCODE_MAX_PX, 0.92, "image/jpeg");
  }
  if (bitmap.close) bitmap.close();
  if (original.size > ORIGINAL_MAX_MB * 1024 * 1024) {
    throw new Error(`파일이 너무 커요 (최대 ${ORIGINAL_MAX_MB}MB)`);
  }

  // 하이브리드 저장:
  //  · 썸네일·디스플레이(감상용) → gallery/live/… (수명주기 삭제 대상 아님, 영구)
  //  · 원본 → gallery/expiring/… (업로드 60일 뒤 수명주기 자동 삭제)
  const thumbPath = `gallery/live/${a.id}/${photoRef.id}/thumb`;
  const displayPath = `gallery/live/${a.id}/${photoRef.id}/display`;
  const originalPath = `gallery/expiring/${a.id}/${photoRef.id}/original`;
  const meta = (blob, extra = {}) => ({
    contentType: blob.type || "image/jpeg",
    cacheControl: "public,max-age=31536000,immutable", // 재방문 시 재다운로드 없음 (전송량 절감)
    customMetadata: { uploaderUid: me.uid },
    ...extra,
  });
  const ext = extOf(original.type);

  const [tRef, dRef, oRef] = [thumbPath, displayPath, originalPath]
    .map((p) => st.sref(st.storage, p));
  await Promise.all([
    st.uploadBytes(tRef, thumb, meta(thumb)),
    st.uploadBytes(dRef, display, meta(display)),
    st.uploadBytes(oRef, original, meta(original, {
      contentDisposition: `attachment; filename="crc_${photoRef.id}.${ext}"`, // 링크 클릭 = 바로 다운로드
    })),
  ]);
  const [thumbUrl, displayUrl, originalUrl] = await Promise.all(
    [tRef, dRef, oRef].map((r) => st.getDownloadURL(r)));

  await setDoc(photoRef, {
    thumbUrl, displayUrl, originalUrl,
    thumbPath, displayPath, originalPath,
    uploaderUid: me.uid,
    uploaderName: myProfile.name || "?",
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "albums", a.id), {
    photoCount: increment(1),
    coverUrl: thumbUrl, // 최근 사진이 앨범 표지
    updatedAt: serverTimestamp(),
  });
}

async function uploadFiles(fileList) {
  const a = album();
  if (!a || uploading || !me) return;

  const left = MAX_PHOTOS - (a.photoCount || 0);
  if (left <= 0) return alert(`앨범당 최대 ${MAX_PHOTOS}장까지 올릴 수 있어요.`);
  let files = [...fileList];
  if (files.length > left) {
    alert(`앨범당 최대 ${MAX_PHOTOS}장이라 앞의 ${left}장만 올려요.`);
    files = files.slice(0, left);
  }

  uploading = true;
  renderAlbumView(); // 업로드 버튼 잠금
  const prog = $("galProgress");
  prog.hidden = false;

  const failed = [];
  try {
    const st = await import("../../lib/storage.js"); // Storage SDK 는 이때만 로드
    for (let i = 0; i < files.length; i++) {
      $("galProgressText").textContent = `${i + 1}/${files.length} 올리는 중...`;
      $("galProgressBar").style.width = `${Math.round((i / files.length) * 100)}%`;
      try {
        const photoRef = doc(collection(db, "albums", a.id, "photos"));
        await uploadOne(st, files[i], a, photoRef);
      } catch (err) {
        console.error("사진 업로드 실패:", files[i].name, err);
        // 원인(err.code/message)까지 화면에 보여줘야 진짜 이유를 알 수 있음
        failed.push(`${files[i].name} — ${err.code || err.message || err}`);
      }
    }
    $("galProgressBar").style.width = "100%";
  } catch (err) {
    console.error("업로드 시작 실패:", err);
    alert("업로드를 시작하지 못했어요: " + (err.code || err.message || err));
  } finally {
    uploading = false;
    prog.hidden = true;
    $("galProgressBar").style.width = "0%";
    renderGallery();
    if (failed.length) alert(`${failed.length}장은 올리지 못했어요:\n${failed.join("\n")}`);
  }
}

/* ============================================================
   업로드 전 미리보기 — 고른 사진 확인·빼기 후 [올리기]
   ============================================================ */
function remainingSlots() {
  const a = album();
  return a ? Math.max(0, MAX_PHOTOS - (a.photoCount || 0)) : 0;
}

/* 파일 선택(또는 '더 고르기') → 미리보기에 담기 */
function stageFiles(fileList) {
  const a = album();
  if (!a || uploading) return;
  if ($("galPreview").hidden) clearStaged(); // 새 세션이면 이전 잔여분 정리

  const left = remainingSlots();
  if (left <= 0) return alert(`앨범당 최대 ${MAX_PHOTOS}장까지 올릴 수 있어요.`);

  let over = false;
  for (const file of fileList) {
    if (staged.length >= left) { over = true; break; }
    if (!file.type.startsWith("image/")) continue; // 이미지가 아닌 파일 제외
    staged.push({ file, url: URL.createObjectURL(file) });
  }
  if (!staged.length) return alert("이미지 파일을 골라주세요.");
  if (over) alert(`이 앨범엔 ${left}장까지 올릴 수 있어 나머지는 제외했어요.`);

  renderPreview();
  openModal("galPreview");
}

function renderPreview() {
  const grid = $("galPreviewGrid");
  grid.innerHTML = staged.map((s, i) => `
    <div class="gp-thumb">
      <img src="${s.url}" alt="" />
      <button type="button" class="gp-rm" data-rm="${i}" aria-label="빼기">✕</button>
    </div>`).join("");
  // 미리보기 못 여는 포맷(HEIC 등)은 '미리보기 불가'로 표시 (업로드는 정상)
  grid.querySelectorAll("img").forEach((img) => {
    img.onerror = () => img.closest(".gp-thumb")?.classList.add("gp-noimg");
  });

  $("galPreviewNote").textContent =
    `${staged.length}장 선택됨 · 이 앨범엔 ${remainingSlots()}장까지 올릴 수 있어요`;
  $("galPreviewUpload").textContent = `올리기 (${staged.length}장)`;
}

function removeStaged(i) {
  const [s] = staged.splice(i, 1);
  if (s) URL.revokeObjectURL(s.url);
  if (!staged.length) return cancelStaging(); // 다 빼면 미리보기 닫기
  renderPreview();
}

function clearStaged() {
  staged.forEach((s) => URL.revokeObjectURL(s.url));
  staged = [];
}

function cancelStaging() {
  clearStaged();
  if (!$("galPreview").hidden) closeModal("galPreview");
}

function confirmStaging() {
  if (!staged.length || uploading) return;
  const files = staged.map((s) => s.file);
  clearStaged();
  closeModal("galPreview");
  uploadFiles(files);
}

$("galFile").addEventListener("change", (e) => {
  if (e.target.files && e.target.files.length) stageFiles(e.target.files);
  e.target.value = ""; // 같은 사진을 다시 골라도 change 가 뜨도록
});

$("galPreview").addEventListener("click", (e) => {
  if (e.target === e.currentTarget || e.target.closest("[data-close-preview]")) return cancelStaging();
  const rm = e.target.closest("[data-rm]");
  if (rm) removeStaged(Number(rm.dataset.rm));
});
$("galPreviewAdd").addEventListener("click", () => $("galFile").click());
$("galPreviewUpload").addEventListener("click", confirmStaging);

/* ============================================================
   삭제 — 사진(본인·운영진) / 앨범(운영진)
   ============================================================ */
async function removePhotoFiles(st, p) {
  const paths = [p.thumbPath, p.displayPath, p.originalPath].filter(Boolean);
  // 원본은 수명주기 규칙이 먼저 지웠을 수 있으므로 실패해도 계속
  await Promise.all(paths.map((path) => st.deleteObject(st.sref(st.storage, path)).catch(() => null)));
}

async function deletePhoto(p) {
  if (!confirm("이 사진을 삭제할까요?")) return;
  try {
    const st = await import("../../lib/storage.js");
    await removePhotoFiles(st, p);
    await deleteDoc(doc(db, "albums", openId, "photos", p.id));

    const a = album();
    const patch = { photoCount: increment(-1), updatedAt: serverTimestamp() };
    if (a && a.coverUrl === p.thumbUrl) {
      const rest = photos.filter((x) => x.id !== p.id);
      patch.coverUrl = rest.length ? rest[rest.length - 1].thumbUrl : "";
    }
    await updateDoc(doc(db, "albums", openId), patch);
    closeModal("lightbox");
  } catch (err) {
    alert("삭제에 실패했어요: " + err.message);
  }
}

async function deleteAlbum() {
  const a = album();
  if (!a) return;
  if (!confirm(`'${a.title}' 앨범과 사진 ${a.photoCount || 0}장을 모두 삭제할까요?`)) return;
  try {
    const st = await import("../../lib/storage.js");
    for (const p of photos) {
      await removePhotoFiles(st, p);
      await deleteDoc(doc(db, "albums", a.id, "photos", p.id)).catch(() => null);
    }
    if (a.eventId) {
      // 일정 카드의 사진 버튼을 '없음' 상태로 되돌림
      await updateDoc(doc(db, "events", a.eventId), { albumId: deleteField() }).catch(() => null);
    }
    await deleteDoc(doc(db, "albums", a.id));
    closeAlbumView();
    renderGallery();
  } catch (err) {
    alert("앨범 삭제에 실패했어요: " + err.message);
  }
}

/* ============================================================
   라이트박스 — 디스플레이 보기 · 원본 다운로드(60일) · 삭제
   ============================================================ */
function canDownloadOriginal(p) {
  const t = p.createdAt && p.createdAt.toDate ? p.createdAt.toDate().getTime() : Date.now();
  return (Date.now() - t) / 86400000 < KEEP_DAYS;
}

/* 사진 하단 표기: '올린날짜 ~ 원본 삭제 예정일'
   (하이브리드라 감상용은 계속 남고, 이 기간은 원본 다운로드 가능 기간) */
const ymd = (d) => `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
const md = (d) => `${d.getMonth() + 1}. ${d.getDate()}.`;

function photoDateRange(p) {
  const up = p.createdAt && p.createdAt.toDate ? p.createdAt.toDate() : null;
  if (!up) return "";
  const del = new Date(up.getTime() + KEEP_DAYS * 86400000);
  const delStr = del.getFullYear() === up.getFullYear() ? md(del) : ymd(del);
  return `${ymd(up)} ~ ${delStr}`; // 올린날짜 ~ 원본 삭제 예정일
}

function openLightbox(i) {
  lbIndex = i;
  renderLightbox();
  openModal("lightbox");
}

function renderLightbox() {
  const a = album();
  if (lbIndex >= photos.length) lbIndex = photos.length - 1; // 보던 사진이 삭제된 경우
  const p = photos[lbIndex];
  if (!p || !a) {
    if (!$("lightbox").hidden) closeModal("lightbox");
    return;
  }

  $("lbImg").src = p.displayUrl;
  $("lbCounter").textContent = `${lbIndex + 1} / ${photos.length}`;
  const dateStr = photoDateRange(p);
  $("lbInfo").innerHTML = `${esc(p.uploaderName || "?")}${dateStr ? ` · ${dateStr}` : ""}`;

  const canDelete = isAdmin || (me && p.uploaderUid === me.uid);
  const dl = canDownloadOriginal(p)
    ? `<a class="btn-mini dark" href="${esc(p.originalUrl)}" download>${ic("download")} 원본 저장</a>`
    : `<span class="lb-expired">원본 보관 기간(${KEEP_DAYS}일)이 지났어요</span>`;
  $("lbActions").innerHTML = dl +
    (canDelete ? `<button type="button" class="btn-mini danger" id="lbDelete">삭제</button>` : "");

  $("lbPrev").disabled = lbIndex <= 0;
  $("lbNext").disabled = lbIndex >= photos.length - 1;
}

function lbMove(delta) {
  const next = lbIndex + delta;
  if (next < 0 || next >= photos.length) return;
  lbIndex = next;
  renderLightbox();
}

$("lbPrev").addEventListener("click", () => lbMove(-1));
$("lbNext").addEventListener("click", () => lbMove(1));

$("lbActions").addEventListener("click", (e) => {
  if (e.target.closest("#lbDelete")) deletePhoto(photos[lbIndex]);
});

/* 좌우 스와이프로 이전/다음 (라이트박스 안) */
let lbTouchX = null;
$("lbStage").addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) lbTouchX = e.touches[0].clientX;
}, { passive: true });
$("lbStage").addEventListener("touchend", (e) => {
  if (lbTouchX === null) return;
  const dx = e.changedTouches[0].clientX - lbTouchX;
  lbTouchX = null;
  if (Math.abs(dx) > 40) lbMove(dx < 0 ? 1 : -1);
}, { passive: true });

/* 키보드 ←/→ (데스크탑) */
document.addEventListener("keydown", (e) => {
  if ($("lightbox").hidden) return;
  if (e.key === "ArrowLeft") lbMove(-1);
  if (e.key === "ArrowRight") lbMove(1);
});

/* ============================================================
   갤러리 탭 클릭 위임 (앨범 카드 · 뒤로 · 업로드 · 앨범 삭제 · 사진)
   ============================================================ */
$("tab-gallery").addEventListener("click", (e) => {
  const catBtn = e.target.closest("[data-gal-cat]");
  if (catBtn) {
    if (catBtn.dataset.galCat !== galCat) { galCat = catBtn.dataset.galCat; renderAlbumList(); }
    return;
  }

  const openBtn = e.target.closest("[data-open-album]");
  if (openBtn) { cameFromEvents = false; return openAlbum(openBtn.dataset.openAlbum); }

  if (e.target.closest("#galBack")) {
    closeAlbumView();
    renderGallery();
    if (cameFromEvents) { cameFromEvents = false; switchTab("events"); } // 일정에서 왔으면 일정으로 복귀
    return;
  }
  if (e.target.closest("#btnGalUpload")) return $("galFile").click();
  if (e.target.closest("#galDelAlbum")) return deleteAlbum();

  const ph = e.target.closest("[data-ph]");
  if (ph) openLightbox(Number(ph.dataset.ph));
});
