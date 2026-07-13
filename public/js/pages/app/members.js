/* ============================================================
   pages/app/members.js — 멤버 탭 (목록 + 운영진 관리)
   ============================================================ */
import { $, openModal } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
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

  // 하단 '멤버' 탭의 승인 대기 알림 배지 (운영진 + 대기자 있을 때만)
  const tabBadge = $("memberTabBadge");
  if (tabBadge) {
    const showBadge = isAdmin && pending.length > 0;
    tabBadge.hidden = !showBadge;
    tabBadge.textContent = showBadge ? (pending.length > 99 ? "99+" : String(pending.length)) : "";
  }

  // 한 줄 목록 — 이름 | 합류날짜, 운영진에게만 왕관 배지 (멤버는 배지 없음)
  // 운영진은 줄을 누르면 그 멤버의 가입신청 정보 모달이 열림
  $("memberList").innerHTML = approved.length ? approved.map((m) => `
    <div class="member-row${isAdmin ? " tappable" : ""}" data-member="${m.id}"${isAdmin ? ' role="button" tabindex="0"' : ""}>
      <span class="member-name">${esc(m.name)}</span>
      <span class="member-since">${fmtDate(m.createdAt)} 합류</span>
      ${m.role === "admin" ? `<span class="role-badge admin" title="운영진">${ic("crown")}</span>` : ""}
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

  // 멤버 정보 모달이 열려 있으면 방금 바뀐 내용까지 반영
  if (infoUid && !$("memberInfoModal").hidden) renderMemberInfo(infoUid);
}

/* 가입신청서에 적은 정보 (승인 대기/거절 카드에 표시) */
function applicantInfoHtml(m) {
  const line1 = [m.gender, m.ageGroup, m.career, m.region].filter(Boolean).map(esc).join(" · ");
  const line2 = m.contact ? `연락처 ${esc(m.contact)}` : "";
  return `
    ${line1 ? `<p class="app-card-meta">${line1}</p>` : ""}
    ${line2 ? `<p class="app-card-meta">${line2}</p>` : ""}
    ${m.intro ? `<div class="app-card-body">${esc(m.intro)}</div>` : ""}`;
}

/* ============================================================
   멤버 정보 모달 (운영진 전용) — 목록에서 멤버를 누르면 열림
   ------------------------------------------------------------
   가입신청서에 적은 내용(성별·연령대·경력·사는 곳·연락처·하고 싶은 말)을
   그대로 보여줍니다. 연락처는 눌러서 바로 전화할 수 있게 tel: 링크로.
   ============================================================ */
let infoUid = null; // 모달로 보고 있는 멤버

function renderMemberInfo(uid) {
  const m = state.members.find((x) => x.id === uid);
  if (!m) return;

  $("memberInfoName").innerHTML =
    `${esc(m.name)}${m.role === "admin" ? ` ${ic("crown", "ic-crown")}` : ""}`;

  const rows = [
    ["계정", esc(displayAccount(m.email))],
    ["합류", `${fmtDate(m.createdAt)}`],
    ["성별", esc(m.gender)],
    ["연령대", esc(m.ageGroup)],
    ["대회 경력", esc(m.career)],
    ["사는 곳", esc(m.region)],
    ["연락처", m.contact ? `<a href="tel:${esc(String(m.contact).replace(/[^\d+-]/g, ""))}">${esc(m.contact)}</a>` : ""],
  ].filter(([, v]) => v);

  // 가입신청서를 거치지 않은 초기·예전 멤버는 계정·합류일 외에 적을 내용이 없음
  const noApplication = rows.length <= 2 && !m.intro;

  $("memberInfoBody").innerHTML = `
    <dl class="info-list">
      ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
    </dl>
    ${m.intro ? `
      <p class="info-label">하고 싶은 말</p>
      <div class="app-card-body">${esc(m.intro)}</div>` : ""}
    ${noApplication ? `<p class="empty-note">가입신청서에 적은 정보가 없어요.</p>` : ""}`;
}

function openMemberInfo(uid) {
  infoUid = uid;
  renderMemberInfo(uid);
  openModal("memberInfoModal");
}

/* 키보드(Enter·Space)로도 멤버 줄을 열 수 있게 */
$("memberList").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".member-row");
  if (!row || !isAdmin) return;
  e.preventDefault();
  openMemberInfo(row.dataset.member);
});

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
  if (!btn) {
    // 운영진이 멤버 줄(버튼이 아닌 곳)을 누르면 가입신청 정보 모달
    const row = e.target.closest(".member-row");
    if (row && isAdmin) openMemberInfo(row.dataset.member);
    return;
  }
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
