/* ============================================================
   pages/admin/stats.js — 관리 '통계' 탭 (운영진 전용)
   ------------------------------------------------------------
   현재 데이터로 계산 가능한 4가지:
     1) 크루 성장       — 월별 신규 가입(↑) · 탈퇴(↓)  (members.createdAt/removedAt)
     2) 멤버 구성       — 성별·연령대·경력·지역        (members 가입정보)
     3) 출석률 추이     — 정기런 events + attendance (월별)
     4) 개근왕·출석랭킹 — 정기런 attendance 누적 + 연속

   ★ 기간 · 읽기 비용/로딩 설계
   - 통계 탭을 '처음 열 때만' 로드하고 UI 를 유지 (탭 재방문 시 재요청·재렌더 없음)
   - members·events 는 각각 한 번의 목록 읽기
   - 성장·추이·랭킹은 '카드마다' [기간 선택] 버튼으로 시작월~끝월을 독립 설정 (기본: 최근 6개월)
   - 출석은 선택 기간의 정기런 중 '아직 안 읽은 회차만' 증분 로드(8개씩) →
     한 번 읽은 회차는 attCache 에 남아 다시 읽지 않음 (추이·랭킹이 캐시 공유)
   - 시계열 막대는 마지막 달(대개 현재 달)이 보이도록 오른쪽 끝으로 스크롤
   ============================================================ */
import { $ } from "../../lib/ui.js";
import { ic } from "../../lib/icons.js";
import { esc, todayStr } from "../../lib/format.js";
import { isSystemAccount } from "../../lib/account.js";

const ATT_CAT = "정기런";        // 출석으로 집계하는 카테고리 (state.js 와 동일)
const DEFAULT_MONTHS = 6;        // 기본 기간 (개월)

/* ---------- 세션 캐시 ---------- */
let dataLoaded = false;          // 최초 로드 완료 여부 (탭 재방문 시 재요청 방지)
let bound = false;               // 클릭 리스너 중복 바인딩 방지
let db, collection, getDocs;     // firebase (탭 열 때 동적 로드)
let systemUids = new Set();      // 운영용 계정 uid (집계 제외)
let members = [];                // 크루 멤버(시스템 제외, 모든 role)
let activeCrew = [];             // 활동 크루원 (member·admin)
let events = [];                 // 전체 일정
let attCache = {};               // eventId → { uid: {status,...} }  (한 번 읽으면 유지)

/* 카드별 조회 기간 ("YYYY-MM") — 각자 독립 */
const ranges = {
  growth: { start: "", end: "" },
  trend: { start: "", end: "" },
  rank: { start: "", end: "" },
};

/* ============================================================
   진입점 — 통계 탭을 처음 열 때 1회 호출 (이후 클릭은 무시)
   ============================================================ */
export async function initStats() {
  const root = $("statsRoot");
  if (!root || dataLoaded) return; // 이미 그려졌으면 그대로 유지 (재로딩·새로고침 없음)
  root.innerHTML = `<p class="empty-note">통계를 불러오는 중...</p>`;

  try {
    const fb = await import("../../lib/firebase.js");
    ({ db, collection, getDocs } = fb);

    const [msnap, esnap] = await Promise.all([
      getDocs(collection(db, "members")),
      getDocs(collection(db, "events")),
    ]);
    const raw = msnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    systemUids = new Set(raw.filter((m) => isSystemAccount(m.email)).map((m) => m.id));
    members = raw.filter((m) => !systemUids.has(m.id));
    activeCrew = members.filter((m) => m.role === "member" || m.role === "admin");
    events = esnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const def = defaultRange();
    ranges.growth = { ...def };
    ranges.trend = { ...def };
    ranges.rank = { ...def };

    root.innerHTML = shellHtml();
    if (!bound) { root.addEventListener("click", onClick); bound = true; }
    dataLoaded = true; // 데이터 확보 완료 — 렌더가 실패해도 재로딩하지 않음

    ["growth", "trend", "rank"].forEach(updateRangeLabel);
    renderGrowth();       // 1
    renderDemographics(); // 2
    await loadAttendance(ranges.trend);
    renderAttendTrend();  // 3
    await loadAttendance(ranges.rank);
    renderRank();         // 4
  } catch (err) {
    dataLoaded = false;   // 데이터를 못 받았으면 다시 열 때 재시도
    root.innerHTML = `<p class="empty-note">통계를 불러오지 못했어요: ${esc(err.message || String(err))}</p>`;
  }
}

