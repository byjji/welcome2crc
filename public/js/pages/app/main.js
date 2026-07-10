/* ============================================================
   pages/app/main.js — 크루 공간(app.html) 진입점
   ------------------------------------------------------------
   Firebase 설정을 확인한 뒤에만 본체(init.js)를 불러옵니다.
   화면별 코드는 pages/app/ 아래에 나뉘어 있습니다:
     views.js   화면 전환      state.js   공유 상태
     auth.js    로그인·가입·내 정보
     home.js    홈 대시보드    events.js  일정·출첵·이달의 기록
     news.js    공지+투표      members.js 멤버
     init.js    인증 라우팅·실시간 구독·탭 전환
   ============================================================ */
import { showView } from "./views.js";

if (!window.FIREBASE_READY) {
  showView("config");
  throw new Error("Firebase 설정이 필요합니다 (js/firebase-config.js)");
}

await import("./init.js");
