/* ============================================================
   lib/account.js — 계정(아이디) 변환 + 비밀번호 힌트 암호화
   ------------------------------------------------------------
   · Firebase 인증은 이메일 형식을 요구하므로, 아이디 뒤에 내부용
     가짜 도메인(@crc.ulsan)을 자동으로 붙여 저장합니다.
     화면에는 아이디만 보이고, 이메일은 어디에도 쓰이지 않습니다.
     계정은 대소문자를 구분하는데 Firebase 가 대문자를 소문자로
     바꿔 저장하므로, 대문자는 "+소문자" 로 인코딩해 보존합니다.
     (HongGil → +hong+gil@crc.ulsan / "+" 는 계정에 쓸 수 없는 문자)
   · 비밀번호 힌트: 비밀번호를 "답변"을 열쇠로 잠근 암호문으로
     저장/복호화하는 Web Crypto(PBKDF2 + AES-GCM) 유틸.
   ============================================================ */

/* ---------- 계정 ↔ 내부 인증 주소 ---------- */
export const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;

export function toAuthEmail(account) {
  const id = String(account || "").trim();
  if (id.includes("@")) return id.toLowerCase(); // 예전 이메일 계정
  return id.replace(/[A-Z]/g, (c) => "+" + c.toLowerCase()) + "@crc.ulsan";
}

/* 화면 표시용: 내부 도메인을 감추고 대문자 인코딩을 원래대로 복원 */
export function displayAccount(email) {
  const m = String(email || "").match(/^(.*)@crc\.(ulsan|local)$/);
  if (!m) return String(email || "");
  return m[1].replace(/\+([a-z])/g, (_, c) => c.toUpperCase());
}

/* ---------- 비밀번호 힌트 암호화 ---------- */
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* 답변 비교는 공백만 무시하고 대소문자는 구분합니다 ("나이키 " = "나이키", "Nike" ≠ "nike") */
export const normAnswer = (s) => String(s || "").trim().replace(/\s+/g, "");
export const hintDocId = (email) => String(email || "").trim().toLowerCase();

async function hintKey(secret, salt) {
  const base = await crypto.subtle.importKey("raw", textEnc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function sealText(plain, secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await hintKey(secret, salt);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEnc.encode(plain));
  return { data: toB64(data), salt: toB64(salt), iv: toB64(iv) };
}

export async function openSealed(sealed, secret) {
  try {
    const key = await hintKey(secret, fromB64(sealed.salt));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(sealed.iv) }, key, fromB64(sealed.data));
    return textDec.decode(plain);
  } catch {
    return null; // 열쇠(답변 또는 비밀번호)가 맞지 않으면 실패
  }
}
