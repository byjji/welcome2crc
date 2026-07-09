/* ============================================================
   크루 공간 (app.html) — Firebase Auth + Firestore
   ------------------------------------------------------------
   기능: 로그인/가입신청 → 운영진 승인 → 공지 / 일정·출석체크 /
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
  updateProfile,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} = await import(`${SDK}/firebase-auth.js`);
const {
  getFirestore, collection, doc,
  getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, increment,
} = await import(`${SDK}/firebase-firestore.js`);

const app = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------- 전역 상태 ---------- */
let me = null;          // 로그인한 auth 유저
let myProfile = null;   // members/{uid} 문서 데이터
let isAdmin = false;

const DEFAULT_EVENT_CATS = ["대회", "정기런", "모임"];
const ATT_CAT = "정기런"; // 출석 현황(출첵)으로 집계되는 카테고리

let state = {
  notices: [],
  events: [],
  polls: [],
  members: [],
  attendance: {},   // eventId → { uid: {name, status} }
  votes: {},        // pollId → { uid: {name, option} }
  eventCats: [...DEFAULT_EVENT_CATS],  // 일정 카테고리 (site/eventCategories)
  mileage: {},      // uid → { name, note(각오), goal(목표km), km(현재km) }
};

let eventCatFilter = "all";  // 일정 목록 카테고리 필터

/* 출석 현황·기록·랭킹 상태 */
let statMonth = null;          // 보고 있는 달 ("2026-07"), 처음 열 때 이번 달로
let monthAtt = {};             // eventId → { uid: 출석 문서 } (지난 일정 캐시)
let monthLoaded = new Set();   // 출석 데이터를 받아온 달
let attDayId = null;           // '출석 현황'에서 칩으로 선택한 정기런

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

/* 일정 카테고리 배지 색 — 기본 카테고리는 고정, 새로 만든 카테고리는 이름 기반 자동 배정
   (러닝·이벤트는 예전 기본값으로 만든 일정을 위해 색만 유지) */
const CAT_COLORS = { "대회": "#d94f2b", "정기런": "#e8871e", "모임": "#2f9e6e", "러닝": "#e8871e", "이벤트": "#7c5cd6" };
const CAT_FALLBACK_COLORS = ["#3a7bd5", "#c4527a", "#5f8f3e", "#b8860b", "#5e6ad2"];

function catColor(cat) {
  if (CAT_COLORS[cat]) return CAT_COLORS[cat];
  let h = 0;
  for (const ch of String(cat)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CAT_FALLBACK_COLORS[h % CAT_FALLBACK_COLORS.length];
}

/* D-day 카드 그라데이션용: 색을 살짝 어둡게 */
function shadeColor(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

/* ---------- 날짜/기록 계산 유틸 ---------- */
function dday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}

function addDaysStr(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function thisMonthKey() { return todayStr().slice(0, 7); }         // "2026-07"

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return `${y}년 ${m}월`;
}

/* "30:00" 또는 "1:05:30" → 초 (형식이 틀리면 null) */
function parseTimeStr(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const sec = m[3] !== undefined
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    : Number(m[1]) * 60 + Number(m[2]);
  return sec > 0 ? sec : null;
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtPace(secPerKm) {
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) { m++; s = 0; }
  return `${m}'${String(s).padStart(2, "0")}"`;
}

function authErrorMsg(err) {
  const code = err && err.code ? err.code : "";
  const map = {
    "auth/invalid-email": "계정 형식이 올바르지 않아요. 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용해 주세요.",
    "auth/user-not-found": "등록되지 않은 계정이에요. 가입 신청을 먼저 해주세요.",
    "auth/wrong-password": "비밀번호가 틀렸어요.",
    "auth/invalid-credential": "계정 또는 비밀번호가 올바르지 않아요.",
    "auth/email-already-in-use": "이미 사용 중인 계정이에요. 다른 계정을 입력해 주세요.",
    "auth/weak-password": "비밀번호는 6자 이상으로 해주세요.",
    "auth/too-many-requests": "시도가 너무 많았어요. 잠시 후 다시 시도해 주세요.",
    "auth/popup-closed-by-user": "로그인 창이 닫혔어요. 다시 시도해 주세요.",
    "auth/network-request-failed": "네트워크 오류예요. 인터넷 연결을 확인해 주세요.",
  };
  return map[code] || `오류가 발생했어요. (${code || err})`;
}

/* ============================================================
   계정(아이디) ↔ 내부 인증 주소 변환
   ------------------------------------------------------------
   Firebase 인증은 이메일 형식을 요구하므로, 아이디 뒤에 내부용
   가짜 도메인(@crc.ulsan)을 자동으로 붙여 저장합니다.
   화면에는 아이디만 보이고, 이메일은 어디에도 쓰이지 않습니다.
   계정은 대소문자를 구분하는데 Firebase 가 대문자를 소문자로
   바꿔 저장하므로, 대문자는 "+소문자" 로 인코딩해 보존합니다.
   (HongGil → +hong+gil@crc.ulsan / "+" 는 계정에 쓸 수 없는 문자)
   (예전에 이메일 형식으로 가입한 계정은 그대로 입력하면 됩니다)
   ============================================================ */
const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;

function toAuthEmail(account) {
  const id = String(account || "").trim();
  if (id.includes("@")) return id.toLowerCase(); // 예전 이메일 계정
  return id.replace(/[A-Z]/g, (c) => "+" + c.toLowerCase()) + "@crc.ulsan";
}

/* 화면 표시용: 내부 도메인을 감추고 대문자 인코딩을 원래대로 복원 */
function displayAccount(email) {
  const m = String(email || "").match(/^(.*)@crc\.(ulsan|local)$/);
  if (!m) return String(email || "");
  return m[1].replace(/\+([a-z])/g, (_, c) => c.toUpperCase());
}

/* ============================================================
   비밀번호 힌트 (질문/답변) — 브라우저 암호화(Web Crypto)로 저장
   ------------------------------------------------------------
   비밀번호를 "답변"을 열쇠로 잠근 암호문(pwSealed)으로 Firestore
   pwhints/{계정} 에 저장합니다. 비밀번호 찾기에서 답변이 맞으면
   복호화 → 그 비밀번호로 본인 확인 → 새 비밀번호를 적용합니다.
   답변은 비밀번호를 열쇠로 잠가(ansSealed) 함께 저장해서,
   비밀번호를 변경할 때 힌트가 자동으로 새 비밀번호로 갱신됩니다.
   ============================================================ */
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/* 답변 비교는 공백만 무시하고 대소문자는 구분합니다 ("나이키 " = "나이키", "Nike" ≠ "nike") */
const normAnswer = (s) => String(s || "").trim().replace(/\s+/g, "");
const hintDocId = (email) => String(email || "").trim().toLowerCase();

async function hintKey(secret, salt) {
  const base = await crypto.subtle.importKey("raw", textEnc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function sealText(plain, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await hintKey(secret, salt);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEnc.encode(plain));
  return { data: toB64(data), salt: toB64(salt), iv: toB64(iv) };
}

async function openSealed(sealed, secret) {
  try {
    const key = await hintKey(secret, fromB64(sealed.salt));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv) }, key, fromB64(sealed.data));
    return textDec.decode(plain);
  } catch {
    return null; // 열쇠(답변 또는 비밀번호)가 맞지 않으면 실패
  }
}

