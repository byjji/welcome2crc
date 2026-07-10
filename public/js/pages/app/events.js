/* ============================================================
   pages/app/events.js — 일정·출첵 탭
   ------------------------------------------------------------
   서브탭 1 일정: 목록·카테고리·참석(출석체크)·참석자 관리
   서브탭 2 출석 현황: 정기런 날짜 칩 + 월별 매트릭스
   서브탭 3 이달의 기록: 월별 마일리지 보드 + 메달 랭킹
   ============================================================ */
import { $, openModal, closeModal, showFormMsg } from "../../lib/ui.js";
import {
  esc, todayStr, parseDateParts, catColor, catBadgeStyle,
  thisMonthKey, shiftMonth, monthLabel,
} from "../../lib/format.js";
import {
  db, collection, doc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp, increment,
} from "../../lib/firebase.js";
import {
  state, me, myProfile, isAdmin, ATT_CAT,
  eventCatFilter, setEventCatFilter,
  statMonth, setStatMonth, monthAtt, monthLoaded,
  attDayId, setAttDayId,
} from "./state.js";

/* ============================================================
   일정 카테고리 (site/eventCategories 문서에 저장)
   ============================================================ */
function catPillsHtml(name, selected) {
  // 이미 지운 카테고리로 등록된 일정을 수정할 때도 선택 상태가 보이도록 목록에 포함
  const list = selected && !state.eventCats.includes(selected)
    ? [...state.eventCats, selected]
    : state.eventCats;
  return list.map((c) => `
    <label class="radio-pill">
      <input type="radio" name="${name}" value="${esc(c)}" required${c === selected ? " checked" : ""} />
      <span>${esc(c)}</span>
    </label>`).join("");
}

export function renderEventCatRow() {
  const row = $("eventCatRow");
  if (!row) return;
  const keep = row.querySelector("input:checked")?.value || "";
  row.innerHTML = catPillsHtml("eventCat", keep) + `
    <button type="button" class="cat-manage" data-cat-manage="add" title="카테고리 추가">＋</button>
    <button type="button" class="cat-manage" data-cat-manage="del" title="선택한 카테고리 삭제">－</button>`;
}

async function saveEventCats(list, selectAfter) {
  try {
    await setDoc(doc(db, "site", "eventCategories"), { list }, { merge: true });
    state.eventCats = list;
    renderEventCatRow();
    if (selectAfter) {
      const input = $("eventCatRow").querySelector(`input[value="${CSS.escape(selectAfter)}"]`);
      if (input) input.checked = true;
    }
  } catch (err) {
    alert("카테고리 저장에 실패했어요: " + err.message);
  }
}

$("eventCatRow").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cat-manage]");
  if (!btn) return;
  const list = [...state.eventCats];

  if (btn.dataset.catManage === "add") {
    const name = (prompt("추가할 카테고리 이름을 입력해 주세요. (예: 번개런)") || "").trim();
    if (!name) return;
    if (name.length > 12) return alert("카테고리 이름은 12자 이내로 해주세요.");
    if (list.includes(name)) return alert("이미 있는 카테고리예요.");
    await saveEventCats([...list, name], name);
  } else {
    const sel = $("eventCatRow").querySelector("input:checked")?.value;
    if (!sel) return alert("삭제할 카테고리를 먼저 선택해 주세요.");
    if (list.length <= 1) return alert("카테고리는 1개 이상 있어야 해요.");
    if (!confirm(`'${sel}' 카테고리를 삭제할까요?\n(이미 등록된 일정에는 그대로 남아 있어요)`)) return;
    await saveEventCats(list.filter((c) => c !== sel));
  }
});

/* ============================================================
   서브탭 1: 일정 (목록 · 등록 · 참석)
   ============================================================ */
$("eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, "events"), {
      title: $("eventTitle").value.trim(),
      category: $("eventCatRow").querySelector("input:checked")?.value || "",
      date: $("eventDate").value,          // "YYYY-MM-DD"
      time: $("eventTime").value,          // "HH:MM"
      place: $("eventPlace").value.trim(),
      note: $("eventNote").value.trim(),
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    $("eventTime").value = "19:20";
    $("eventAdmin").open = false;
  } catch (err) {
    alert("일정 등록에 실패했어요: " + err.message);
  }
});