/* ============================================================
   레이아웃 — 시계열 카드마다 [기간 선택] 버튼 + 월 선택
   ============================================================ */
function periodBtn(scope) {
  return `<button type="button" class="btn-mini dark stat-period-btn" data-scope="${scope}">기간 선택</button>`;
}

function periodPick(scope) {
  const c = currentMonthKey();
  return `<div class="stat-period-pick" data-pick="${scope}" hidden>
      <label>시작 달<input type="month" data-from="${scope}" max="${c}" /></label>
      <label>끝 달<input type="month" data-to="${scope}" max="${c}" /></label>
      <button type="button" class="btn-mini leaf" data-apply="${scope}">적용</button>
    </div>`;
}

function shellHtml() {
  return `
  <div class="stat-card">
    <div class="stat-card-head"><h4>${ic("users")} 크루 성장</h4>${periodBtn("growth")}</div>
    <p class="stat-range" data-rangelabel="growth"></p>
    ${periodPick("growth")}
    <div id="statGrowthBody"></div>
  </div>
  <div class="stat-card">
    <h4>${ic("users")} 멤버 구성</h4>
    <div id="statDemoBody"></div>
  </div>
  <div class="stat-card">
    <div class="stat-card-head"><h4>${ic("flag")} 출석률 추이 <span class="muted">(정기런)</span></h4>${periodBtn("trend")}</div>
    <p class="stat-range" data-rangelabel="trend"></p>
    ${periodPick("trend")}
    <div id="statAttendBody"></div>
  </div>
  <div class="stat-card">
    <div class="stat-card-head"><h4>${ic("crown")} 개근왕 · 출석 랭킹</h4>${periodBtn("rank")}</div>
    <p class="stat-range" data-rangelabel="rank"></p>
    ${periodPick("rank")}
    <div id="statRankBody"></div>
  </div>`;
}

function onClick(e) {
  const openBtn = e.target.closest(".stat-period-btn");
  if (openBtn) { togglePick(openBtn.dataset.scope); return; }
  const applyBtn = e.target.closest("[data-apply]");
  if (applyBtn) applyScope(applyBtn.dataset.apply);
}

function togglePick(scope) {
  const p = document.querySelector(`[data-pick="${scope}"]`);
  if (!p) return;
  const show = p.hidden;
  if (show) {
    document.querySelector(`[data-from="${scope}"]`).value = ranges[scope].start;
    document.querySelector(`[data-to="${scope}"]`).value = ranges[scope].end;
  }
  p.hidden = !show;
}

async function applyScope(scope) {
  const from = document.querySelector(`[data-from="${scope}"]`)?.value;
  const to = document.querySelector(`[data-to="${scope}"]`)?.value;
  if (!from || !to) return;
  let [s, e] = from > to ? [to, from] : [from, to]; // 순서 바뀌면 교정
  const cur = currentMonthKey();
  if (e > cur) e = cur;                             // 미래 달은 현재 달까지로
  ranges[scope] = { start: s, end: e };
  document.querySelector(`[data-pick="${scope}"]`).hidden = true;
  updateRangeLabel(scope);

  if (scope === "growth") {
    renderGrowth();
  } else if (scope === "trend") {
    setLoading("statAttendBody");
    await loadAttendance(ranges.trend);
    renderAttendTrend();
  } else if (scope === "rank") {
    setLoading("statRankBody");
    await loadAttendance(ranges.rank);
    renderRank();
  }
}

function setLoading(id) {
  const el = $(id);
  if (el) el.innerHTML = `<p class="empty-note">불러오는 중...</p>`;
}

function updateRangeLabel(scope) {
  const el = document.querySelector(`[data-rangelabel="${scope}"]`);
  if (el) el.textContent = rangeLabel(ranges[scope]) + (scope === "rank" ? " 랭킹" : "");
}

/* ============================================================
   1) 크루 성장 — 월별 가입(↑) / 탈퇴(↓)
   ============================================================ */
