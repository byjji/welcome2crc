/* ============================================================
   ★★★ Firebase 설정 — 반드시 본인 프로젝트 값으로 교체! ★★★
   ------------------------------------------------------------
   1. https://console.firebase.google.com 에서 프로젝트 생성
   2. 프로젝트 설정(⚙️) → 일반 → 내 앱 → 웹 앱(</>) 추가
   3. 화면에 나오는 firebaseConfig 값을 아래에 그대로 붙여넣기

   자세한 순서는 프로젝트 루트의 README.md 를 참고하세요.
   ============================================================ */

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAh9026Wd0PbPgPZ5r_NKQrl8rlkJGubfY",
  authDomain: "carrotrunningcrew.firebaseapp.com",
  projectId: "carrotrunningcrew",
  storageBucket: "carrotrunningcrew.firebasestorage.app", /* ★ Firestore와 같은 리전(asia-northeast3)으로 재생성함 */
  messagingSenderId: "909696169662",
  appId: "1:909696169662:web:d982838019cc58620a50ef"
};

/* Firebase SDK 버전 (CDN) — 특별한 이유가 없으면 그대로 두세요 */
window.FIREBASE_SDK = "https://www.gstatic.com/firebasejs/11.6.1";

/* 설정이 완료됐는지 검사 (실제 apiKey는 "AIza" 로 시작합니다) */
window.FIREBASE_READY =
  typeof window.FIREBASE_CONFIG.apiKey === "string" &&
  window.FIREBASE_CONFIG.apiKey.startsWith("AIza");