async function savePwHint(uid, email, pw, question, answer) {
  const ans = normAnswer(answer);
  await setDoc(doc(db, "pwhints", hintDocId(email)), {
    uid,
    question,
    pwSealed: await sealText(pw, ans),
    ansSealed: await sealText(ans, pw),
    updatedAt: serverTimestamp(),
  });
}

/* ============================================================
   1. 인증 (로그인 / 가입신청 / 로그아웃)
   ============================================================ */
let authMode = "login"; // 'login' | 'signup'
let signupName = "";
let signupExtra = null; // 가입신청서 추가 정보 → members 문서에 함께 저장

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll(".auth-mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  $("signupRows").hidden = mode !== "signup";
  $("btnEmailSubmit").textContent = mode === "signup" ? "가입 신청하기 🥕" : "로그인";
  $("authPw").setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
  hideAuthError();
}

document.querySelectorAll(".auth-mode").forEach((btn) => {
  btn.addEventListener("click", () => setAuthMode(btn.dataset.mode));
});

// 소개 페이지의 "크루 가입하기" (app.html#signup) 로 들어오면 가입신청 탭을 먼저 보여줌
if (location.hash === "#signup") setAuthMode("signup");

/* 연락처 하이픈 자동 입력 (예: 010-1234-5678) */
$("signupContact").addEventListener("input", (e) => {
  const d = e.target.value.replace(/\D/g, "").slice(0, 11);
  e.target.value =
    d.length <= 3 ? d :
    d.length <= 7 ? `${d.slice(0, 3)}-${d.slice(3)}` :
    d.length <= 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` :
    `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
});

