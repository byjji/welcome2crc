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
  state = { notices: [], events: [], polls: [], members: [], attendance: {}, votes: {} };
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
      <div class="notice-body">${esc(n.body)}</div>
      <div class="notice-foot">
        <span class="app-card-meta">${esc(n.author || "")}${n.updatedAt ? " · (수정됨)" : ""}</span>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="pin-notice" data-id="${n.id}" data-pinned="${!!n.pinned}">${n.pinned ? "고정 해제" : "고정"}</button>
          <button class="btn-mini dark" data-action="edit-notice" data-id="${n.id}">수정</button>
          <button class="btn-mini danger" data-action="del-notice" data-id="${n.id}">삭제</button>
        </div>` : ""}
      </div>
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