function renderGrowth() {
  const box = $("statGrowthBody");
  const months = monthRange(ranges.growth.start, ranges.growth.end);
  const join = Object.fromEntries(months.map((k) => [k, 0]));
  const leave = Object.fromEntries(months.map((k) => [k, 0]));

  members.forEach((m) => {
    // 가입: 실제로 크루가 된 사람(현재 멤버·운영진·내보낸 사람)의 가입월
    if (m.role === "member" || m.role === "admin" || m.role === "removed") {
      const jk = tsMonthKey(m.createdAt);
      if (jk && jk in join) join[jk]++;
    }
    // 탈퇴: 내보내기(removed) 처리된 달
    if (m.role === "removed") {
      const lk = tsMonthKey(m.removedAt);
      if (lk && lk in leave) leave[lk]++;
    }
  });

  const totJoin = months.reduce((s, k) => s + join[k], 0);
  const totLeave = months.reduce((s, k) => s + leave[k], 0);

  const cnt = { member: 0, admin: 0 };
  members.forEach((m) => { if (m.role in cnt) cnt[m.role]++; });
  const active = cnt.member + cnt.admin;

  box.innerHTML = `
    <div class="stat-nums">
      <div class="stat-num"><b>${active}</b><span>활동 크루원</span></div>
      <div class="stat-num up"><b>+${totJoin}</b><span>기간 내 가입</span></div>
      <div class="stat-num down"><b>-${totLeave}</b><span>기간 내 탈퇴</span></div>
    </div>
    ${divBars(months.map((k) => ({ label: mLabel(k), up: join[k], down: leave[k] })))}`;
  scrollEnd("#statGrowthBody .dbars");
}

/* ============================================================
   2) 멤버 구성 — 성별·연령대·경력·지역 분포
   ============================================================ */
function renderDemographics() {
  const box = $("statDemoBody");
  const crew = activeCrew;
  if (!crew.length) { box.innerHTML = `<p class="empty-note">활동 크루원이 없어요.</p>`; return; }

  const AGE = ["10대", "20대", "30대", "40대", "50대 이상"];
  const CAREER = ["입문 (이제 시작해요)", "초급 (5km)", "중급 (10km~하프)", "상급 (풀코스)"];

  const dist = (field, order) => {
    const c = {};
    crew.forEach((m) => {
      const v = (m[field] || "").trim() || "미입력";
      c[v] = (c[v] || 0) + 1;
    });
    let arr = Object.entries(c).map(([label, value]) => ({ label, value }));
    if (order) {
      const rank = (l) => { const i = order.indexOf(l); return i === -1 ? order.length + (l === "미입력" ? 1 : 0) : i; };
      arr.sort((a, b) => rank(a.label) - rank(b.label));
    } else {
      arr.sort((a, b) => b.value - a.value);
    }
    return arr;
  };

  box.innerHTML = `
    <div class="demo-grid">
      <div class="demo-cell"><h5>성별</h5>${hBars(dist("gender"))}</div>
      <div class="demo-cell"><h5>연령대</h5>${hBars(dist("ageGroup", AGE))}</div>
      <div class="demo-cell"><h5>대회 경력</h5>${hBars(dist("career", CAREER))}</div>
    </div>
    <p class="stat-note">활동 크루원 ${crew.length}명 기준 · 가입 신청서 정보</p>`;
}

/* ============================================================
   3·4) 출석 — 로드 + 렌더
   ============================================================ */
/* 기간 안의 과거(오늘 포함) 정기런 일정 */
function rangeEvents(range) {
  const today = todayStr();
  const startD = `${range.start}-01`;
  const endEx = monthStartAfter(range.end);
  return events.filter((e) =>
    e.category === ATT_CAT && e.date && e.date >= startD && e.date < endEx && e.date <= today);
}

