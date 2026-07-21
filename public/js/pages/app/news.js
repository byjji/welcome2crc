/* ============================================================
   pages/app/news.js — 소식 탭 (공지 + 투표)
   ============================================================ */
import { $, openModal, closeModal, showFormMsg } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
import { esc, fmtDate } from "../../lib/format.js";
import {
  db, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from "../../lib/firebase.js";
import { state, me, myProfile, isAdmin, withoutSystem } from "./state.js";

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
        <span class="notice-pin">${n.pinned ? ic("pushpin") : ""}</span>
        <span class="notice-title">${esc(n.title)}</span>
        <span class="notice-date">${fmtDate(n.createdAt)}</span>
        <span class="notice-arrow" aria-hidden="true">▾</span>
      </summary>
      <div class="notice-tools">
        <span class="app-card-meta">${esc(n.author || "")}</span>
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
   ------------------------------------------------------------
   마감일(deadline)은 "2026-07-20T18:00" 형태의 로컬 시각 문자열.
   마감일이 지나면 운영진이 따로 마감하지 않아도 마감으로 봅니다.
   ============================================================ */
const MIN_OPTIONS = 2;

/* ---------- 선택지 입력 행 (＋ 추가 / − 삭제) ---------- */
function optionRowHtml(value = "") {
  return `
  <div class="opt-row">
    <input class="f-opt" maxlength="60" placeholder="선택지 (예: 참석)" value="${esc(value)}" />
    <button type="button" class="opt-del" aria-label="이 선택지 삭제">−</button>
  </div>`;
}

function fillOptionRows(rowsId, options = []) {
  const rows = options.length ? options : Array(MIN_OPTIONS).fill("");
  $(rowsId).innerHTML = rows.map(optionRowHtml).join("");
}

function readOptionRows(rowsId) {
  return [...$(rowsId).querySelectorAll(".f-opt")]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

/* 투표 만들기·수정 폼이 함께 쓰는 ＋/− 버튼 */
document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-opt-add]");
  if (add) {
    const rows = $(add.dataset.optAdd);
    rows.insertAdjacentHTML("beforeend", optionRowHtml());
    rows.lastElementChild.querySelector(".f-opt").focus();
    return;
  }
  const del = e.target.closest(".opt-del");
  if (!del) return;
  const rows = del.closest(".opt-rows");
  if (rows.querySelectorAll(".opt-row").length <= MIN_OPTIONS) return; // 최소 2개는 남김
  del.closest(".opt-row").remove();
});

/* ---------- 마감일 ---------- */
/* 날짜만 고르고 시각을 비우면 그날 23:59 까지 */
function readDeadline(dateId, timeId) {
  const date = $(dateId).value;
  return date ? `${date}T${$(timeId).value || "23:59"}` : "";
}

function fillDeadline(dateId, timeId, deadline) {
  const [date = "", time = ""] = String(deadline || "").split("T");
  $(dateId).value = date;
  $(timeId).value = time;
}

/* 운영진이 마감했거나, 마감일이 지났으면 마감 */
export function isPollClosed(p) {
  return !!p.closed || (!!p.deadline && new Date(p.deadline).getTime() <= Date.now());
}

