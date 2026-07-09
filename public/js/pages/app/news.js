/* ============================================================
   pages/app/news.js — 소식 탭 (공지 + 투표)
   ============================================================ */
import { $, openModal, closeModal, showFormMsg } from "../../lib/ui.js";
import { esc, fmtDate } from "../../lib/format.js";
import {
  db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from "../../lib/firebase.js";
import { state, me, myProfile, isAdmin } from "./state.js";

/* ---------- 소식 필터: 전체 / 공지 / 투표 ---------- */
$("newsFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".sub-tab");
  if (!btn) return;
  document.querySelectorAll("#newsFilter .sub-tab").forEach((t) =>
    t.classList.toggle("active", t === btn));
  const f = btn.dataset.news;
  $("newsNotices").hidden = f === "poll";
  $("newsPolls").hidden = f === "notice";
});

/* ============================================================
   공지
   ============================================================ */
$("noticeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "notices"), {
      title: $("noticeTitle").value.trim(),
      body: $("noticeBody").value.trim(),
      pinned: $("noticePinned").checked,
      author: myProfile.name,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $("noticeAdmin").open = false;
  } catch (err) {
    alert("공지 등록에 실패했어요: " + err.message);
  }
});

export function renderNotices() {
  const list = $("noticeList");
  const sorted = [...state.notices].sort((a, b) => (b.pinned === true) - (a.pinned === true));

  if (!sorted.length) {
    list.innerHTML = `<p class="empty-note">아직 공지가 없습니다.</p>`;
    return;
  }

  // 재렌더링(실시간 갱신) 후에도 펼쳐둔 공지는 그대로 유지
  const openIds = new Set(
    [...list.querySelectorAll("details[open]")].map((d) => d.dataset.id)
  );

  // 고정 | 제목 | 날짜 한 줄 → 누르면 펼쳐서 내용 확인
  list.innerHTML = sorted.map((n) => `
    <details class="app-card notice-row" data-id="${n.id}"${openIds.has(n.id) ? " open" : ""}>
      <summary>
        <span class="notice-pin">${n.pinned ? "📌" : ""}</span>
        <span class="notice-title">${esc(n.title)}</span>
        <span class="notice-date">${fmtDate(n.createdAt)}</span>
        <span class="notice-arrow" aria-hidden="true">▾</span>
      </summary>
      <div class="notice-tools">
        <span class="app-card-meta">${esc(n.author || "")}${n.updatedAt ? " · (수정됨)" : ""}</span>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="pin-notice" data-id="${n.id}" data-pinned="${!!n.pinned}">${n.pinned ? "고정 해제" : "고정"}</button>
          <button class="btn-mini dark" data-action="edit-notice" data-id="${n.id}">수정</button>
          <button class="btn-mini danger" data-action="del-notice" data-id="${n.id}">삭제</button>
        </div>` : ""}
      </div>
      <div class="notice-body">${esc(n.body)}</div>
    </details>
  `).join("");
}

$("noticeList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  try {
    if (action === "del-notice" && confirm("이 공지를 삭제할까요?")) {
      await deleteDoc(doc(db, "notices", id));
    } else if (action === "pin-notice") {
      await updateDoc(doc(db, "notices", id), { pinned: btn.dataset.pinned !== "true" });
    } else if (action === "edit-notice") {
      const n = state.notices.find((x) => x.id === id);
      if (!n) return;
      editNoticeId = id;
      $("editNoticeTitle").value = n.title || "";
      $("editNoticeBody").value = n.body || "";
      $("editNoticeMsg").hidden = true;
      openModal("editNoticeModal");
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});

let editNoticeId = null;

$("editNoticeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editNoticeId) return;
  try {
    await updateDoc(doc(db, "notices", editNoticeId), {
      title: $("editNoticeTitle").value.trim(),
      body: $("editNoticeBody").value.trim(),
      updatedAt: serverTimestamp(),
    });
    closeModal("editNoticeModal");
  } catch (err) {
    showFormMsg("editNoticeMsg", "수정에 실패했어요: " + err.message, "error");
  }
});

/* ============================================================
   투표
   ============================================================ */
$("pollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const options = $("pollOptions").value
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) {
    alert("선택지를 2개 이상 입력해 주세요.");
    return;
  }
  try {
    await addDoc(collection(db, "polls"), {
      question: $("pollQuestion").value.trim(),
      options,
      closed: false,
      author: myProfile.name,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $("pollAdmin").open = false;
  } catch (err) {
    alert("투표 등록에 실패했어요: " + err.message);
  }
});

export function renderPolls() {
  const list = $("pollList");
  if (!state.polls.length) {
    list.innerHTML = `<p class="empty-note">진행 중인 투표가 없습니다.</p>`;
    return;
  }

  list.innerHTML = state.polls.map((p) => {
    const votes = state.votes[p.id] || {};
    const entries = Object.entries(votes);
    const total = entries.length;
    const myVote = me && votes[me.uid] ? votes[me.uid].option : null;
    const counts = p.options.map((_, i) => entries.filter(([, v]) => v.option === i).length);

    return `
    <article class="app-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(p.question)}</h4>
          <p class="app-card-meta">${esc(p.author || "")} · ${fmtDate(p.createdAt)}${p.updatedAt ? " (수정됨)" : ""} ·
            <span class="poll-status ${p.closed ? "closed" : "open"}">${p.closed ? "마감" : "진행 중"}</span>
          </p>
        </div>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="edit-poll" data-id="${p.id}">수정</button>
          <button class="btn-mini dark" data-action="toggle-poll" data-id="${p.id}" data-closed="${!!p.closed}">${p.closed ? "재개" : "마감"}</button>
          <button class="btn-mini danger" data-action="del-poll" data-id="${p.id}">삭제</button>
        </div>` : ""}
      </div>
      <div class="poll-options">
        ${p.options.map((opt, i) => {
          const pct = total ? Math.round((counts[i] / total) * 100) : 0;
          return `
          <button class="poll-option ${myVote === i ? "mine" : ""}"
                  data-action="vote" data-id="${p.id}" data-option="${i}"
                  ${p.closed ? "disabled" : ""}>
            <span class="bar" style="width:${pct}%"></span>
            <span class="opt-label"><span>${esc(opt)}</span><span class="opt-count">${counts[i]}표 (${pct}%)</span></span>
          </button>`;
        }).join("")}
      </div>
      <p class="poll-total">총 ${total}명 참여${p.closed ? "" : " · 선택지를 누르면 투표됩니다 (다시 누르면 변경)"}</p>
    </article>`;
  }).join("");
}