/* 기간에 필요한 회차 중 '아직 안 읽은 것만' 증분 로드 (8개씩) */
async function loadAttendance(range) {
  const need = rangeEvents(range).filter((e) => !attCache[e.id]);
  const SIZE = 8;
  for (let i = 0; i < need.length; i += SIZE) {
    const chunk = need.slice(i, i + SIZE);
    await Promise.all(chunk.map(async (e) => {
      try {
        const qs = await getDocs(collection(db, "events", e.id, "attendance"));
        const map = {};
        qs.docs.forEach((d) => { if (!systemUids.has(d.id)) map[d.id] = d.data(); });
        attCache[e.id] = map;
      } catch (err) {
        console.error("출석 로딩 실패:", e.id, err);
        attCache[e.id] = {};
      }
    }));
  }
}

function yesCount(evId) {
  return Object.values(attCache[evId] || {}).filter((a) => a && a.status === "yes").length;
}

function renderAttendTrend() {
  const box = $("statAttendBody");
  const evs = rangeEvents(ranges.trend);
  const months = monthRange(ranges.trend.start, ranges.trend.end);

  const g = Object.fromEntries(months.map((k) => [k, { ev: 0, att: 0 }]));
  evs.forEach((e) => {
    const k = e.date.slice(0, 7);
    if (!(k in g)) g[k] = { ev: 0, att: 0 };
    g[k].ev++;
    g[k].att += yesCount(e.id);
  });

  const crew = activeCrew.length || 1;
  const bars = months.map((k) => {
    const { ev, att } = g[k] || { ev: 0, att: 0 };
    const avg = ev ? att / ev : 0;
    return { label: mLabel(k), value: Math.round(avg * 10) / 10, sub: ev ? `${Math.round(avg / crew * 100)}%` : "" };
  });

  const totEv = evs.length;
  const totAtt = evs.reduce((s, e) => s + yesCount(e.id), 0);
  const avgAll = totEv ? totAtt / totEv : 0;

  box.innerHTML = `
    <p class="stat-kpis">정기런 <b>${totEv}</b>회 · 평균 <b>${Math.round(avgAll * 10) / 10}</b>명 참석 · 평균 참여율 <b>${Math.round(avgAll / crew * 100)}%</b> <span class="muted">(크루원 ${crew}명 기준)</span></p>
    ${vBars(bars)}
    <p class="stat-note">막대 = 월 평균 참석 인원, 아래 %는 참여율. 정기런만 집계돼요.</p>`;
  scrollEnd("#statAttendBody .vbars");
}

