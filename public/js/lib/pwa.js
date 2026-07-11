/* ============================================================
   lib/pwa.js — PWA 설치/서비스 워커
   - registerSW(): 서비스 워커 등록 + 자동 업데이트 알림 (모든 페이지 공용)
   - setupInstallBanner(): '홈 화면에 추가' 배너 (크루 공간 전용)
   ============================================================ */

// 사용자가 '업데이트'를 눌러 새 SW 활성화를 요청했을 때만 true (첫 방문 자동 새로고침 방지)
let pendingReload = false;

export function registerSW() {
  if (!("serviceWorker" in navigator)) return;

  // 새 SW 가 제어권을 넘겨받았을 때: 사용자가 업데이트를 누른 경우에만 새로고침
  // (첫 방문의 clients.claim() 으로 인한 불필요한 새로고침은 무시)
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (pendingReload) window.location.reload();
  });

  window.addEventListener("load", async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      console.warn("서비스 워커 등록 실패:", err);
      return;
    }

    // 이전 방문 때 받아둔 새 버전이 이미 대기 중이면 바로 알림
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg);

    // 새 버전 감지: 설치가 끝나 '대기' 상태가 되는 순간 알림
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        // controller 가 있으면 = 기존 SW 가 돌던 중의 '업데이트'(첫 설치 아님)
        if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateToast(reg);
      });
    });

    // 앱을 켤 때 / 다시 화면에 돌아올 때 sw.js 변경 여부를 백그라운드로 확인
    const check = () => reg.update().catch(() => {});
    check();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
  });
}

/* 화면 하단 '새 버전' 알림 토스트 (모든 페이지에 자동 삽입) */
function showUpdateToast(reg) {
  if (document.getElementById("pwaUpdateToast")) return; // 중복 방지

  const el = document.createElement("div");
  el.id = "pwaUpdateToast";
  el.className = "pwa-toast";
  el.innerHTML =
    '<span class="pwa-toast-text">새 버전이 출시되었습니다!</span>' +
    '<div class="pwa-toast-actions">' +
    '<button type="button" class="pwa-toast-btn" id="pwaUpdateBtn">업데이트</button>' +
    '<button type="button" class="pwa-toast-close" id="pwaUpdateClose" aria-label="닫기">✕</button>' +
    "</div>";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));

  document.getElementById("pwaUpdateBtn").addEventListener("click", () => {
    const btn = document.getElementById("pwaUpdateBtn");
    btn.disabled = true;
    btn.textContent = "적용 중...";
    pendingReload = true; // 이제부터 controllerchange 가 오면 새로고침
    // 대기 중인 새 SW 를 활성화 → controllerchange 발생 → 위 리스너가 새로고침
    if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
    // 안전장치: 혹시 controllerchange 가 안 오면 3초 후 강제 새로고침
    setTimeout(() => window.location.reload(), 3000);
  });
  document.getElementById("pwaUpdateClose").addEventListener("click", () => el.remove());
}

/* 홈 화면 설치 안내 배너 (app.html 홈 탭) */
export function setupInstallBanner() {
  const banner = document.getElementById("installBanner");
  const btn = document.getElementById("btnInstall");
  if (!banner || !btn) return;

  // 이미 설치된(홈 화면에서 실행 중) 상태면 배너를 띄우지 않음
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) return;

  let deferred = null;

  // 브라우저가 "설치 가능"이라고 알릴 때만 배너 노출 (기본 설치 배너는 막고 우리 UI 사용)
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    try {
      if (sessionStorage.getItem("crc-install-dismissed")) return; // 이번 세션에 닫았으면 유지
    } catch { /* 무시 */ }
    banner.hidden = false;
  });

  btn.addEventListener("click", async () => {
    banner.hidden = true;
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
  });

  const dismiss = document.getElementById("btnInstallDismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      banner.hidden = true;
      try { sessionStorage.setItem("crc-install-dismissed", "1"); } catch { /* 무시 */ }
    });
  }

  // 설치 완료되면 배너 제거
  window.addEventListener("appinstalled", () => { banner.hidden = true; });
}
