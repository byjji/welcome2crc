/* ============================================================
   lib/swipe.js — 좌/우 스와이프 감지 (탭 이동 공용)
   ------------------------------------------------------------
   · 문서 전체에서 감지 → 콘텐츠가 짧아 생긴 빈 여백에서도 동작
   · 세로 스크롤 / 가로 스크롤 영역(서브탭·칩·표) / 모달 열림 중에는 무시
   · handler(dir): "left"  = 손가락을 왼쪽으로 밀기(다음),
                   "right" = 오른쪽으로 밀기(이전)
   ============================================================ */
const MIN = 55;     // 최소 가로 이동(px)
const RATIO = 1.5;  // 세로보다 가로가 이만큼 우세할 때만 이동(세로 스크롤 보호)

/* 시작 지점이 가로 스크롤 가능한 요소 안이면 스와이프로 보지 않음 */
function inHScroll(node) {
  let el = node instanceof Element ? node : node?.parentElement;
  while (el && el !== document.body) {
    const ox = getComputedStyle(el).overflowX;
    if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 2) return true;
    el = el.parentElement;
  }
  return false;
}

/* onSwipe(handler, { enabled })
   - enabled(): 스와이프를 받을 상태인지(예: 특정 화면일 때만). 생략 시 항상 활성 */
export function onSwipe(handler, opts = {}) {
  const enabled = opts.enabled || (() => true);
  let active = false, sx = 0, sy = 0;

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || !enabled() ||
        document.querySelector(".modal:not([hidden])") || // 모달 열려 있으면 무시
        inHScroll(e.target)) { active = false; return; }
    active = true;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    if (!active) return;
    active = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < MIN || Math.abs(dx) < Math.abs(dy) * RATIO) return;
    handler(dx < 0 ? "left" : "right");
  }, { passive: true });
}
