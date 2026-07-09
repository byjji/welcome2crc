/* ============================================================
   lib/ui.js — 화면 공통 유틸 (모달 · 폼 메시지 · 요소 선택)
   ============================================================ */
export const $ = (id) => document.getElementById(id);

/* ---------- 모달 공통 (열기/닫기) ---------- */
export function openModal(id) {
  $(id).hidden = false;
  document.body.style.overflow = "hidden";
}

export function closeModal(id) {
  $(id).hidden = true;
  document.body.style.overflow = "";
}

/* 배경 클릭 · [data-close] 버튼 · ESC 로 닫기 (페이지 진입 시 한 번 호출) */
export function initModals() {
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
}

/* 폼 아래 결과 메시지 (성공/오류) */
export function showFormMsg(id, text, type) {
  const el = $(id);
  el.hidden = false;
  el.textContent = text;
  el.className = `form-msg ${type}`;
}