function renderRank() {
  const box = $("statRankBody");
  const evs = rangeEvents(ranges.rank).slice().sort((a, b) => b.date.localeCompare(a.date)); // 최신 먼저
  const M = evs.length;
  if (!M) { box.innerHTML = `<p class="empty-note">이 기간에 정기런 일정이 없어요.</p>`; return; }

  const rows = activeCrew.map((m) => {
    let cnt = 0, streak = 0, streakOn = true;
    for (const e of evs) { // 최신순 → 연속 출석 계산
      const yes = attCache[e.id]?.[m.id]?.status === "yes";
      if (yes) cnt++;
      if (streakOn) { if (yes) streak++; else streakOn = false; }
    }
    return { m, cnt, streak, rate: Math.round(cnt / M * 100) };
  })
    .filter((r) => r.cnt > 0)
    .sort((a, b) => b.cnt - a.cnt || b.streak - a.streak || (a.m.name || "").localeCompare(b.m.name || "", "ko"));

  if (!rows.length) { box.innerHTML = `<p class="empty-note">이 기간 출석 기록이 없어요.</p>`; return; }

  const medals = ['<span class="rank-chip r1">1</span>', '<span class="rank-chip r2">2</span>', '<span class="rank-chip r3">3</span>'];
  const perfect = rows.filter((r) => r.cnt === M).length;

  box.innerHTML = `
    <p class="stat-kpis">정기런 <b>${M}</b>회 기준 · 개근 <b>${perfect}</b>명</p>
    <div class="stat-rank-scroll">
      <table class="stat-rank">
        <thead><tr><th>이름</th><th>출석</th><th>출석률</th><th>연속</th></tr></thead>
        <tbody>
          ${rows.slice(0, 20).map((r, i) => `
          <tr>
            <td class="nm">${medals[i] || `<span class="rk">${i + 1}</span>`} ${esc(r.m.name || "?")}${r.cnt === M ? ' <span class="allin">개근</span>' : ""}</td>
            <td><b>${r.cnt}</b><span class="muted">/${M}</span></td>
            <td>${r.rate}%</td>
            <td>${r.streak ? `${r.streak}회` : "–"}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    ${rows.length > 20 ? `<p class="stat-note">참석 상위 20명만 표시</p>` : ""}`;
}

/* ============================================================
   미니 차트 (라이브러리 없음 — CSS 막대)
   ============================================================ */
/* 세로 막대 (시계열) */
function vBars(data) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return `<div class="vbars">${data.map((d) => `
    <div class="vbar">
      <div class="vbar-track"><div class="vbar-fill" style="height:${Math.round(d.value / max * 100)}%"></div></div>
      <div class="vbar-num">${d.value}</div>
      <div class="vbar-lb">${esc(d.label)}</div>
      ${d.sub ? `<div class="vbar-sub">${esc(d.sub)}</div>` : ""}
    </div>`).join("")}</div>`;
}

/* 다이버징 막대 (가입 ↑ / 탈퇴 ↓) */
function divBars(data) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.up, d.down)));
  return `<div class="dbars">${data.map((d) => `
    <div class="dbar">
      <div class="dbar-up"><span class="dbar-fill up" style="height:${Math.round(d.up / max * 100)}%"></span></div>
      <div class="dbar-dn"><span class="dbar-fill down" style="height:${Math.round(d.down / max * 100)}%"></span></div>
      <div class="dbar-nums">
        <span class="up">${d.up ? "+" + d.up : ""}</span>
        <span class="down">${d.down ? "-" + d.down : ""}</span>
      </div>
      <div class="dbar-lb">${esc(d.label)}</div>
    </div>`).join("")}</div>`;
}

/* 가로 막대 (분포) */
function hBars(data) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const max = Math.max(1, ...data.map((d) => d.value));
  return `<div class="hbars">${data.map((d) => {
    const pct = Math.round(d.value / total * 100);
    return `<div class="hbar">
      <span class="hbar-lb">${esc(d.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(3, Math.round(d.value / max * 100))}%"></span></span>
      <span class="hbar-val">${d.value}<em>${pct}%</em></span>
    </div>`;
  }).join("")}</div>`;
}

/* 시계열 막대를 오른쪽 끝(최근 달)으로 스크롤 */
function scrollEnd(sel) {
  requestAnimationFrame(() => {
    const el = document.querySelector(sel);
    if (el) el.scrollLeft = el.scrollWidth;
  });
}

/* ============================================================
   날짜 유틸
   ============================================================ */
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/* 기본 기간: 최근 DEFAULT_MONTHS 개월 (현재 달 포함) */
function defaultRange() {
  const d = new Date();
  const s = new Date(d.getFullYear(), d.getMonth() - (DEFAULT_MONTHS - 1), 1);
  return {
    start: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}`,
    end: currentMonthKey(),
  };
}

/* startKey~endKey ("YYYY-MM") 사이의 월 목록 */
function monthRange(startKey, endKey) {
  let [y, m] = startKey.split("-").map(Number);
  const [ey, em] = endKey.split("-").map(Number);
  const arr = [];
  while (y < ey || (y === ey && m <= em)) {
    arr.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return arr;
}

/* 그 달 다음 달의 1일 "YYYY-MM-01" (기간 끝 포함 필터용) */
function monthStartAfter(key) {
  let [y, m] = key.split("-").map(Number);
  if (++m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/* 조회 기간 라벨 "YYYY년 M월 ~ YYYY년 M월" */
function rangeLabel(range) {
  const [sy, sm] = range.start.split("-").map(Number);
  const [ey, em] = range.end.split("-").map(Number);
  return `${sy}년 ${sm}월 ~ ${ey}년 ${em}월`;
}

/* "YYYY-MM" → "7월" (1월엔 연도 표시 "26.1월") */
function mLabel(key) {
  const [y, m] = key.split("-");
  return m === "01" ? `${y.slice(2)}.1월` : `${Number(m)}월`;
}

/* Firestore Timestamp/Date → "YYYY-MM" (없으면 null) */
function tsMonthKey(ts) {
  const dt = ts && ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : null);
  if (!dt || isNaN(dt)) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}