/* "2026-07-20T18:00" → "7/20 18:00" */
function fmtDeadline(deadline) {
  const [date, time] = String(deadline).split("T");
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)} ${time}`;
}

/* 활동 중인 크루원 수 — 참여율(3/25 참여)의 분모 */
function crewTotal() {
  return state.members.filter((m) => m.role === "member" || m.role === "admin").length;
}

$("pollForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const options = readOptionRows("pollOptionRows");
  if (options.length < MIN_OPTIONS) {
    alert("선택지를 2개 이상 입력해 주세요.");
    return;
  }
  try {
    await addDoc(collection(db, "polls"), {
      question: $("pollQuestion").value.trim(),
      options,
      deadline: readDeadline("pollDueDate", "pollDueTime"),
      closed: false,
      author: myProfile.name,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    fillOptionRows("pollOptionRows"); // reset 은 추가된 행까지 지우지는 못함
    $("pollAdmin").open = false;
  } catch (err) {
    alert("투표 등록에 실패했어요: " + err.message);
  }
});

fillOptionRows("pollOptionRows"); // 투표 만들기 폼의 첫 모습: 빈 선택지 2줄

export function renderPolls() {
  const list = $("pollList");
  if (!state.polls.length) {
    list.innerHTML = `<p class="empty-note">진행 중인 투표가 없습니다.</p>`;
    return;
  }

  const crew = crewTotal();

  list.innerHTML = state.polls.map((p) => {
    const votes = withoutSystem(state.votes[p.id]); // 운영용 계정(admin)의 표는 집계에서 제외
    const entries = Object.entries(votes);
    const total = entries.length;
    const closed = isPollClosed(p);
    const byDeadline = closed && !p.closed; // 마감일이 지나 자동으로 마감된 투표
    const myVote = me && votes[me.uid] ? votes[me.uid].option : null;
    const counts = p.options.map((_, i) => entries.filter(([, v]) => v.option === i).length);

    return `
    <article class="app-card">
      <div class="app-card-head">
        <div>
          <h4>${esc(p.question)}</h4>
          <p class="app-card-meta">${esc(p.author || "")} · ${fmtDate(p.createdAt)} ·
            <span class="poll-status ${closed ? "closed" : "open"}">${closed ? "마감" : "진행 중"}</span>
            ${p.deadline ? `<span class="poll-due">${fmtDeadline(p.deadline)}${closed ? " 마감됨" : "까지"}</span>` : ""}
          </p>
        </div>
        ${isAdmin ? `
        <div class="card-actions">
          <button class="btn-mini dark" data-action="edit-poll" data-id="${p.id}">수정</button>
          ${byDeadline ? "" /* 마감일로 닫힌 투표는 '수정'에서 마감일을 바꿔 다시 열어요 */
            : `<button class="btn-mini dark" data-action="toggle-poll" data-id="${p.id}" data-closed="${!!p.closed}">${p.closed ? "재개" : "마감"}</button>`}
          <button class="btn-mini danger" data-action="del-poll" data-id="${p.id}">삭제</button>
        </div>` : ""}
      </div>
      <div class="poll-options">
        ${p.options.map((opt, i) => {
          const pct = total ? Math.round((counts[i] / total) * 100) : 0;
          return `
          <div class="poll-option ${myVote === i ? "mine" : ""}">
            <span class="bar" style="width:${pct}%"></span>
            <button type="button" class="opt-pick" data-action="vote" data-id="${p.id}" data-option="${i}"
                    ${closed ? "disabled" : ""}>${esc(opt)}</button>
            <button type="button" class="opt-count" data-action="voters" data-id="${p.id}" data-option="${i}"
                    ${counts[i] ? "" : "disabled"} aria-label="${esc(opt)} 투표자 보기">
              ${counts[i]}명 <span class="opt-pct">${pct}%</span>
            </button>
          </div>`;
        }).join("")}
      </div>
      <p class="poll-total">${crew ? `<strong>${total}/${crew}</strong> 참여` : `<strong>${total}명</strong> 참여`}${closed ? "" : " · 선택지를 누르면 투표, 인원수를 누르면 투표자를 볼 수 있어요"}</p>
    </article>`;
  }).join("");

  // 투표자 모달이 열려 있으면 방금 들어온 표까지 반영
  if (votersOpen && !$("pollVotersModal").hidden) renderVoters(votersOpen.id, votersOpen.option);
}

/* ---------- 투표자 보기 (선택지의 인원수 버튼) ---------- */
let votersOpen = null; // { id, option }

function renderVoters(pollId, option) {
  const poll = state.polls.find((p) => p.id === pollId);
  if (!poll) return;

  const names = Object.values(withoutSystem(state.votes[pollId]))
    .filter((v) => v.option === option)
    .map((v) => v.name || "이름 없음")
    .sort((a, b) => a.localeCompare(b, "ko"));

  $("pollVotersWho").innerHTML = `${esc(poll.options[option] || "")} · <strong>${names.length}명</strong>`;
  $("pollVotersList").innerHTML = names.length
    ? names.map((n) => `<span class="voter-chip">${esc(n)}</span>`).join("")
    : `<p class="empty-note">아직 이 선택지를 고른 사람이 없어요.</p>`;
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
    } else if (action === "voters") {
      votersOpen = { id, option: Number(btn.dataset.option) };
      renderVoters(id, votersOpen.option);
      openModal("pollVotersModal");
    } else if (action === "toggle-poll") {
      await updateDoc(doc(db, "polls", id), { closed: btn.dataset.closed !== "true" });
    } else if (action === "del-poll" && confirm("이 투표를 삭제할까요?")) {
      await deleteDoc(doc(db, "polls", id));
    } else if (action === "edit-poll") {
      const p = state.polls.find((x) => x.id === id);
      if (!p) return;
      editPollId = id;
      $("editPollQuestion").value = p.question || "";
      fillOptionRows("editPollOptionRows", p.options || []);
      fillDeadline("editPollDueDate", "editPollDueTime", p.deadline);
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
  const options = readOptionRows("editPollOptionRows");
  if (options.length < MIN_OPTIONS) {
    showFormMsg("editPollMsg", "선택지를 2개 이상 입력해 주세요.", "error");
    return;
  }
  try {
    await updateDoc(doc(db, "polls", editPollId), {
      question: $("editPollQuestion").value.trim(),
      options,
      deadline: readDeadline("editPollDueDate", "editPollDueTime"),
      updatedAt: serverTimestamp(),
    });
    closeModal("editPollModal");
  } catch (err) {
    showFormMsg("editPollMsg", "수정에 실패했어요: " + err.message, "error");
  }
});
