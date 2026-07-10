/* ============================================================
   pages/app/members.js — 멤버 탭 (목록 + 운영진 관리)
   ============================================================ */
import { $ } from "../../lib/ui.js";
import { esc, fmtDate } from "../../lib/format.js";
import { displayAccount } from "../../lib/account.js";
import { db, doc, updateDoc, deleteDoc, serverTimestamp } from "../../lib/firebase.js";
import { state, me, isAdmin } from "./state.js";

export function renderMembers() {
  const approved = state.members
    .filter((m) => m.role === "member" || m.role === "admin")
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  const pending = state.members.filter((m) => m.role === "pending");
  const rejected = state.members
    .filter((m) => m.role === "rejected")
    .sort((a, b) => (b.rejectedAt?.seconds || 0) - (a.rejectedAt?.seconds || 0));
  const removed = state.members
    .filter((m) => m.role === "removed")
    .sort((a, b) => (b.removedAt?.seconds || 0) - (a.removedAt?.seconds || 0));

  $("memberCount").textContent = `${approved.length}명`;

  // 한 줄 목록 — 이름 | 합류날짜, 운영진에게만 👑 배지 (멤버는 배지 없음)
  $("memberList").innerHTML = approved.length ? approved.map((m) => `
    <div class="member-row">
      <span class="member-name">${esc(m.name)}</span>
      <span class="member-since">${fmtDate(m.createdAt)} 합류</span>
      ${m.role === "admin" ? `<span class="role-badge admin" title="운영진">👑</span>` : ""}
      ${isAdmin ? `
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
  $("removedCount").textContent = removed.length;

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
          <button class="btn-mini danger" data-action="del-record" data-id="${m.id}" data-name="${esc(m.name)}" data-kind="거절">기록 삭제</button>
        </div>
      </div>
      ${applicantInfoHtml(m)}
    </article>
  `).join("") : `<p class="empty-note">거절 기록이 없습니다.</p>`;

  // 내보내기 히스토리 — 복구(멤버로) 또는 기록 완전 삭제
  $("removedList").innerHTML = removed.length ? removed.map((m) => `
    <article class="app-card rejected-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(m.name)} <span class="rejected-badge">내보냄</span></h4>
          <p class="app-card-meta">${esc(displayAccount(m.email))} · ${fmtDate(m.createdAt)} 합류 · ${fmtDate(m.removedAt)} 내보냄</p>
        </div>
        <div class="card-actions">
          <button class="btn-mini leaf" data-action="approve" data-id="${m.id}">↩ 멤버로 복구</button>
          <button class="btn-mini danger" data-action="del-record" data-id="${m.id}" data-name="${esc(m.name)}" data-kind="내보내기">기록 삭제</button>
        </div>
      </div>
      ${applicantInfoHtml(m)}
    </article>
  `).join("") : `<p class="empty-note">내보내기 기록이 없습니다.</p>`;
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
    } else if (action === "del-record" && confirm(`${btn.dataset.name}님의 ${btn.dataset.kind} 기록을 완전히 삭제할까요?\n(삭제하면 이 사람이 다시 로그인할 때 '승인 대기'로 새로 등록돼요)`)) {
      await deleteDoc(doc(db, "members", id));
    } else if (action === "toggle-admin") {
      const newRole = btn.dataset.role === "admin" ? "member" : "admin";
      if (confirm(newRole === "admin" ? "운영진으로 지정할까요?" : "운영진에서 해제할까요?")) {
        await updateDoc(doc(db, "members", id), { role: newRole });
      }
    } else if (action === "remove-member" && confirm(`${btn.dataset.name}님을 크루에서 내보낼까요?\n(기록은 '내보내기' 탭에 남고, 언제든 멤버로 복구할 수 있어요)`)) {
      await updateDoc(doc(db, "members", id), { role: "removed", removedAt: serverTimestamp() });
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});
