/* ============================================================
   pages/app/home.js — 홈 (대시보드)
   ------------------------------------------------------------
   카테고리별 D-day 카드 · 고정 공지 배너 · 2주 일정 · 진행 중 투표
   (각 항목의 data-goto 클릭 이동은 init.js 의 위임 핸들러가 처리)
   ============================================================ */
import { $ } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
import { esc, DOW, todayStr, dday, addDaysStr, parseDateParts, catColor, catBadgeStyle, shadeColor } from "../../lib/format.js";
import { state, myProfile } from "./state.js";

export function renderHome() {
  if (!myProfile) return;
  $("dashHello").innerHTML =
    `${esc(myProfile.name)}님, 반가워요! <span class="muted">오늘도 가볍게 달려요.</span>`;

  const today = todayStr();

  // 카테고리별 가장 가까운 예정 일정 → D-day 카드 (최대 4장, 같은 크기)
  const nearest = new Map();
  state.events.filter((ev) => ev.date >= today).forEach((ev) => {
    const cat = ev.category || "일정";
    if (!nearest.has(cat)) nearest.set(cat, ev); // 날짜 오름차순 구독이라 첫 번째가 가장 가까움
  });
  const cards = [...nearest.values()].slice(0, 4);
  $("ddayRow").innerHTML = cards.length ? cards.map((ev) => {
    const cat = ev.category || "일정";
    const c = catColor(cat);
    const d = dday(ev.date);
    const dp = parseDateParts(ev.date);
    return `
    <article class="dday-card" data-goto="events" style="background:linear-gradient(150deg, ${shadeColor(c, 0.95)}, ${shadeColor(c, 0.7)})">
      <span class="cat-name">${esc(cat)}</span>
      <div class="dday-num">${d <= 0 ? "D-DAY" : `D-${d}`}</div>
      <div class="dday-title">${esc(ev.title)}</div>
      <div class="dday-meta">${ic("calendar")} ${dp.month} ${dp.day}일(${dp.dow.charAt(0)}) ${esc(ev.time)}<br />${ic("pin")} ${esc(ev.place)}</div>
    </article>`;
  }).join("") : `<p class="empty-note">예정된 일정이 없습니다.</p>`;

  // 고정 공지 배너 (가장 최근 고정 글)
  const pinned = state.notices.find((n) => n.pinned);
  const banner = $("dashNotice");
  banner.hidden = !pinned;
  if (pinned) banner.innerHTML = `${ic("pushpin")} <strong>${esc(pinned.title)}</strong><span class="go">›</span>`;

  // 다가오는 일정 (오늘~2주)
  const limit = addDaysStr(14);
  const near = state.events.filter((ev) => ev.date >= today && ev.date <= limit).slice(0, 6);
  $("dashSched").innerHTML = near.length ? near.map((ev) => {
    const [y, m, d] = ev.date.split("-").map(Number);
    const dowIdx = new Date(y, m - 1, d).getDay();
    const dowCls = dowIdx === 6 ? "sat" : dowIdx === 0 ? "sun" : "";
    return `
    <div class="sched-row" data-goto="events" role="button">
      <div class="sched-date"><div class="d">${m}/${d}</div><div class="w ${dowCls}">${DOW[dowIdx]}</div></div>
      <div class="sched-body">
        <div class="t">${ev.category ? `<span class="event-cat" style="${catBadgeStyle(ev.category)}">${esc(ev.category)}</span>` : ""}${esc(ev.title)}</div>
        <div class="m">${ic("clock")} ${esc(ev.time)} · ${ic("pin")} ${esc(ev.place)}</div>
      </div>
    </div>`;
  }).join("") : `<p class="empty-note">2주 안에 예정된 일정이 없어요.</p>`;

  // 진행 중인 투표 (가장 최근 것 하나)
  const open = state.polls.find((p) => !p.closed);
  if (open) {
    const total = Object.keys(state.votes[open.id] || {}).length;
    $("dashPoll").innerHTML = `
    <article class="app-card dash-poll" data-goto="news:poll" role="button">
      <p class="poll-q">${ic("vote")} ${esc(open.question)}</p>
      <p class="poll-meta">지금까지 ${total}명 참여 · 눌러서 참여하기 ›</p>
    </article>`;
  } else {
    $("dashPoll").innerHTML = `<p class="empty-note">진행 중인 투표가 없습니다.</p>`;
  }
}