$("pollList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  try {
    if (action === "vote") {
      await setDoc(doc(db, "polls", id, "votes", me.uid), {
        name: myProfile.name,
        option: Number(btn.dataset.option),
        at: serverTimestamp(),
      });
    } else if (action === "toggle-poll") {
      await updateDoc(doc(db, "polls", id), { closed: btn.dataset.closed !== "true" });
    } else if (action === "del-poll" && confirm("이 투표를 삭제할까요?")) {
      await deleteDoc(doc(db, "polls", id));
    } else if (action === "edit-poll") {
      const p = state.polls.find((x) => x.id === id);
      if (!p) return;
      editPollId = id;
      $("editPollQuestion").value = p.question || "";
      $("editPollOptions").value = (p.options || []).join("\n");
      $("editPollMsg").hidden = true;
      openModal("editPollModal");
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
});

let editPollId = null;

$("editPollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editPollId) return;
  const options = $("editPollOptions").value
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) {
    showFormMsg("editPollMsg", "선택지를 2개 이상 입력해 주세요.", "error");
    return;
  }
  try {
    await updateDoc(doc(db, "polls", editPollId), {
      question: $("editPollQuestion").value.trim(),
      options,
      updatedAt: serverTimestamp(),
    });
    closeModal("editPollModal");
  } catch (err) {
    showFormMsg("editPollMsg", "수정에 실패했어요: " + err.message, "error");
  }
});