$("emailForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  const account = $("authEmail").value.trim();
  const email = toAuthEmail(account); // 내부 인증용 (아이디@crc.local)
  const pw = $("authPw").value;

  try {
    if (authMode === "signup") {
      signupName = $("authName").value.trim();
      const hintQ = $("signupHintQ").value;
      const hintA = $("signupHintA").value;
      const gender = document.querySelector('input[name="signupGender"]:checked')?.value || "";
      const contact = $("signupContact").value.trim();
      const region = $("signupRegion").value.trim();
      const ageGroup = document.querySelector('input[name="signupAge"]:checked')?.value || "";
      const career = document.querySelector('input[name="signupCareer"]:checked')?.value || "";

      const problem =
        (!account.includes("@") && !ACCOUNT_RE.test(account))
          ? "계정은 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 사용할 수 있어요." :
        !hintQ ? "비밀번호 힌트 질문을 선택해 주세요." :
        !normAnswer(hintA) ? "비밀번호 힌트 답변을 입력해 주세요." :
        !signupName ? "크루에서 쓸 이름을 입력해 주세요." :
        !gender ? "성별을 선택해 주세요." :
        !/^\d{2,3}-\d{3,4}-\d{4}$/.test(contact) ? "연락처를 끝까지 입력해 주세요." :
        !region ? "사는 곳(지역/구)을 입력해 주세요." :
        !ageGroup ? "연령대를 선택해 주세요." :
        !career ? "대회 경력을 선택해 주세요." : "";
      if (problem) {
        showAuthError({ code: "", message: "" }, problem);
        return;
      }

      signupExtra = {
        gender, contact, region, ageGroup, career,
        intro: $("signupIntro").value.trim(),
      };
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      await updateProfile(cred.user, { displayName: signupName });
      try {
        await savePwHint(cred.user.uid, email, pw, hintQ, hintA);
      } catch (err) {
        console.error("비밀번호 힌트 저장 실패 (가입은 완료됨):", err);
      }
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
  } catch (err) {
    showAuthError(err);
    // 중복 계정이면 계정 칸으로 되돌려 다시 입력하게 함
    if (err && err.code === "auth/email-already-in-use") {
      $("authEmail").focus();
      $("authEmail").select();
    }
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

/* ---------- 비밀번호 찾기 (힌트 질문/답변 확인 → 새 비밀번호 설정) ---------- */
let pendingReset = null; // 힌트 확인을 통과한 재설정 정보

$("btnReset").addEventListener("click", () => {
  $("resetForm").reset();
  $("resetEmail").value = $("authEmail").value.trim();
  $("resetMsg").hidden = true;
  openModal("resetModal");
});

$("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = toAuthEmail($("resetEmail").value);
  const question = $("resetQuestion").value;
  const answer = normAnswer($("resetAnswer").value);
  try {
    const snap = await getDoc(doc(db, "pwhints", hintDocId(email)));
    if (!snap.exists()) {
      showFormMsg("resetMsg", "이 계정은 비밀번호 힌트가 등록되어 있지 않아요. 운영진에게 문의해 주세요.", "error");
      return;
    }
    const hint = snap.data();
    // 질문이 다르거나 답변이 틀리면 복호화 실패 → 어떤 항목이 틀렸는지는 알려주지 않음
    const oldPw = hint.question === question ? await openSealed(hint.pwSealed, answer) : null;
    if (!oldPw) {
      showFormMsg("resetMsg", "계정·질문·답변이 맞지 않아요. 다시 확인해 주세요.", "error");
      return;
    }
    pendingReset = { email, oldPw, question, answer };
    closeModal("resetModal");
    $("newPwForm").reset();
    $("newPwMsg").hidden = true;
    openModal("newPwModal");
  } catch (err) {
    showFormMsg("resetMsg", "확인에 실패했어요: " + err.message, "error");
  }
});

$("newPwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingReset) return;
  const pw1 = $("newPw1").value;
  if (pw1 !== $("newPw2").value) {
    showFormMsg("newPwMsg", "새 비밀번호가 서로 달라요.", "error");
    return;
  }
  try {
    // 힌트로 되찾은 기존 비밀번호로 본인 확인(로그인) 후 새 비밀번호 적용
    const cred = await signInWithEmailAndPassword(auth, pendingReset.email, pendingReset.oldPw);
    await updatePassword(cred.user, pw1);
    try {
      await savePwHint(cred.user.uid, pendingReset.email, pw1, pendingReset.question, pendingReset.answer);
    } catch (err) {
      console.error("비밀번호 힌트 갱신 실패:", err);
    }
    pendingReset = null;
    closeModal("newPwModal");
    alert("비밀번호가 변경되었어요! 🥕 그대로 로그인됩니다.");
  } catch (err) {
    showFormMsg("newPwMsg", authErrorMsg(err), "error");
  }
});

/* ---------- 내 정보 수정 (이름 · 비밀번호 · 비밀번호 힌트) ---------- */
$("userName").addEventListener("click", () => {
  if (!me || !myProfile) return;
  $("profileName").value = myProfile.name || "";
  $("nameMsg").hidden = true;
  $("pwMsg").hidden = true;
  $("hintMsg").hidden = true;
  $("pwForm").reset();
  $("hintForm").reset();
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
  const currentPw = $("pwCurrent").value;
  const newPw = $("pwNew").value;
  try {
    // 본인 확인(현재 비밀번호) 후 새 비밀번호 적용
    const cred = EmailAuthProvider.credential(me.email, currentPw);
    await reauthenticateWithCredential(me, cred);
    await updatePassword(me, newPw);
    // 비밀번호 힌트도 새 비밀번호 기준으로 자동 갱신 (기존 답변 재사용)
    try {
      const snap = await getDoc(doc(db, "pwhints", hintDocId(me.email)));
      if (snap.exists()) {
        const hint = snap.data();
        const answer = await openSealed(hint.ansSealed, currentPw);
        if (answer) await savePwHint(me.uid, me.email, newPw, hint.question, answer);
      }
    } catch (err) {
      console.error("비밀번호 힌트 갱신 실패:", err);
    }
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

/* 비밀번호 힌트 등록/변경 (힌트 없이 가입한 기존 계정도 여기서 등록) */
$("hintForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = $("profileHintQ").value;
  const answer = $("profileHintA").value;
  const pw = $("profileHintPw").value;
  if (!question || !normAnswer(answer)) {
    showFormMsg("hintMsg", "질문을 선택하고 답변을 입력해 주세요.", "error");
    return;
  }
  try {
    // 현재 비밀번호로 본인 확인 (힌트에는 이 비밀번호가 잠겨 들어감)
    const cred = EmailAuthProvider.credential(me.email, pw);
    await reauthenticateWithCredential(me, cred);
    await savePwHint(me.uid, me.email, pw, question, answer);
    e.target.reset();
    showFormMsg("hintMsg", "비밀번호 힌트를 저장했어요 ✅ 이제 비밀번호 찾기에서 사용할 수 있어요.", "ok");
  } catch (err) {
    const map = {
      "auth/invalid-credential": "현재 비밀번호가 올바르지 않아요.",
      "auth/wrong-password": "현재 비밀번호가 올바르지 않아요.",
    };
    showFormMsg("hintMsg", map[err.code] || authErrorMsg(err), "error");
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
  state = { notices: [], events: [], polls: [], members: [], attendance: {}, votes: {}, eventCats: [...DEFAULT_EVENT_CATS], mileage: {} };
  eventCatFilter = "all";
  statMonth = null;
  monthAtt = {};
  monthLoaded = new Set();
  attDayId = null;
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
   4. 탭 전환 (하단 고정 탭: 홈 / 일정·출첵 / 소식 / 멤버)
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
  if (btn) switchTab(btn.dataset.tab);
});

/* 홈 화면의 바로가기 (D-day 카드, 공지 배너, '전체 보기' 등) */
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) switchTab(go.dataset.goto);
});

/* 일정·출첵 서브탭: 일정 / 출석 현황 / 일정별 기록 / 이달의 랭킹 */
$("eventSubTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".sub-tab");
  if (!btn) return;
  document.querySelectorAll("#eventSubTabs .sub-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  document.querySelectorAll("#tab-events > .sub-panel").forEach((p) =>
    p.classList.toggle("active", p.id === btn.dataset.subtab));
  if (btn.dataset.subtab === "ev-att" || btn.dataset.subtab === "ev-rank") ensureMonthData();
  if (btn.dataset.subtab === "ev-rec") renderMileage();
});

/* 소식 필터: 전체 / 공지 / 투표 */
$("newsFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".sub-tab");
  if (!btn) return;
  document.querySelectorAll("#newsFilter .sub-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  const f = btn.dataset.news;
  $("newsNotices").hidden = f === "poll";
  $("newsPolls").hidden = f === "notice";
});

/* 출석 현황·랭킹 공용 월 이동 */
$("tab-events").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mnav]");
  if (!btn) return;
  statMonth = shiftMonth(statMonth || thisMonthKey(), Number(btn.dataset.mnav));
  ensureMonthData();
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

  // 재렌더링(실시간 갱신) 후에도 펼쳐둔 공지는 그대로 유지
  const openIds = new Set(
    [...list.querySelectorAll("details[open]")].map((d) => d.dataset.id)
  );

  // 고정 | 제목 | 날짜 한 줄 → 누르면 펼쳐서 내용 확인
  list.innerHTML = sorted.map((n) => `
    <details class="app-card notice-row" data-id="${n.id}"${openIds.has(n.id) ? " open" : ""}>
      <summary>
        <span class="notice-pin">${n.pinned ? "📌" : ""}</span>
        <span class="notice-title">${esc(n.title)}</span>
        <span class="notice-date">${fmtDate(n.createdAt)}</span>
        <span class="notice-arrow" aria-hidden="true">▾</span>
      </summary>
      <div class="notice-tools">
        <span class="app-card-meta">${esc(n.author || "")}${n.updatedAt ? " · (수정됨)" : ""}</span>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="pin-notice" data-id="${n.id}" data-pinned="${!!n.pinned}">${n.pinned ? "고정 해제" : "고정"}</button>
          <button class="btn-mini dark" data-action="edit-notice" data-id="${n.id}">수정</button>
          <button class="btn-mini danger" data-action="del-notice" data-id="${n.id}">삭제</button>
        </div>` : ""}
      </div>
      <div class="notice-body">${esc(n.body)}</div>
    </details>
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
/* ---------- 일정 카테고리 (site/eventCategories 문서에 저장) ---------- */
function catPillsHtml(name, selected) {
  // 이미 지운 카테고리로 등록된 일정을 수정할 때도 선택 상태가 보이도록 목록에 포함
  const list = selected && !state.eventCats.includes(selected)
    ? [...state.eventCats, selected]
    : state.eventCats;
  return list.map((c) => `
    <label class="radio-pill">
      <input type="radio" name="${name}" value="${esc(c)}" required${c === selected ? " checked" : ""} />
      <span>${esc(c)}</span>
    </label>`).join("");
}

