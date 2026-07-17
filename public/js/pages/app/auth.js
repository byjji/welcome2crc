/* ============================================================
   pages/app/auth.js — 로그인 · 가입신청 · 비밀번호 찾기
   ------------------------------------------------------------
   계정(아이디) 변환·비밀번호 힌트 암호화는 lib/account.js 공용.
   로그인 상태에 따른 화면 라우팅은 init.js 가 담당합니다.
   내 정보 수정(이름·비밀번호·힌트)은 내 정보·관리 허브(admin.html)로 이동.
   ============================================================ */
import { $, openModal, closeModal, showFormMsg } from "../../lib/ui.js";
import { ACCOUNT_RE, toAuthEmail, normAnswer, hintDocId, sealText, openSealed } from "../../lib/account.js";
import {
  auth, db, doc, getDoc, setDoc, serverTimestamp,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile,
  updatePassword,
} from "../../lib/firebase.js";
import { setSignupName, setSignupExtra } from "./state.js";

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

/* 비밀번호 힌트 문서 저장 — 비밀번호를 답변으로, 답변을 비밀번호로 서로 잠가 저장 */
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
   로그인 / 가입신청 폼
   ============================================================ */
let authMode = "login"; // 'login' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll(".auth-mode").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode));
  $("signupRows").hidden = mode !== "signup";
  $("btnEmailSubmit").textContent = mode === "signup" ? "가입 신청하기" : "로그인";
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
  const email = toAuthEmail(account); // 내부 인증용 (아이디@crc.ulsan)
  const pw = $("authPw").value;

  try {
    if (authMode === "signup") {
      const signupName = $("authName").value.trim();
      setSignupName(signupName);
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

      setSignupExtra({
        gender, contact, region, ageGroup, career,
        intro: $("signupIntro").value.trim(),
      });
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

function showAuthError(err, custom) {
  const el = $("authError");
  el.hidden = false;
  el.textContent = custom || authErrorMsg(err);
}

function hideAuthError() {
  $("authError").hidden = true;
}

/* ============================================================
   비밀번호 찾기 (힌트 질문/답변 확인 → 새 비밀번호 설정)
   ============================================================ */
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
    alert("비밀번호가 변경되었어요! 그대로 로그인됩니다.");
  } catch (err) {
    showFormMsg("newPwMsg", authErrorMsg(err), "error");
  }
});

/* ============================================================
   내 정보 · 관리 허브로 이동 (이름·비밀번호·힌트 수정은 허브에서)
   ============================================================ */
$("userName").addEventListener("click", () => {
  location.href = "admin.html";
});