/* 참석자 이름: 3명까지 표시, 넘으면 '외 x명' */
function attNamesShort(yesEntries) {
  const names = yesEntries.map(([, v]) => esc(v.name || "?"));
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}명`;
  return names.join(", ");
}

/* 운영진용 참석자 체크박스 목록 (일정 카드 + 출석 현황 패널 공용) */
function attCheckListHtml(evId) {
  const att = attOf(evId);
  return crewMembers().map((m) => {
    const yes = att[m.id] && att[m.id].status === "yes";
    return `
    <label class="att-check">
      <input type="checkbox" data-attuid="${m.id}" data-eventid="${evId}"${yes ? " checked" : ""} />
      <span>${esc(m.name)}</span>
    </label>`;
  }).join("");
}

function eventCardHtml(ev, isPast, openAtt) {
  const dp = parseDateParts(ev.date);
  const att = state.attendance[ev.id] || null;
  let actionsHtml = "";
  let attendHtml = "";

  if (!isPast) {
    const entries = att ? Object.entries(att) : [];
    const yes = entries.filter(([, v]) => v.status === "yes");
    const mine = att && me && att[me.uid] ? att[me.uid].status : null;

    // 참석 버튼: 수정·삭제 아이콘과 같은 크기로 우측 상단 구석에 (다시 누르면 취소)
    actionsHtml = `<button class="btn-mini ${mine === "yes" ? "leaf" : "dark"}" data-action="rsvp" data-id="${ev.id}" data-status="yes">🙋 참석 ${yes.length}</button>`;
    attendHtml = yes.length
      ? `<p class="attend-names"><span class="leaf">참석</span> ${attNamesShort(yes)}</p>`
      : "";
  } else {
    attendHtml = `<div class="rsvp-row"><button class="btn-mini dark" data-action="load-past-att" data-id="${ev.id}">참석 명단 보기</button><span class="attend-names" id="pastAtt-${ev.id}"></span></div>`;
  }

  if (isAdmin) {
    // 배경은 카드(일정)와 같은 흰색, 삭제 ✕만 빨간 글자
    actionsHtml += `
      <button class="btn-mini btn-icon" data-action="edit-event" data-id="${ev.id}" title="수정" aria-label="수정">✏️</button>
      <button class="btn-mini btn-icon btn-x" data-action="del-event" data-id="${ev.id}" title="삭제" aria-label="삭제">✕</button>`;
  }

  // 운영진: 모든 카테고리 일정의 참석자를 체크박스로 수정
  const manageHtml = isAdmin ? `
    <details class="att-manage" data-id="${ev.id}"${openAtt && openAtt.has(ev.id) ? " open" : ""}>
      <summary>👥 참석자 관리 <span class="notice-arrow" aria-hidden="true">▾</span></summary>
      <div class="att-checks">${attCheckListHtml(ev.id)}</div>
    </details>` : "";

  return `
    <article class="app-card event-card ${isPast ? "past" : ""}">
      <div class="event-date-box">
        <div class="d-month">${dp.month}</div>
        <div class="d-day">${dp.day}</div>
        <div class="d-dow">${dp.dow}</div>
      </div>
      <div class="event-main">
        ${actionsHtml ? `<div class="card-actions">${actionsHtml}</div>` : ""}
        <div class="app-card-head">
          <h4>${ev.category ? `<span class="event-cat" style="${catBadgeStyle(ev.category)}">${esc(ev.category)}</span>` : ""}${esc(ev.title)}</h4>
        </div>
        <p class="event-info">🕖 ${esc(ev.time)} · 📍 ${esc(ev.place)}${ev.note ? ` · ${esc(ev.note)}` : ""}${ev.updatedAt ? ` <span class="muted">(수정됨)</span>` : ""}</p>
        ${attendHtml}
        ${manageHtml}
      </div>
    </article>
  `;
}

/* 일정에 실제로 쓰인 카테고리로 필터 칩 표시 */
function renderEventCatFilter() {
  const box = $("eventCatFilter");
  const used = [...new Set(state.events.map((ev) => ev.category).filter(Boolean))]
    .sort((a, b) => {
      const ia = state.eventCats.indexOf(a), ib = state.eventCats.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  if (eventCatFilter !== "all" && !used.includes(eventCatFilter)) setEventCatFilter("all");
  box.hidden = used.length === 0;
  box.innerHTML = used.length === 0 ? "" : [
    `<button type="button" class="cat-chip${eventCatFilter === "all" ? " active" : ""}" data-cat="all">전체</button>`,
    ...used.map((c) => `
      <button type="button" class="cat-chip${eventCatFilter === c ? " active" : ""}" data-cat="${esc(c)}">
        <span class="cat-dot" style="background:${catColor(c)}"></span>${esc(c)}
      </button>`),
  ].join("");
}

$("eventCatFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".cat-chip");
  if (!btn) return;
  setEventCatFilter(btn.dataset.cat);
  renderEvents();
});

export function renderEvents() {
  renderEventCatFilter();
  const today = todayStr();
  const source = eventCatFilter === "all"
    ? state.events
    : state.events.filter((ev) => ev.category === eventCatFilter);
  const upcoming = source.filter((ev) => ev.date >= today);
  const past = source.filter((ev) => ev.date < today).reverse(); // 최근 것부터

  // 재렌더링 후에도 펼쳐둔 '참석자 관리'는 그대로 유지
  const openAtt = new Set(
    [...document.querySelectorAll("#ev-list details.att-manage[open]")].map((d) => d.dataset.id)
  );

  $("eventUpcoming").innerHTML = upcoming.length
    ? upcoming.map((ev) => eventCardHtml(ev, false, openAtt)).join("")
    : `<p class="empty-note">예정된 일정이 없습니다.${isAdmin ? " 위의 '일정 만들기'로 등록해 보세요!" : ""}</p>`;

  $("eventPast").innerHTML = past.length
    ? past.slice(0, 20).map((ev) => eventCardHtml(ev, true, openAtt)).join("")
    : `<p class="empty-note">지난 일정이 없습니다.</p>`;
}

async function handleEventClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;

  try {
    if (action === "rsvp") {
      const current = state.attendance[id] && me ? state.attendance[id][me.uid] : null;
      const status = btn.dataset.status;
      const ref = doc(db, "events", id, "attendance", me.uid);
      if (current && current.status === status) {
        // 같은 버튼 다시 누르면 취소
        if (status === "yes" && current.dist &&
            !confirm("참석을 취소하면 입력한 기록도 함께 삭제돼요. 취소할까요?")) return;
        await deleteDoc(ref);
      } else {
        // merge: 이미 입력해 둔 거리·시간 기록은 지우지 않음
        await setDoc(ref, { name: myProfile.name, status, at: serverTimestamp() }, { merge: true });
      }
    } else if (action === "del-event" && confirm("이 일정을 삭제할까요? (출석 기록도 함께 사라져요)")) {
      await deleteDoc(doc(db, "events", id));
    } else if (action === "edit-event") {
      const ev = state.events.find((x) => x.id === id);
      if (!ev) return;
      editEventId = id;
      $("editEventTitle").value = ev.title || "";
      $("editEventCatRow").innerHTML = catPillsHtml("editEventCat", ev.category || "");
      $("editEventDate").value = ev.date || "";
      $("editEventTime").value = ev.time || "";
      $("editEventPlace").value = ev.place || "";
      $("editEventNote").value = ev.note || "";
      $("editEventMsg").hidden = true;
      openModal("editEventModal");
    } else if (action === "load-past-att") {
      const qs = await getDocs(collection(db, "events", id, "attendance"));
      const yes = qs.docs.map((d) => d.data()).filter((v) => v.status === "yes");
      const target = $(`pastAtt-${id}`);
      if (target) {
        target.innerHTML = yes.length
          ? `<span class="leaf">참석 ${yes.length}명</span> · ${yes.map((v) => esc(v.name)).join(", ")}`
          : "출석 기록이 없어요.";
      }
      btn.remove();
    }
  } catch (err) {
    alert("처리에 실패했어요: " + err.message);
  }
}

$("eventUpcoming").addEventListener("click", handleEventClick);
$("eventPast").addEventListener("click", handleEventClick);

/* 운영진: 참석자 체크박스로 출석 수정 (일정 카드 + 출석 현황 패널 공용) */
$("tab-events").addEventListener("change", async (e) => {
  const cb = e.target.closest("input[data-attuid]");
  if (!cb || !isAdmin) return;
  const evId = cb.dataset.eventid;
  const uid = cb.dataset.attuid;
  const prev = attOf(evId)[uid];
  const name = state.members.find((m) => m.id === uid)?.name || (prev && prev.name) || "?";

  try {
    if (cb.checked) {
      await setDoc(doc(db, "events", evId, "attendance", uid),
        { name, status: "yes", at: serverTimestamp() }, { merge: true });
      if (!state.attendance[evId]) {
        monthAtt[evId] = { ...(monthAtt[evId] || {}), [uid]: { ...(prev || {}), name, status: "yes" } };
      }
    } else {
      if (prev && prev.dist &&
          !confirm("기록이 입력된 참석자예요. 참석을 취소하면 기록도 삭제돼요. 계속할까요?")) {
        cb.checked = true;
        return;
      }
      await deleteDoc(doc(db, "events", evId, "attendance", uid));
      if (!state.attendance[evId] && monthAtt[evId]) delete monthAtt[evId][uid];
    }
    // 실시간 구독이 없는 지난 일정은 화면을 직접 갱신 (구독 중이면 스냅샷이 갱신)
    if (!state.attendance[evId]) {
      renderEvents();
      renderStatsIfLoaded();
    }
  } catch (err) {
    cb.checked = !cb.checked;
    alert("출석 수정에 실패했어요: " + err.message);
  }
});

/* '참석자 관리' 펼침: 아직 안 읽어온 지난 일정의 출석을 가져와 채움 */
$("tab-events").addEventListener("click", async (e) => {
  const sum = e.target.closest("details.att-manage > summary");
  if (!sum) return;
  const det = sum.closest("details.att-manage");
  const evId = det.dataset.id;
  if (state.attendance[evId] || monthAtt[evId]) return;
  try {
    const qs = await getDocs(collection(db, "events", evId, "attendance"));
    const map = {};
    qs.docs.forEach((d) => (map[d.id] = d.data()));
    monthAtt[evId] = map;
    const box = det.querySelector(".att-checks");
    if (box) box.innerHTML = attCheckListHtml(evId);
  } catch (err) {
    console.error("출석 데이터 로딩 실패:", err);
  }
});

let editEventId = null;

$("editEventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!editEventId) return;
  try {
    await updateDoc(doc(db, "events", editEventId), {
      title: $("editEventTitle").value.trim(),
      category: $("editEventCatRow").querySelector("input:checked")?.value || "",
      date: $("editEventDate").value,
      time: $("editEventTime").value,
      place: $("editEventPlace").value.trim(),
      note: $("editEventNote").value.trim(),
      updatedAt: serverTimestamp(),
    });
    closeModal("editEventModal");
  } catch (err) {
    showFormMsg("editEventMsg", "수정에 실패했어요: " + err.message, "error");
  }
});

/* ============================================================
   출석 데이터 공통 (출석 현황 · 이달의 기록)
   ------------------------------------------------------------
   기록은 events/{id}/attendance/{uid} 문서에 저장.
   다가오는 일정은 실시간 구독(state.attendance), 지난 일정은
   필요할 때 한 번 읽어 monthAtt 에 캐시.
   ============================================================ */
function attOf(evId) {
  return state.attendance[evId] || monthAtt[evId] || {};
}

function monthEvents(key) {
  return state.events.filter((ev) => (ev.date || "").slice(0, 7) === key);
}

function crewMembers() {
  return state.members
    .filter((m) => m.role === "member" || m.role === "admin")
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
}

export function renderStatsIfLoaded() {
  if (!statMonth || !monthLoaded.has(statMonth)) return;
  renderAttMatrix();
  renderMileage();
}

/* 보고 있는 달의 출석 데이터 확보 후 매트릭스·기록 렌더 */
export async function ensureMonthData() {
  if (!statMonth) setStatMonth(thisMonthKey());
  document.querySelectorAll(".stat-month-label").forEach((el) =>
    (el.textContent = monthLabel(statMonth)));

  const need = monthEvents(statMonth).filter(
    (ev) => !state.attendance[ev.id] && !monthAtt[ev.id]);
  if (need.length) {
    $("attMatrix").innerHTML = `<p class="empty-note">출석 현황을 불러오는 중...</p>`;
    try {
      await Promise.all(need.map(async (ev) => {
        const qs = await getDocs(collection(db, "events", ev.id, "attendance"));
        const map = {};
        qs.docs.forEach((d) => (map[d.id] = d.data()));
        monthAtt[ev.id] = map;
      }));
    } catch (err) {
      console.error("출석 데이터 로딩 실패:", err);
    }
  }
  monthLoaded.add(statMonth);
  renderAttMatrix();
  renderMileage();
}

/* 출석 현황·이달의 기록 공용 월 이동 */
$("tab-events").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mnav]");
  if (!btn) return;
  setStatMonth(shiftMonth(statMonth || thisMonthKey(), Number(btn.dataset.mnav)));
  ensureMonthData();
});

/* ============================================================
   서브탭 2: 출석 현황 (정기런만 출첵으로 집계)
   ============================================================ */
/* 해당 달의 정기런: 한 줄 날짜 칩 → 누른 날짜만 아래 패널 하나에 표시 */
function renderAttChips() {
  const key = statMonth || thisMonthKey();
  const evs = monthEvents(key).filter((ev) => ev.category === ATT_CAT);

  if (attDayId && !evs.some((ev) => ev.id === attDayId)) setAttDayId(null);

  $("attChips").innerHTML = evs.map((ev) => {
    const yes = Object.values(attOf(ev.id)).filter((a) => a.status === "yes").length;
    const [, m, d] = ev.date.split("-").map(Number);
    const dp = parseDateParts(ev.date);
    return `<button type="button" class="ev-chip${ev.id === attDayId ? " active" : ""}" data-attday="${ev.id}">${m}/${d}(${dp.dow.charAt(0)}) : ${yes}</button>`;
  }).join("");

  renderAttDayPanel();
}

function renderAttDayPanel() {
  const panel = $("attDayPanel");
  const ev = state.events.find((x) => x.id === attDayId);
  if (!ev) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const yes = Object.entries(attOf(ev.id)).filter(([, a]) => a.status === "yes");
  const [, m, d] = ev.date.split("-").map(Number);
  const dp = parseDateParts(ev.date);
  panel.hidden = false;
  panel.innerHTML = `
  <div class="app-card att-day-panel">
    <div class="ael-line">
      <span class="ael-date">${m}/${d}(${dp.dow.charAt(0)})</span>
      <span class="ael-cnt">참석 ${yes.length}</span>
      <span class="ael-names">${esc(ev.title)}</span>
    </div>
    ${isAdmin
      ? `<div class="att-checks">${attCheckListHtml(ev.id)}</div>`
      : `<p class="attend-names">${yes.length ? yes.map(([, a]) => esc(a.name || "?")).join(", ") : "아직 참석자가 없어요."}</p>`}
  </div>`;
}

$("attChips").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-attday]");
  if (!chip) return;
  // 같은 칩을 다시 누르면 패널 닫기
  setAttDayId(attDayId === chip.dataset.attday ? null : chip.dataset.attday);
  renderAttChips();
});

function renderAttMatrix() {
  const key = statMonth || thisMonthKey();
  renderAttChips();
  const evs = monthEvents(key).filter((ev) => ev.category === ATT_CAT);
  const members = crewMembers();
  const box = $("attMatrix");

  if (!evs.length || !members.length) {
    $("attSummary").innerHTML = "";
    box.innerHTML = `<p class="empty-note">${monthLabel(key)}에는 정기런 일정이 없습니다.</p>`;
    return;
  }

  let totalYes = 0;
  const rows = members.map((m) => {
    const cells = evs.map((ev) => {
      const a = attOf(ev.id)[m.id];
      const yes = !!(a && a.status === "yes");
      if (yes) totalYes++;
      return yes;
    });
    return { m, cells, sum: cells.filter(Boolean).length };
  });

  const rate = Math.round((totalYes / (members.length * evs.length)) * 100);
  $("attSummary").innerHTML = `
    <span class="sum-chip">정기런 <b>${evs.length}회</b></span>
    <span class="sum-chip">총 참석수 <b>${totalYes}명</b></span>
    <span class="sum-chip">평균 출석률 <b>${rate}%</b></span>`;

  box.innerHTML = `
  <div class="mtx-scroll">
    <table class="mtx">
      <thead><tr>
        <th class="nm">이름</th>
        ${evs.map((ev) => {
          const [, m, d] = ev.date.split("-").map(Number);
          const dp = parseDateParts(ev.date);
          return `<th>${m}/${d}<span class="dd">${dp.dow.charAt(0)}</span></th>`;
        }).join("")}
        <th class="sum">출석</th>
      </tr></thead>
      <tbody>
        ${rows.map(({ m, cells, sum }) => `
        <tr${me && m.id === me.uid ? ' class="me-row"' : ""}>
          <td class="nm">${esc(m.name)}</td>
          ${cells.map((y) => `<td>${y ? '<span class="stamp">🥕</span>' : '<span class="miss">–</span>'}</td>`).join("")}
          <td class="sum">${sum}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}

/* ============================================================
   서브탭 3: 이달의 기록 (월별 마일리지 보드 + 메달 랭킹)
   ------------------------------------------------------------
   각자 '오늘의 마일리지'를 저장하면 그 달의 누적에 더해짐.
   목표·누적 마일리지는 본인(운영진은 모두) 수정 가능.
   메달은 출석(정기런) 많은 순, 같으면 누적 km 많은 순.
   데이터: mileage/{uid} = { name, goal(목표km), months: { "2026-07": km } }
   ============================================================ */
/* 해당 달의 정기런 출석 횟수 (출석 현황과 같은 기준) */
function monthAttCount(key, uid) {
  return monthEvents(key)
    .filter((ev) => ev.category === ATT_CAT)
    .filter((ev) => attOf(ev.id)[uid]?.status === "yes").length;
}

export function renderMileage() {
  // 입력 중일 때는 실시간 갱신으로 입력값이 지워지지 않도록 잠시 보류
  if (document.activeElement && document.activeElement.id === "myRecDist") return;

  // 오늘의 마일리지 입력 박스 (보고 있는 달과 무관하게 오늘 날짜의 달에 누적)
  const t = new Date();
  $("myRecordBox").innerHTML = `
  <div class="my-record">
    <p class="mr-title">🥕 오늘의 마일리지! ${t.getMonth() + 1}월 ${t.getDate()}일</p>
    <div class="mr-form">
      <input type="text" id="myRecDist" inputmode="decimal" placeholder="5.0" aria-label="오늘 뛴 거리(km)" /><span class="unit">km</span>
      <button type="button" class="btn-save" id="btnSaveMyRec">저장</button>
    </div>
    <p class="mr-pace">저장하면 마일리지가 누적되어요!</p>
  </div>`;

  // 월별 표: 이름 | 출석 | 목표 | 누적 — 출석 많은 순, 같으면 누적 많은 순
  const key = statMonth || thisMonthKey();
  const rows = crewMembers()
    .map((m) => {
      const r = state.mileage[m.id] || {};
      return { m, goal: r.goal || 0, km: (r.months && r.months[key]) || 0, att: monthAttCount(key, m.id) };
    })
    .sort((a, b) => b.att - a.att || b.km - a.km);

  if (!rows.length) {
    $("recTable").innerHTML = `<p class="empty-note">아직 크루원이 없습니다.</p>`;
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  $("recTable").innerHTML = `
  <article class="app-card rec-card">
    <table class="rec mileage">
      <thead><tr><th>이름</th><th>출석</th><th>목표 (km)</th><th>누적 (km)</th></tr></thead>
      <tbody>
        ${rows.map(({ m, goal, km, att }, i) => {
          const canEdit = isAdmin || (me && m.id === me.uid);
          const medal = medals[i] && (att > 0 || km > 0) ? `<span class="rank-medal">${medals[i]}</span>` : "";
          return `
          <tr${me && m.id === me.uid ? ' class="me-row"' : ""}>
            <td>${medal}${esc(m.name)}${canEdit ? ` <button type="button" class="btn-edit-rec" data-mileedit="${m.id}" title="목표·누적 마일리지 수정">✏️</button>` : ""}</td>
            <td>${att ? `${att}회` : '<span class="none">–</span>'}</td>
            <td>${goal ? Math.round(goal * 10) / 10 : '<span class="none">–</span>'}</td>
            <td><b>${km ? Math.round(km * 10) / 10 : 0}</b></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </article>`;
}

/* 오늘의 마일리지 저장(누적) + ✏️ 수정 모달 열기 */
$("ev-rec").addEventListener("click", async (e) => {
  if (e.target.closest("#btnSaveMyRec")) {
    if (!me || !myProfile) return;
    const dist = Math.round(parseFloat($("myRecDist").value) * 100) / 100;
    if (!(dist > 0) || dist > 300) return alert("거리(km)를 확인해 주세요. (예: 5.2)");
    try {
      await setDoc(doc(db, "mileage", me.uid), {
        name: myProfile.name,
        months: { [thisMonthKey()]: increment(dist) },
        updatedAt: serverTimestamp(),
      }, { merge: true });
      $("myRecDist").value = "";
      alert(`+${dist}km 누적! 오늘도 잘 달렸어요 🥕`);
    } catch (err) {
      alert("저장에 실패했어요: " + err.message);
    }
    return;
  }
  const editBtn = e.target.closest("[data-mileedit]");
  if (editBtn) openMileageModal(editBtn.dataset.mileedit);
});

let mileageUid = null;

function openMileageModal(uid) {
  const m = state.members.find((x) => x.id === uid);
  if (!m) return;
  mileageUid = uid;
  const key = statMonth || thisMonthKey();
  const r = state.mileage[uid] || {};
  const km = (r.months && r.months[key]) || 0;
  $("mileageWho").textContent = `${m.name}님의 목표 · ${monthLabel(key)} 누적 마일리지를 수정합니다.`;
  $("mileGoal").value = r.goal ? Math.round(r.goal * 10) / 10 : "";
  $("mileKm").value = km ? Math.round(km * 10) / 10 : "";
  $("mileageMsg").hidden = true;
  openModal("mileageModal");
}

$("mileageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!mileageUid) return;
  const m = state.members.find((x) => x.id === mileageUid);
  const goal = $("mileGoal").value.trim() === "" ? 0 : parseFloat($("mileGoal").value);
  const km = $("mileKm").value.trim() === "" ? 0 : parseFloat($("mileKm").value);
  if (!(goal >= 0) || goal > 10000) return showFormMsg("mileageMsg", "목표 마일리지(km)를 확인해 주세요.", "error");
  if (!(km >= 0) || km > 10000) return showFormMsg("mileageMsg", "누적 마일리지(km)를 확인해 주세요.", "error");
  try {
    await setDoc(doc(db, "mileage", mileageUid), {
      name: m ? m.name : "?",
      goal: Math.round(goal * 10) / 10,
      months: { [statMonth || thisMonthKey()]: Math.round(km * 10) / 10 },
      updatedAt: serverTimestamp(),
    }, { merge: true });
    closeModal("mileageModal");
  } catch (err) {
    showFormMsg("mileageMsg", "저장에 실패했어요: " + err.message, "error");
  }
});