function renderEventCatRow() {
  const row = $("eventCatRow");
  if (!row) return;
  const keep = row.querySelector("input:checked")?.value || "";
  row.innerHTML = catPillsHtml("eventCat", keep) + `
    <button type="button" class="cat-manage" data-cat-manage="add" title="카테고리 추가">＋</button>
    <button type="button" class="cat-manage" data-cat-manage="del" title="선택한 카테고리 삭제">－</button>`;
}

async function saveEventCats(list, selectAfter) {
  try {
    await setDoc(doc(db, "site", "eventCategories"), { list }, { merge: true });
    state.eventCats = list;
    renderEventCatRow();
    if (selectAfter) {
      const input = $("eventCatRow").querySelector(`input[value="${CSS.escape(selectAfter)}"]`);
      if (input) input.checked = true;
    }
  } catch (err) {
    alert("카테고리 저장에 실패했어요: " + err.message);
  }
}

$("eventCatRow").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cat-manage]");
  if (!btn) return;
  const list = [...state.eventCats];

  if (btn.dataset.catManage === "add") {
    const name = (prompt("추가할 카테고리 이름을 입력해 주세요. (예: 번개런)") || "").trim();
    if (!name) return;
    if (name.length > 12) return alert("카테고리 이름은 12자 이내로 해주세요.");
    if (list.includes(name)) return alert("이미 있는 카테고리예요.");
    await saveEventCats([...list, name], name);
  } else {
    const sel = $("eventCatRow").querySelector("input:checked")?.value;
    if (!sel) return alert("삭제할 카테고리를 먼저 선택해 주세요.");
    if (list.length <= 1) return alert("카테고리는 1개 이상 있어야 해요.");
    if (!confirm(`'${sel}' 카테고리를 삭제할까요?\n(이미 등록된 일정에는 그대로 남아 있어요)`)) return;
    await saveEventCats(list.filter((c) => c !== sel));
  }
});

