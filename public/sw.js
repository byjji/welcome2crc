/* ============================================================
   당근러닝크루 서비스 워커 — 앱 셸 오프라인 캐시
   ------------------------------------------------------------
   전략: 같은 출처(GET)는 "네트워크 우선 → 실패 시 캐시".
   - 온라인이면 항상 최신 파일을 받아 캐시를 갱신 (배포 즉시 반영)
   - 오프라인이면 캐시된 앱 셸로 동작, 페이지 이동은 캐시 폴백
   - 외부 요청(Firebase SDK·Firestore·폰트 CDN)은 건드리지 않음
   앱 셸만 캐시하며, 실제 데이터는 Firestore(네트워크)에서 옵니다.

   ★ 배포할 때마다 아래 VERSION 을 올리세요 (예: v2 → v3).
     그래야 브라우저가 sw.js 변경을 감지 → 새 버전이 '대기' 상태가 되고,
     pwa.js 가 "새 버전이 출시되었습니다!" 알림을 띄웁니다.
     (안 올려도 온라인이면 최신 파일은 네트워크 우선으로 자동 반영됩니다.
      VERSION 을 올리는 건 '업데이트 알림'을 띄우기 위한 것)
   ============================================================ */
const VERSION = "crc-v2";

const CORE = [
  "index.html",
  "app.html",
  "admin.html",
  "css/base.css",
  "css/components.css",
  "css/pages/public.css",
  "css/pages/app.css",
  "css/pages/admin.css",
  "data/cheers.json",
  "favicon.svg",
  "img/logo.png",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-192.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // 일부 파일이 없어도 설치가 실패하지 않도록 개별 처리
      .then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => null))))
    // 여기서 skipWaiting 하지 않음 — 새 버전은 '대기' 상태로 두고,
    // 사용자가 알림의 '업데이트'를 눌렀을 때만 활성화합니다.
    // (첫 설치는 제어 중인 SW 가 없어 곧바로 활성화되므로 대기하지 않음)
  );
});

// 페이지(pwa.js)에서 '업데이트'를 누르면 대기 중인 새 SW 를 즉시 활성화
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부(Firebase·폰트 등)는 그대로

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 정상 응답만 캐시에 갱신 (오류·부분 응답 제외)
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (cached) => cached || (req.mode === "navigate" ? caches.match("index.html") : undefined)
        )
      )
  );
});