$("eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "events"), {
      title: $("eventTitle").value.trim(),
      category: $("eventCatRow").querySelector("input:checked")?.value || "",
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

/* 참석자 이름: 3명까지 표시, 넘으면 '외 x명' */
function attNamesShort(yesEntries) {
  const names = yesEntries.map(([, v]) => esc(v.name || "?"));
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}명`;
  return names.join(", ");
}

/* 운영진용 참석자 체크박스 목록 (일정 카드 + 출석 현황 리스트 공용) */
function attCheckListHtml(evId) {
  const att = attOf(evId);
  return crewMembers().map((m) => {
    const yes = att[m.id] && att[m.id].status === "yes";
    return `
    <label class="att-check">
      <input type="checkbox" data-attuid="${m.id}" data-eventid="${evId}"${yes ? " checked" : ""} />
      <span>${esc(m.name)}</span>
    </label>`;
  }).join("");
}

function eventCardHtml(ev, isPast, openAtt) {
  const dp = parseDateParts(ev.date);
  const att = state.attendance[ev.id] || null;
  let actionsHtml = "";
  let attendHtml = "";

  if (!isPast) {
    const entries = att ? Object.entries(att) : [];
    const yes = entries.filter(([, v]) => v.status === "yes");
    const mine = att && me && att[me.uid] ? att[me.uid].status : null;

    // 참석 버튼: 카드 우측 상단, 수정·삭제와 같은 모양 (다시 누르면 취소)
    actionsHtml = `<button class="btn-mini ${mine === "yes" ? "leaf" : "dark"}" data-action="rsvp" data-id="${ev.id}" data-status="yes">🙋 참석 ${yes.length}</button>`;
    attendHtml = yes.length
      ? `<p class="attend-names"><span class="leaf">참석</span> ${attNamesShort(yes)}</p>`
      : "";
  } else {
    attendHtml = `<div class="rsvp-row"><button class="btn-mini dark" data-action="load-past-att" data-id="${ev.id}">참석 명단 보기</button><span class="attend-names" id="pastAtt-${ev.id}"></span></div>`;
  }

  if (isAdmin) {
    // 배경은 카드(일정)와 같은 흰색, 삭제 ✕만 빨간 글자
    actionsHtml += `
      <button class="btn-mini btn-icon" data-action="edit-event" data-id="${ev.id}" title="수정" aria-label="수정">✏️</button>
      <button class="btn-mini btn-icon btn-x" data-action="del-event" data-id="${ev.id}" title="삭제" aria-label="삭제">✕</button>`;
  }

  // 운영진: 모든 카테고리 일정의 참석자를 체크박스로 수정
  const manageHtml = isAdmin ? `
    <details class="att-manage" data-id="${ev.id}"${openAtt && openAtt.has(ev.id) ? " open" : ""}>
      <summary>👥 참석자 관리 <span class="notice-arrow" aria-hidden="true">▾</span></summary>
      <div class="att-checks">${attCheckListHtml(ev.id)}</div>
    </details>` : "";

  return `
    <article class="app-card event-card ${isPast ? "past" : ""}">
      <div class="event-date-box">
        <div class="d-month">${dp.month}</div>
        <div class="d-day">${dp.day}</div>
        <div class="d-dow">${dp.dow}</div>
      </div>
      <div class="event-main">
        <div class="app-card-head">
          <h4>${ev.category ? `<span class="event-cat" style="background:${catColor(ev.category)}">${esc(ev.category)}</span>` : ""}${esc(ev.title)}</h4>
          ${actionsHtml ? `<div class="card-actions">${actionsHtml}</div>` : ""}
        </div>
        <p class="event-info">🕖 ${esc(ev.time)} · 📍 ${esc(ev.place)}${ev.note ? ` · ${esc(ev.note)}` : ""}${ev.updatedAt ? ` <span class="muted">(수정됨)</span>` : ""}</p>
        ${attendHtml}
        ${manageHtml}
      </div>
    </article>
  `;
}

/* 일정에 실제로 쓰인 카테고리로 필터 칩 표시 */
function renderEventCatFilter() {
  const box = $("eventCatFilter");
  const used = [...new Set(state.events.map((ev) => ev.category).filter(Boolean))]
    .sort((a, b) => {
      const ia = state.eventCats.indexOf(a), ib = state.eventCats.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  if (eventCatFilter !== "all" && !used.includes(eventCatFilter)) eventCatFilter = "all";
  box.hidden = used.length === 0;
  box.innerHTML = used.length === 0 ? "" : [
    `<button type="button" class="cat-chip${eventCatFilter === "all" ? " active" : ""}" data-cat="all">전체</button>`,
    ...used.map((c) => `
      <button type="button" class="cat-chip${eventCatFilter === c ? " active" : ""}" data-cat="${esc(c)}">
        <span class="cat-dot" style="background:${catColor(c)}"></span>${esc(c)}
      </button>`),
  ].join("");
}

$("eventCatFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".cat-chip");
  if (!btn) return;
  eventCatFilter = btn.dataset.cat;
  renderEvents();
});

function renderEvents() {
  renderEventCatFilter();
  const today = todayStr();
  const source = eventCatFilter === "all"
    ? state.events
    : state.events.filter((ev) => ev.category === eventCatFilter);
  const upcoming = source.filter((ev) => ev.date >= today);
  const past = source.filter((ev) => ev.date < today).reverse(); // 최근 것부터

  // 재렌더링 후에도 펼쳐둔 '참석자 관리'는 그대로 유지
  const openAtt = new Set(
    [...document.querySelectorAll("#ev-list details.att-manage[open]")].map((d) => d.dataset.id)
  );

  $("eventUpcoming").innerHTML = upcoming.length
    ? upcoming.map((ev) => eventCardHtml(ev, false, openAtt)).join("")
    : `<p class="empty-note">예정된 일정이 없습니다.${isAdmin ? " 위의 '일정 만들기'로 등록해 보세요!" : ""}</p>`;

  $("eventPast").innerHTML = past.length
    ? past.slice(0, 20).map((ev) => eventCardHtml(ev, true, openAtt)).join("")
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
        // 같은 버튼 다시 누르면 취소
        if (status === "yes" && current.dist &&
            !confirm("참석을 취소하면 입력한 기록도 함께 삭제돼요. 취소할까요?")) return;
        await deleteDoc(ref);
      } else {
        // merge: 이미 입력해 둔 거리·시간 기록은 지우지 않음
        await setDoc(ref, { name: myProfile.name, status, at: serverTimestamp() }, { merge: true });
      }
    } else if (action === "del-event" && confirm("이 일정을 삭제할까요? (출석 기록도 함께 사라져요)")) {
      await deleteDoc(doc(db, "events", id));
    } else if (action === "edit-event") {
      const ev = state.events.find((x) => x.id === id);
      if (!ev) return;
      editEventId = id;
      $("editEventTitle").value = ev.title || "";
      $("editEventCatRow").innerHTML = catPillsHtml("editEventCat", ev.category || "");
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

/* 운영진: 참석자 체크박스로 출석 수정 (일정 카드 + 출석 현황 리스트 공용) */
$("tab-events").addEventListener("change", async (e) => {
  const cb = e.target.closest("input[data-attuid]");
  if (!cb || !isAdmin) return;
  const evId = cb.dataset.eventid;
  const uid = cb.dataset.attuid;
  const prev = attOf(evId)[uid];
  const name = state.members.find((m) => m.id === uid)?.name || (prev && prev.name) || "?";

  try {
    if (cb.checked) {
      await setDoc(doc(db, "events", evId, "attendance", uid),
        { name, status: "yes", at: serverTimestamp() }, { merge: true });
      if (!state.attendance[evId]) {
        monthAtt[evId] = { ...(monthAtt[evId] || {}), [uid]: { ...(prev || {}), name, status: "yes" } };
      }
    } else {
      if (prev && prev.dist &&
          !confirm("기록이 입력된 참석자예요. 참석을 취소하면 기록도 삭제돼요. 계속할까요?")) {
        cb.checked = true;
        return;
      }
      await deleteDoc(doc(db, "events", evId, "attendance", uid));
      if (!state.attendance[evId] && monthAtt[evId]) delete monthAtt[evId][uid];
    }
    // 실시간 구독이 없는 지난 일정은 화면을 직접 갱신 (구독 중이면 스냅샷이 갱신)
    if (!state.attendance[evId]) {
      renderEvents();
      renderStatsIfLoaded();
    }
  } catch (err) {
    cb.checked = !cb.checked;
    alert("출석 수정에 실패했어요: " + err.message);
  }
});

/* '참석자 관리' 펼침: 아직 안 읽어온 지난 일정의 출석을 가져와 채움 */
$("tab-events").addEventListener("click", async (e) => {
  const sum = e.target.closest("details.att-manage > summary");
  if (!sum) return;
  const det = sum.closest("details.att-manage");
  const evId = det.dataset.id;
  if (state.attendance[evId] || monthAtt[evId]) return;
  try {
    const qs = await getDocs(collection(db, "events", evId, "attendance"));
    const map = {};
    qs.docs.forEach((d) => (map[d.id] = d.data()));
    monthAtt[evId] = map;
    const box = det.querySelector(".att-checks");
    if (box) box.innerHTML = attCheckListHtml(evId);
  } catch (err) {
    console.error("출석 데이터 로딩 실패:", err);
  }
});

let editEventId = null;

$("editEventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editEventId) return;
  try {
    await updateDoc(doc(db, "events", editEventId), {
      title: $("editEventTitle").value.trim(),
      category: $("editEventCatRow").querySelector("input:checked")?.value || "",
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

  // 한 줄 목록 — 멤버에겐 '이름 | 합류날짜', 운영진에겐 role·관리 버튼까지 표시
  $("memberList").innerHTML = approved.length ? approved.map((m) => `
    <div class="member-row">
      <span class="member-name">${esc(m.name)}</span>
      <span class="member-since">${fmtDate(m.createdAt)} 합류</span>
      ${isAdmin ? `
      <span class="role-badge ${m.role === "admin" ? "admin" : ""}">${m.role === "admin" ? "👑 운영진" : "멤버"}</span>
      <div class="member-actions">
        ${m.id !== me.uid ? `
        <button class="btn-mini dark" data-action="toggle-admin" data-id="${m.id}" data-role="${m.role}">${m.role === "admin" ? "운영진 해제" : "운영진 지정"}</button>
        <button class="btn-mini danger" data-action="remove-member" data-id="${m.id}" data-name="${esc(m.name)}">내보내기</button>` : ""}
      </div>` : ""}
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
          <p class="app-card-meta">${esc(displayAccount(m.email))} · ${fmtDate(m.createdAt)} 신청</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini leaf" data-action="approve" data-id="${m.id}">✓ 승인</button>
          <button class="btn-mini danger" data-action="reject" data-id="${m.id}" data-name="${esc(m.name)}">거절</button>
        </div>
      </div>
      ${applicantInfoHtml(m)}
    </article>
  `).join("") : `<p class="empty-note">대기 중인 멤버가 없습니다.</p>`;

  $("rejectedList").innerHTML = rejected.length ? rejected.map((m) => `
    <article class="app-card rejected-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(m.name)} <span class="rejected-badge">거절됨</span></h4>
          <p class="app-card-meta">${esc(displayAccount(m.email))} · ${fmtDate(m.createdAt)} 신청 · ${fmtDate(m.rejectedAt)} 거절</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini leaf" data-action="approve" data-id="${m.id}">✓ 승인으로 변경</button>
          <button class="btn-mini danger" data-action="del-rejected" data-id="${m.id}" data-name="${esc(m.name)}">기록 삭제</button>
        </div>
      </div>
      ${applicantInfoHtml(m)}
    </article>
  `).join("") : `<p class="empty-note">거절 기록이 없습니다.</p>`;
}

/* 가입신청서에 적은 정보 (승인 대기/거절 카드에 표시) */
function applicantInfoHtml(m) {
  const line1 = [m.gender, m.ageGroup, m.career, m.region].filter(Boolean).map(esc).join(" · ");
  const line2 = m.contact ? `📱 ${esc(m.contact)}` : "";
  return `
    ${line1 ? `<p class="app-card-meta">${line1}</p>` : ""}
    ${line2 ? `<p class="app-card-meta">${line2}</p>` : ""}
    ${m.intro ? `<div class="app-card-body">${esc(m.intro)}</div>` : ""}`;
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
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});

/* ============================================================
   9. 홈 (대시보드)
   ------------------------------------------------------------
   카테고리별 D-day 카드 · 고정 공지 배너 · 2주 일정 · 진행 중 투표
   ============================================================ */
function renderHome() {
  if (!myProfile) return;
  $("dashHello").innerHTML =
    `${esc(myProfile.name)}님, 반가워요! 🥕 <span class="muted">오늘도 가볍게 달려요.</span>`;

  const today = todayStr();

  // 카테고리별 가장 가까운 예정 일정 → D-day 카드 (최대 3장)
  const nearest = new Map();
  state.events.filter((ev) => ev.date >= today).forEach((ev) => {
    const cat = ev.category || "일정";
    if (!nearest.has(cat)) nearest.set(cat, ev); // 날짜 오름차순 구독이라 첫 번째가 가장 가까움
  });
  const cards = [...nearest.values()].slice(0, 3);
  $("ddayRow").innerHTML = cards.length ? cards.map((ev) => {
    const cat = ev.category || "일정";
    const c = catColor(cat);
    const d = dday(ev.date);
    const dp = parseDateParts(ev.date);
    return `
    <article class="dday-card" data-goto="events" style="background:linear-gradient(150deg, ${c}, ${shadeColor(c, 0.8)})">
      <span class="cat-name">${esc(cat)}</span>
      <div class="dday-num">${d <= 0 ? "D-DAY" : `D-${d}`}</div>
      <div class="dday-title">${esc(ev.title)}</div>
      <div class="dday-meta">📅 ${dp.month} ${dp.day}일(${dp.dow.charAt(0)}) ${esc(ev.time)}<br />📍 ${esc(ev.place)}</div>
    </article>`;
  }).join("") : `<p class="empty-note">예정된 일정이 없습니다.</p>`;

  // 고정 공지 배너 (가장 최근 고정 글)
  const pinned = state.notices.find((n) => n.pinned);
  const banner = $("dashNotice");
  banner.hidden = !pinned;
  if (pinned) banner.innerHTML = `📌 <strong>${esc(pinned.title)}</strong><span class="go">›</span>`;

  // 다가오는 일정 (오늘~2주)
  const limit = addDaysStr(14);
  const near = state.events.filter((ev) => ev.date >= today && ev.date <= limit).slice(0, 6);
  $("dashSched").innerHTML = near.length ? near.map((ev) => {
    const [y, m, d] = ev.date.split("-").map(Number);
    const dowIdx = new Date(y, m - 1, d).getDay();
    const dowCls = dowIdx === 6 ? "sat" : dowIdx === 0 ? "sun" : "";
    return `
    <div class="sched-row">
      <div class="sched-date"><div class="d">${m}/${d}</div><div class="w ${dowCls}">${DOW[dowIdx]}</div></div>
      <div class="sched-body">
        <div class="t">${ev.category ? `<span class="event-cat" style="background:${catColor(ev.category)}">${esc(ev.category)}</span>` : ""}${esc(ev.title)}</div>
        <div class="m">🕖 ${esc(ev.time)} · 📍 ${esc(ev.place)}</div>
      </div>
    </div>`;
  }).join("") : `<p class="empty-note">2주 안에 예정된 일정이 없어요.</p>`;

  // 진행 중인 투표 (가장 최근 것 하나)
  const open = state.polls.find((p) => !p.closed);
  if (open) {
    const total = Object.keys(state.votes[open.id] || {}).length;
    $("dashPoll").innerHTML = `
    <article class="app-card dash-poll" data-goto="news" role="button">
      <p class="poll-q">🗳️ ${esc(open.question)}</p>
      <p class="poll-meta">지금까지 ${total}명 참여 · 눌러서 참여하기 ›</p>
    </article>`;
  } else {
    $("dashPoll").innerHTML = `<p class="empty-note">진행 중인 투표가 없습니다.</p>`;
  }
}

/* ============================================================
   10. 출석 현황 · 일정별 기록 · 이달의 랭킹
   ------------------------------------------------------------
   기록은 events/{id}/attendance/{uid} 문서에 dist(km)·sec(초)로
   저장 — 새 컬렉션 없이 출석 문서를 그대로 확장.
   다가오는 일정은 실시간 구독(state.attendance), 지난 일정은
   필요할 때 한 번 읽어 monthAtt 에 캐시.
   ============================================================ */
function attOf(evId) {
  return state.attendance[evId] || monthAtt[evId] || {};
}

function monthEvents(key) {
  return state.events.filter((ev) => (ev.date || "").slice(0, 7) === key);
}

function crewMembers() {
  return state.members
    .filter((m) => m.role === "member" || m.role === "admin")
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
}

function renderStatsIfLoaded() {
  if (!statMonth || !monthLoaded.has(statMonth)) return;
  renderAttMatrix();
  renderRanking();
}

/* 보고 있는 달의 출석 데이터 확보 후 매트릭스·랭킹 렌더 */
async function ensureMonthData() {
  if (!statMonth) statMonth = thisMonthKey();
  document.querySelectorAll(".stat-month-label").forEach((el) =>
    (el.textContent = monthLabel(statMonth)));

  const need = monthEvents(statMonth).filter(
    (ev) => !state.attendance[ev.id] && !monthAtt[ev.id]);
  if (need.length) {
    $("attMatrix").innerHTML = `<p class="empty-note">출석 현황을 불러오는 중...</p>`;
    try {
      await Promise.all(need.map(async (ev) => {
        const qs = await getDocs(collection(db, "events", ev.id, "attendance"));
        const map = {};
        qs.docs.forEach((d) => (map[d.id] = d.data()));
        monthAtt[ev.id] = map;
      }));
    } catch (err) {
      console.error("출석 데이터 로딩 실패:", err);
    }
  }
  monthLoaded.add(statMonth);
  renderAttMatrix();
  renderRanking();
}

/* ---------- 서브탭 2: 출석 현황 (정기런만 출첵으로 집계) ---------- */

/* 해당 달의 정기런: 한 줄 날짜 칩 → 누른 날짜만 아래 패널 하나에 표시 */
function renderAttChips() {
  const key = statMonth || thisMonthKey();
  const evs = monthEvents(key).filter((ev) => ev.category === ATT_CAT);

  if (attDayId && !evs.some((ev) => ev.id === attDayId)) attDayId = null;

  $("attChips").innerHTML = evs.map((ev) => {
    const yes = Object.values(attOf(ev.id)).filter((a) => a.status === "yes").length;
    const [, m, d] = ev.date.split("-").map(Number);
    const dp = parseDateParts(ev.date);
    return `<button type="button" class="ev-chip${ev.id === attDayId ? " active" : ""}" data-attday="${ev.id}">${m}/${d}(${dp.dow.charAt(0)}) 🥕${yes}</button>`;
  }).join("");

  renderAttDayPanel();
}

function renderAttDayPanel() {
  const panel = $("attDayPanel");
  const ev = state.events.find((x) => x.id === attDayId);
  if (!ev) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const yes = Object.entries(attOf(ev.id)).filter(([, a]) => a.status === "yes");
  const [, m, d] = ev.date.split("-").map(Number);
  const dp = parseDateParts(ev.date);
  panel.hidden = false;
  panel.innerHTML = `
  <div class="app-card att-day-panel">
    <div class="ael-line">
      <span class="ael-date">${m}/${d}(${dp.dow.charAt(0)})</span>
      <span class="ael-cnt">참석 ${yes.length}</span>
      <span class="ael-names">${esc(ev.title)}</span>
    </div>
    ${isAdmin
      ? `<div class="att-checks">${attCheckListHtml(ev.id)}</div>`
      : `<p class="attend-names">${yes.length ? yes.map(([, a]) => esc(a.name || "?")).join(", ") : "아직 참석자가 없어요."}</p>`}
  </div>`;
}

$("attChips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-attday]");
  if (!chip) return;
  // 같은 칩을 다시 누르면 패널 닫기
  attDayId = attDayId === chip.dataset.attday ? null : chip.dataset.attday;
  renderAttChips();
});

function renderAttMatrix() {
  const key = statMonth || thisMonthKey();
  renderAttChips();
  const evs = monthEvents(key).filter((ev) => ev.category === ATT_CAT);
  const members = crewMembers();
  const box = $("attMatrix");

  if (!evs.length || !members.length) {
    $("attSummary").innerHTML = "";
    box.innerHTML = `<p class="empty-note">${monthLabel(key)}에는 정기런 일정이 없습니다.</p>`;
    return;
  }

  let totalYes = 0;
  let totalDist = 0;
  const rows = members.map((m) => {
    const cells = evs.map((ev) => {
      const a = attOf(ev.id)[m.id];
      const yes = !!(a && a.status === "yes");
      if (yes) {
        totalYes++;
        if (a.dist) totalDist += a.dist;
      }
      return yes;
    });
    return { m, cells, sum: cells.filter(Boolean).length };
  });

  const rate = Math.round((totalYes / (members.length * evs.length)) * 100);
  $("attSummary").innerHTML = `
    <span class="sum-chip">정기런 <b>${evs.length}회</b></span>
    <span class="sum-chip">참석 연인원 <b>${totalYes}명</b></span>
    <span class="sum-chip">총 거리 <b>${totalDist ? totalDist.toFixed(1) : 0}km</b></span>
    <span class="sum-chip">평균 출석률 <b>${rate}%</b></span>`;

  box.innerHTML = `
  <div class="mtx-scroll">
    <table class="mtx">
      <thead><tr>
        <th class="nm">이름</th>
        ${evs.map((ev) => {
          const [, m, d] = ev.date.split("-").map(Number);
          const dp = parseDateParts(ev.date);
          return `<th>${m}/${d}<span class="dd">${dp.dow.charAt(0)}</span></th>`;
        }).join("")}
        <th class="sum">출석</th>
      </tr></thead>
      <tbody>
        ${rows.map(({ m, cells, sum }) => `
        <tr${me && m.id === me.uid ? ' class="me-row"' : ""}>
          <td class="nm">${esc(m.name)}</td>
          ${cells.map((y) => `<td>${y ? '<span class="stamp">🥕</span>' : '<span class="miss">–</span>'}</td>`).join("")}
          <td class="sum">${sum}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}

/* ---------- 서브탭 4: 이달의 랭킹 ---------- */
function renderRanking() {
  const key = statMonth || thisMonthKey();
  const evs = monthEvents(key);
  const box = $("rankTable");

  if (!evs.length) {
    box.innerHTML = `<p class="empty-note">${monthLabel(key)}에는 일정이 없습니다.</p>`;
    return;
  }

  const crew = new Map(crewMembers().map((m) => [m.id, m]));
  const agg = new Map(); // uid → { name, att, dist, sec }
  evs.forEach((ev) => {
    Object.entries(attOf(ev.id)).forEach(([uid, a]) => {
      if (a.status !== "yes") return;
      if (!agg.has(uid)) {
        agg.set(uid, { name: crew.get(uid)?.name || a.name || "?", att: 0, dist: 0, sec: 0 });
      }
      const r = agg.get(uid);
      r.att++;
      if (a.dist && a.sec) {
        r.dist += a.dist;
        r.sec += a.sec;
      }
    });
  });

  const list = [...agg.entries()].sort(([, a], [, b]) => b.dist - a.dist || b.att - a.att);
  if (!list.length) {
    box.innerHTML = `<p class="empty-note">아직 출석 기록이 없어요.</p>`;
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  box.innerHTML = `
  <article class="app-card rec-card">
    <table class="rec">
      <thead><tr><th>이름</th><th>출석</th><th>총 거리</th><th>평균 페이스</th></tr></thead>
      <tbody>
        ${list.map(([uid, r], i) => `
        <tr${me && uid === me.uid ? ' class="me-row"' : ""}>
          <td>${medals[i] ? `<span class="rank-medal">${medals[i]}</span>` : ""}${esc(r.name)}${me && uid === me.uid ? ' <span class="muted">(나)</span>' : ""}</td>
          <td>${r.att}회</td>
          ${r.dist > 0
            ? `<td>${r.dist.toFixed(1)} km</td><td>${r.sec > 0 ? fmtPace(r.sec / r.dist) : "–"}</td>`
            : `<td class="none">미입력</td><td class="none">–</td>`}
        </tr>`).join("")}
      </tbody>
    </table>
  </article>`;
}

/* ---------- 서브탭 3: 기록 보기 (마일리지 보드) ----------
   각자 '오늘의 마일리지'를 저장하면 현재 마일리지에 누적.
   목표·각오·현재 마일리지는 본인(운영진은 모두) 수정 가능.
   데이터: mileage/{uid} = { name, note(각오), goal(목표km), km(현재km) } */
function renderMileage() {
  // 입력 중일 때는 실시간 갱신으로 입력값이 지워지지 않도록 잠시 보류
  if (document.activeElement && document.activeElement.id === "myRecDist") return;

  // 오늘의 마일리지 입력 박스
  const t = new Date();
  $("myRecordBox").innerHTML = `
  <div class="my-record">
    <p class="mr-title">🥕 오늘의 마일리지! ${t.getMonth() + 1}월 ${t.getDate()}일</p>
    <div class="mr-form">
      <input type="text" id="myRecDist" inputmode="decimal" placeholder="5.0" aria-label="오늘 뛴 거리(km)" /><span class="unit">km</span>
      <button type="button" class="btn-save" id="btnSaveMyRec">저장</button>
    </div>
    <p class="mr-pace">저장하면 마일리지가 누적되어요!</p>
  </div>`;

  // 기록 보기 표: 이름 | 각오 | 목표 | 현재 (현재 마일리지 많은 순)
  const rows = crewMembers()
    .map((m) => ({ m, r: state.mileage[m.id] || {} }))
    .sort((a, b) => (b.r.km || 0) - (a.r.km || 0));

  if (!rows.length) {
    $("recTable").innerHTML = `<p class="empty-note">아직 크루원이 없습니다.</p>`;
    return;
  }

  $("recTable").innerHTML = `
  <article class="app-card rec-card">
    <table class="rec mileage">
      <thead><tr><th>이름</th><th>각오</th><th>목표 (km)</th><th>현재 (km)</th></tr></thead>
      <tbody>
        ${rows.map(({ m, r }) => {
          const canEdit = isAdmin || (me && m.id === me.uid);
          return `
          <tr${me && m.id === me.uid ? ' class="me-row"' : ""}>
            <td>${esc(m.name)}${canEdit ? ` <button type="button" class="btn-edit-rec" data-mileedit="${m.id}" title="목표·각오·마일리지 수정">✏️</button>` : ""}</td>
            <td class="mile-note">${r.note ? esc(r.note) : '<span class="none">–</span>'}</td>
            <td>${r.goal ? Math.round(r.goal * 10) / 10 : '<span class="none">–</span>'}</td>
            <td><b>${r.km ? Math.round(r.km * 10) / 10 : 0}</b></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </article>`;
}

/* 오늘의 마일리지 저장(누적) + ✏️ 수정 모달 열기 */
$("ev-rec").addEventListener("click", async (e) => {
  if (e.target.closest("#btnSaveMyRec")) {
    if (!me || !myProfile) return;
    const dist = Math.round(parseFloat($("myRecDist").value) * 100) / 100;
    if (!(dist > 0) || dist > 300) return alert("거리(km)를 확인해 주세요. (예: 5.2)");
    try {
      await setDoc(doc(db, "mileage", me.uid), {
        name: myProfile.name,
        km: increment(dist),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      $("myRecDist").value = "";
      alert(`+${dist}km 누적! 오늘도 잘 달렸어요 🥕`);
    } catch (err) {
      alert("저장에 실패했어요: " + err.message);
    }
    return;
  }
  const editBtn = e.target.closest("[data-mileedit]");
  if (editBtn) openMileageModal(editBtn.dataset.mileedit);
});

let mileageUid = null;

function openMileageModal(uid) {
  const m = state.members.find((x) => x.id === uid);
  if (!m) return;
  mileageUid = uid;
  const r = state.mileage[uid] || {};
  $("mileageWho").textContent = `${m.name}님의 각오 · 목표 · 현재 마일리지를 수정합니다.`;
  $("mileNote").value = r.note || "";
  $("mileGoal").value = r.goal ? Math.round(r.goal * 10) / 10 : "";
  $("mileKm").value = r.km ? Math.round(r.km * 10) / 10 : "";
  $("mileageMsg").hidden = true;
  openModal("mileageModal");
}

$("mileageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mileageUid) return;
  const m = state.members.find((x) => x.id === mileageUid);
  const goal = $("mileGoal").value.trim() === "" ? 0 : parseFloat($("mileGoal").value);
  const km = $("mileKm").value.trim() === "" ? 0 : parseFloat($("mileKm").value);
  if (!(goal >= 0) || goal > 10000) return showFormMsg("mileageMsg", "목표 마일리지(km)를 확인해 주세요.", "error");
  if (!(km >= 0) || km > 10000) return showFormMsg("mileageMsg", "현재 마일리지(km)를 확인해 주세요.", "error");
  try {
    await setDoc(doc(db, "mileage", mileageUid), {
      name: m ? m.name : "?",
      note: $("mileNote").value.trim(),
      goal: Math.round(goal * 10) / 10,
      km: Math.round(km * 10) / 10,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    closeModal("mileageModal");
  } catch (err) {
    showFormMsg("mileageMsg", "저장에 실패했어요: " + err.message, "error");
  }
});
