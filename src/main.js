// 별무리 마을 공유 카풀 — 화면과 동작
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import { supabase } from './supabase.js';
import { loginWithGoogle, loginWithPassword, logout, onUserChange } from './auth.js';
import { local, session } from './store.js';
import { applyAppInfo } from './app-info.js';
import { PLACES, placeOf } from './places.js';
import * as api from './api.js';

/* ── 상태 ─────────────────────────────────────────────────────────── */
const state = {
  user: null,
  name: local.get('name', ''),
  view: 'home',          // home | new | ride
  kind: 'need',
  rideId: null,
  rides: [],
  filter: 'active',
  detail: null,
  detailSig: '',
  lastListSig: '',
  loading: true,
  error: '',
  sheetOpen: false,
  justCreated: false,
  map: null,
  pin: null,             // { lat, lng }
  watching: null,        // geolocation watch id
  theme: local.get('theme', 'day'),
  tick: 0,
};

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS = {
  open: { label: '모집 중', cls: 'st-open' },
  matched: { label: '매칭 완료', cls: 'st-matched' },
  departed: { label: '이동 중', cls: 'st-departed' },
  arrived: { label: '도착 완료', cls: 'st-arrived' },
  cancelled: { label: '취소됨', cls: 'st-cancelled' },
};
const KIND = {
  need: { label: '태워주세요', emoji: '🙋', cls: 'kind-need' },
  offer: { label: '태워드릴게요', emoji: '🚗', cls: 'kind-offer' },
};

const app = () => document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 날짜·시간 ────────────────────────────────────────────────────── */
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const h = d.getHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]}) ${h < 12 ? '오전' : '오후'} ${hh}:${mm}`;
}
function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const h = d.getHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? '오전' : '오후'} ${hh}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
function todayInput() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}
function toIso(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function pickupInput(iso) {
  const d = iso ? new Date(iso) : new Date(Date.now() + 10 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ── 링크·공유 문구 ───────────────────────────────────────────────── */
const APP_BASE = new URL(import.meta.env.BASE_URL, location.origin).href;
const rideUrl = (id) => `${APP_BASE}?ride=${id}`;
function shareText(ride) {
  const k = KIND[ride.kind];
  const seats = ride.kind === 'need' ? `탑승 ${ride.seats}명` : `빈자리 ${ride.seats}석`;
  const lines = [
    `🚕 [별무리 카풀] ${k.label}`,
    `${ride.from_place} → ${ride.to_place}`,
    `${fmtWhen(ride.depart_at)} · ${seats}`,
  ];
  if (ride.memo) lines.push(ride.memo.length > 60 ? `${ride.memo.slice(0, 60)}…` : ride.memo);
  lines.push(`👉 ${rideUrl(ride.id)}`);
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 카톡 인앱 브라우저 등 클립보드 권한이 없는 경우
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ── 토스트 ───────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 220); }, 2600);
}

/* ── 로그인 ───────────────────────────────────────────────────────── */
function displayName(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  return meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : '이웃');
}

function welcome(user) {
  state.user = user;
  if (user) {
    state.name = state.name || displayName(user);
    if (!local.get('name', '')) local.set('name', state.name);
  }
  const pending = local.get('pending-ride', null);
  if (user && pending) {
    local.remove('pending-ride');
    state.justCreated = false;
    go('ride', pending);
    return;
  }
  render();
  // 로그인 정보가 뒤늦게 들어오면 그때 다시 읽습니다 (처음엔 손님으로 읽었을 수 있어요)
  if (user && state.view === 'ride') loadDetail();
}

/* ── 라우팅 ───────────────────────────────────────────────────────── */
function go(view, rideId = null) {
  state.view = view;
  state.rideId = rideId;
  state.error = '';
  state.detailSig = '';
  state.loading = view === 'ride';
  if (view === 'ride' && rideId !== state.detail?.ride?.id) state.detail = null;
  if (view === 'ride') {
    history.replaceState(null, '', `?ride=${rideId}`);
  } else if (view === 'new') {
    history.replaceState(null, '', `?new=${state.kind}`);
  } else {
    history.replaceState(null, '', location.pathname);
  }
  render();
  if (view === 'ride') loadDetail();
  if (view === 'home') loadList();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ── 데이터 ───────────────────────────────────────────────────────── */
async function loadList() {
  try {
    const rides = await api.listRides({ mine: state.filter === 'mine', userId: state.user?.id ?? null });
    const sig = JSON.stringify(rides);
    const changed = sig !== state.lastListSig;
    state.rides = rides;
    state.error = '';
    state.loading = false;
    // 바뀐 게 없으면 화면을 다시 그리지 않습니다 (누르려는 버튼이 사라지는 일을 막고, 깜빡임도 줄입니다)
    if (changed) { state.lastListSig = sig; render(); }
  } catch (e) {
    state.error = e.message;
    state.loading = false;
    render();
  }
}

async function loadDetail() {
  if (!state.rideId) return;
  try {
    const d = await api.getRide(state.rideId, { signedIn: Boolean(state.user) });
    if (!d) { state.error = '글을 찾을 수 없어요. 링크가 맞는지 확인해 주세요.'; state.detail = null; render(); return; }
    const sig = JSON.stringify([
      d.ride.status, d.ride.pickup_at, d.ride.live_share, d.ride.updated_at,
      d.members.map((m) => [m.id, m.status]),
      d.driver?.updated_at ?? null,
      d.events.map((e) => e.id),
      d.contacts,
    ]);
    const changed = sig !== state.detailSig;
    state.detail = d;
    state.error = '';
    state.loading = false;
    if (changed) { state.detailSig = sig; render(); }
    else renderUserChip();
  } catch (e) {
    state.error = e.message;
    state.loading = false;
    render();
  }
}

/* ── 주기적 새로고침 (실시간에 가깝게) ────────────────────────────── */
let pollTimer = null;
function schedulePoll() {
  clearInterval(pollTimer);
  const every = state.view === 'ride' ? 4000 : 20000;
  pollTimer = setInterval(() => {
    if (document.hidden || state.sheetOpen) return;
    const el = document.activeElement;
    if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    state.tick += 1;
    if (state.view === 'ride') loadDetail();
    else if (state.view === 'home') loadList();
  }, every);
}

/* ── 화면 ─────────────────────────────────────────────────────────── */
function render() {
  const el = app();
  if (!el) return;
  document.documentElement.dataset.theme = state.theme;
  destroyMap();

  if (state.view === 'ride') el.innerHTML = viewRide();
  else if (state.view === 'new') el.innerHTML = viewNew();
  else el.innerHTML = viewHome();

  bindForms();
  mountMapIfNeeded();
  renderUserChip();
}

function renderUserChip() {
  const btn = document.getElementById('btn-user');
  if (!btn) return;
  if (state.user) {
    btn.textContent = state.name || '내 계정';
    btn.classList.add('on');
    btn.setAttribute('aria-label', `${state.name || '내 계정'} — 계정 메뉴`);
    btn.dataset.act = 'account';
  } else {
    btn.textContent = '로그인';
    btn.classList.remove('on');
    btn.dataset.act = 'login';
  }
}

/* ── 홈 ───────────────────────────────────────────────────────────── */
function viewHome() {
  const list = state.filter === 'mine'
    ? state.rides
    : state.filter === 'all'
      ? state.rides
      : state.rides.filter((r) => ['open', 'matched', 'departed'].includes(r.status));
  const active = state.rides.filter((r) => ['open', 'matched', 'departed'].includes(r.status)).length;

  return `
  <section class="hero">
    <div class="hero-copy">
      <span class="eyebrow">별무리 마을 · 무료 품앗이 카풀</span>
      <h1>가는 길, 같이 가요</h1>
      <p class="hero-desc">차를 구하는 사람과 빈자리를 내주는 사람을 한 곳에서 이어 줍니다.<br>
      글을 올리면 <b>카톡에 붙여넣을 요약 + 전용 링크</b>가 바로 나와요.</p>
      <div class="cta-row">
        <button type="button" class="btn btn-need" data-act="new" data-kind="need">
          <span aria-hidden="true">🙋</span> 태워주세요
        </button>
        <button type="button" class="btn btn-offer" data-act="new" data-kind="offer">
          <span aria-hidden="true">🚗</span> 태워드릴게요
        </button>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="road"></div>
      <div class="taxi">
        <span class="taxi-sign">TAXI</span>
        <span class="taxi-light"></span>
        <span class="taxi-body"></span>
        <span class="wheel a"></span><span class="wheel b"></span>
      </div>
      <div class="pinpin p1"></div><div class="pinpin p2"></div><div class="pinpin p3"></div>
    </div>
  </section>

  <div class="notice">
    <b>품앗이 안내</b> 이 앱은 이웃끼리 차를 나눠 타는 무료 마을 품앗이예요. 영리 목적의 운송(택시 영업)이 아니며,
    기름값·통행료는 서로 정해서 나눠 주세요. 약속을 지키지 못할 땐 최대한 빨리 알려 주세요.
  </div>

  <section class="list-head">
    <div>
      <h2>이번 카풀</h2>
      <p class="sub">${active ? `지금 ${active}건이 열려 있어요` : '아직 올라온 카풀이 없어요'}</p>
    </div>
    <div class="chips" role="group" aria-label="보기 고르기">
      <button type="button" class="chip ${state.filter === 'active' ? 'on' : ''}" data-act="filter" data-filter="active">진행 중</button>
      <button type="button" class="chip ${state.filter === 'all' ? 'on' : ''}" data-act="filter" data-filter="all">전체</button>
      <button type="button" class="chip ${state.filter === 'mine' ? 'on' : ''}" data-act="filter" data-filter="mine">내 글</button>
    </div>
  </section>

  ${state.error ? `<p class="alert">${esc(state.error)}</p>` : ''}
  ${state.loading ? '<p class="loading">불러오는 중…</p>' : ''}

  <div class="rides">
    ${list.length ? list.map(rideCard).join('') : emptyList()}
  </div>

  <section class="how">
    <h2>이렇게 써요</h2>
    <ol class="steps">
      <li><b>글 올리기</b><span>출발·도착 거점을 고르고 시간·인원만 적으면 끝. 요약 문구와 링크가 자동으로 나옵니다.</span></li>
      <li><b>카톡 단톡방에 붙여넣기</b><span>링크를 누구나 열어 내용을 보고 바로 응답할 수 있어요.</span></li>
      <li><b>운전자 매칭</b><span>운전자는 출발 시간·차량 정보를 남겨 매칭을 확정합니다.</span></li>
      <li><b>운행 중에도 함께</b><span>“5분 뒤 도착”, 위치 공유, 짧은 댓글로 서로를 기다리게 하지 않아요.</span></li>
    </ol>
  </section>`;
}

function rideCard(r) {
  const k = KIND[r.kind] || KIND.need;
  const s = STATUS[r.status] || STATUS.open;
  return `
  <a class="ride ${s.cls}" href="?ride=${r.id}" data-act="open" data-id="${r.id}">
    <div class="ride-top">
      <span class="pill ${k.cls}">${k.emoji} ${k.label}</span>
      <span class="pill ${s.cls}">${s.label}</span>
    </div>
    <div class="route"><b>${esc(r.from_place)}</b><span class="arrow" aria-hidden="true">→</span><b>${esc(r.to_place)}</b></div>
    <div class="ride-meta">${fmtWhen(r.depart_at)} · ${r.kind === 'need' ? `탑승 ${r.seats}명` : `빈자리 ${r.seats}석`}</div>
    ${r.memo ? `<div class="ride-memo">${esc(r.memo)}</div>` : ''}
    <div class="ride-foot"><span>${esc(r.owner_name || '이웃')}</span><span>${ago(r.created_at)}</span></div>
  </a>`;
}

function emptyList() {
  if (state.filter === 'mine') {
    return `<div class="empty"><p><b>아직 올린 글이 없어요.</b></p><p>가는 일정이 있으면 첫 카풀을 올려 보세요.</p>
      <button type="button" class="btn btn-need sm" data-act="new" data-kind="need">🙋 태워주세요</button></div>`;
  }
  if (state.filter === 'active') {
    return `<div class="empty"><p><b>지금 진행 중인 카풀이 없어요.</b></p><p>첫 카풀을 올리면 카톡에 붙여넣을 링크가 바로 만들어집니다.</p>
    <button type="button" class="btn btn-need sm" data-act="new" data-kind="need">🙋 태워주세요</button></div>`;
  }
  return `<div class="empty"><p><b>지금은 비어 있어요.</b></p><p>첫 카풀을 올리면 카톡에 붙여넣을 링크가 바로 만들어집니다.</p>
    <button type="button" class="btn btn-need sm" data-act="new" data-kind="need">🙋 태워주세요</button></div>`;
}

/* ── 글쓰기 ───────────────────────────────────────────────────────── */
function viewNew() {
  const kind = state.kind;
  const t = todayInput();
  const name = state.name || (state.user ? displayName(state.user) : '');
  const phone = local.get('phone', '');
  const chips = (target) => PLACES.map((p) => `
    <button type="button" class="chip place" data-act="fill-place" data-target="${target}" data-name="${p.name}">
      <span aria-hidden="true">${p.emoji}</span> ${p.name}
    </button>`).join('');

  return `
  <div class="page-head">
    <button type="button" class="back" data-act="home">← 돌아가기</button>
    <h1>카풀 올리기</h1>
  </div>

  <form class="form card" id="ride-form" novalidate>
    <div class="seg" role="group" aria-label="카풀 종류">
      <button type="button" class="seg-btn ${kind === 'need' ? 'on' : ''}" data-act="kind" data-kind="need">🙋 태워주세요</button>
      <button type="button" class="seg-btn ${kind === 'offer' ? 'on' : ''}" data-act="kind" data-kind="offer">🚗 태워드릴게요</button>
    </div>
    <p class="hint">${kind === 'need'
      ? '차가 필요한 사람이 올려요. 운전자가 시간·차량을 남기면 매칭이 확정됩니다.'
      : '빈자리를 내주는 사람이 올려요. 함께 탈 사람이 신청하면 수락해 주세요.'}</p>

    <label class="field">
      <span>출발지</span>
      <input id="f-from" name="from" type="text" inputmode="text" autocomplete="off" placeholder="예: 별무리학교" value="${esc(state.draft?.from ?? '별무리학교')}" required>
      <div class="chips wrap">${chips('from')}</div>
    </label>

    <div class="swap-row">
      <button type="button" class="swap" data-act="swap" aria-label="출발지와 도착지 바꾸기">⇅</button>
    </div>

    <label class="field">
      <span>도착지</span>
      <input id="f-to" name="to" type="text" inputmode="text" autocomplete="off" placeholder="예: 대전역" value="${esc(state.draft?.to ?? '')}" required>
      <div class="chips wrap">${chips('to')}</div>
    </label>

    <div class="row2">
      <label class="field">
        <span>날짜</span>
        <input id="f-date" name="date" type="date" value="${t.date}" required>
      </label>
      <label class="field">
        <span>시간</span>
        <input id="f-time" name="time" type="time" value="${t.time}" required>
      </label>
    </div>

    <label class="field">
      <span>${kind === 'need' ? '탑승 인원' : '빈자리'}</span>
      <div class="stepper">
        <button type="button" class="step" data-act="seats" data-delta="-1" aria-label="한 명 줄이기">−</button>
        <input id="f-seats" name="seats" type="number" min="1" max="8" value="${state.draft?.seats ?? 1}" readonly>
        <button type="button" class="step" data-act="seats" data-delta="1" aria-label="한 명 늘리기">＋</button>
      </div>
    </label>

    <label class="field">
      <span>메모 <em>(선택)</em></span>
      <textarea id="f-memo" name="memo" rows="2" maxlength="200" placeholder="짐이 많아요 / 아이와 함께 / 조금 늦을 수 있어요">${esc(state.draft?.memo ?? '')}</textarea>
    </label>

    <label class="field">
      <span>연락처 <em>(선택 · 매칭된 사람에게만 보여요)</em></span>
      <input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="010-0000-0000" value="${esc(phone)}">
    </label>

    <label class="field">
      <span>올리는 사람 이름</span>
      <input id="f-name" name="name" type="text" maxlength="24" placeholder="이름" value="${esc(name)}" required>
    </label>

    <button class="btn btn-primary big" type="submit" id="btn-submit">
      ${state.user ? '카풀 올리기' : '로그인하고 올리기'}
    </button>
    <p class="fine">올리면 카톡 단톡방에 붙여넣을 요약 문구와 전용 링크가 함께 만들어집니다.</p>
  </form>`;
}

/* ── 카풀 상세 ────────────────────────────────────────────────────── */
function viewRide() {
  const d = state.detail;
  if (state.loading && !d) return '<p class="loading">불러오는 중…</p>';
  if (!d) {
    return `<div class="empty"><p><b>${esc(state.error || '글을 찾을 수 없어요.')}</b></p>
      <button type="button" class="btn sm" data-act="home">← 처음으로</button></div>`;
  }
  const r = d.ride;
  const k = KIND[r.kind];
  const s = STATUS[r.status];
  const role = roleOf(d);
  const accepted = d.members.filter((m) => m.status === 'accepted');
  const pending = d.members.filter((m) => m.status === 'requested');
  const driverInfo = d.driver;
  const driverMember = accepted.find((m) => m.role === 'driver');
  const location = [...d.events].reverse().find((e) => e.kind === 'location' && e.lat != null);
  const comments = d.events.filter((e) => e.kind === 'comment' || e.kind === 'status');

  return `
  <div class="page-head">
    <button type="button" class="back" data-act="home">← 목록</button>
    <span class="live-dot ${r.status === 'departed' ? 'on' : ''}">${r.status === 'departed' ? '운행 중 · 자동 새로고침' : '자동 새로고침'}</span>
  </div>

  <section class="detail-head card ${s.cls}">
    <div class="ride-top">
      <span class="pill ${k.cls}">${k.emoji} ${k.label}</span>
      <span class="pill ${s.cls}">${s.label}</span>
    </div>
    <h1 class="route-big"><span>${esc(r.from_place)}</span><i aria-hidden="true">→</i><span>${esc(r.to_place)}</span></h1>
    <ul class="facts">
      <li><b>${fmtWhen(r.depart_at)}</b><span>${r.kind === 'need' ? `탑승 ${r.seats}명` : `빈자리 ${r.seats}석`}</span></li>
      ${r.pickup_at ? `<li><b>${fmtClock(r.pickup_at)} 출발 예정</b><span>운전자 확정</span></li>` : ''}
      <li><b>${esc(r.owner_name || '이웃')}</b><span>${ago(r.created_at)} 올림</span></li>
    </ul>
    ${r.memo ? `<p class="memo">“${esc(r.memo)}”</p>` : ''}
    ${stepper(r.status)}
  </section>

  ${state.justCreated ? sharePanel(r, true) : ''}

  ${role === 'guest' ? `
    <div class="cta-bar guest">
      <p><b>로그인하면 바로 참여할 수 있어요.</b> 글 내용은 링크만 있으면 누구나 볼 수 있습니다.</p>
      <button type="button" class="btn btn-primary" data-act="login" data-ride="${r.id}">구글 로그인하고 참여하기</button>
    </div>` : ''}

  ${role === 'signedIn' && r.status === 'open' ? `
    <div class="cta-bar">
      ${r.kind === 'need' ? `<button type="button" class="btn btn-offer" data-act="driver-open">🚗 태워드릴게요</button>` : ''}
      <button type="button" class="btn btn-need-outline" data-act="join">🙋 같이 타기 신청</button>
    </div>` : ''}

  ${role === 'owner' && r.status === 'open' && r.kind === 'need' ? `
    <div class="cta-bar">
      <button type="button" class="btn" data-act="copy-share">📋 카톡 요약 복사</button>
      <button type="button" class="btn" data-act="share-text">요약 보기</button>
    </div>` : ''}

  ${role === 'asked' ? `<p class="alert soft">함께 타기를 신청했어요. ${r.kind === 'need' ? '글쓴이가' : '운전자가'} 수락하면 확정됩니다.</p>` : ''}

  ${(role === 'driver' || role === 'driverOwner') ? driverBar(r, d) : ''}
  ${(role === 'passenger') ? passengerBar(r, d) : ''}

  ${accepted.length ? `
  <section class="card">
    <h2>함께 가는 사람 <span class="count">${accepted.length}</span></h2>
    <ul class="people">
      ${accepted.map((m) => `<li>
        <span class="avatar ${m.role === 'driver' ? 'drv' : ''}" aria-hidden="true">${m.role === 'driver' ? '🚗' : '🙋'}</span>
        <span class="pname">${esc(m.name || '이웃')}${m.user_id === r.owner ? ' <em>글쓴이</em>' : ''}</span>
        <span class="prole">${m.role === 'driver' ? '운전자' : '동승'}</span>
        ${contactButton(r, d, m)}
      </li>`).join('')}
    </ul>
  </section>` : ''}

  ${(role === 'owner' || role === 'driverOwner' || role === 'driver') && pending.length ? `
  <section class="card">
    <h2>함께 타기 신청 <span class="count">${pending.length}</span></h2>
    <ul class="people">
      ${pending.map((m) => `<li>
        <span class="avatar" aria-hidden="true">🙋</span>
        <span class="pname">${esc(m.name || '이웃')}</span>
        <span class="decide">
          <button type="button" class="mini ok" data-act="decide" data-member="${m.id}" data-accept="1">수락</button>
          <button type="button" class="mini no" data-act="decide" data-member="${m.id}" data-accept="0">거절</button>
        </span>
      </li>`).join('')}
    </ul>
  </section>` : ''}

  ${(role !== 'guest' && role !== 'signedIn' && (driverInfo || driverMember)) ? driverCard(d) : ''}

  ${(location || r.live_share || role === 'driver' || role === 'driverOwner') ? mapCard(r, location, role) : ''}

  <section class="card">
    <h2>운행 알림 · 짧은 소통</h2>
    ${comments.length ? `<ul class="timeline">
      ${comments.map((e) => `<li class="${e.kind}">
        <span class="tl-dot" aria-hidden="true"></span>
        <div><b>${esc(e.created_name || '안내')}</b> <span class="tl-time">${ago(e.created_at)}</span>
        <p>${esc(e.text)}</p></div>
      </li>`).join('')}
    </ul>` : '<p class="sub">아직 알림이 없어요.</p>'}
    ${(role !== 'guest' && role !== 'signedIn') ? `
    <form class="comment-form" id="comment-form">
      <input id="f-comment" type="text" maxlength="200" placeholder="짧은 안내를 남겨 주세요 (예: 정문 앞이에요)" autocomplete="off">
      <button class="btn sm" type="submit">보내기</button>
    </form>` : ''}
  </section>

  ${(role === 'owner' || role === 'driverOwner' || role === 'driver') ? `
  <section class="card manage">
    <h2>글 관리</h2>
    <div class="manage-row">
      <button type="button" class="btn sm" data-act="copy-share">📋 카톡 요약 복사</button>
      <a class="btn sm" href="${rideUrl(r.id)}" data-act="open-link">링크 열기</a>
      ${(r.status !== 'cancelled' && r.status !== 'arrived') ? `<button type="button" class="btn sm danger" data-act="cancel-ride">카풀 취소</button>` : ''}
    </div>
    <p class="fine">링크: <code>${esc(rideUrl(r.id))}</code></p>
  </section>` : ''}`;
}

function roleOf(d) {
  const uid = state.user?.id;
  if (!uid) return 'guest';
  const r = d.ride;
  const accepted = d.members.filter((m) => m.status === 'accepted');
  if (r.owner === uid) return r.kind === 'offer' ? 'driverOwner' : 'owner';
  const mine = d.members.find((m) => m.user_id === uid);
  if (mine?.status === 'accepted' && mine.role === 'driver') return 'driver';
  if (mine?.status === 'accepted' && mine.role === 'passenger') return 'passenger';
  if (mine?.status === 'requested') return 'asked';
  return 'signedIn';
}

function stepper(status) {
  const order = ['open', 'matched', 'departed', 'arrived'];
  const idx = status === 'cancelled' ? -1 : order.indexOf(status);
  const steps = [['모집 중', '🙋'], ['매칭 완료', '🤝'], ['이동 중', '🚕'], ['도착 완료', '🏁']];
  if (status === 'cancelled') return `<p class="cancelled-note">이 카풀은 취소되었어요.</p>`;
  return `<ol class="track" aria-label="운행 단계">
    ${steps.map(([label, emoji], i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}">
      <span class="dot" aria-hidden="true">${i < idx ? '✓' : emoji}</span><span class="lbl">${label}</span>
    </li>`).join('')}
  </ol>`;
}

function driverCard(d) {
  const info = d.driver;
  const drv = d.members.find((m) => m.role === 'driver' && m.status === 'accepted');
  const car = [info?.car_color, info?.car_model].filter(Boolean).join(' ');
  return `
  <section class="card driver-card">
    <h2>운전자 · 차량</h2>
    <div class="driver-line">
      <span class="avatar drv" aria-hidden="true">🚗</span>
      <div>
        <b>${esc(drv?.name || '운전자')}</b>
        ${info?.car_plate ? `<span class="plate">${esc(info.car_plate)}</span>` : ''}
      </div>
    </div>
    <dl class="kv">
      ${d.ride.pickup_at ? `<div><dt>출발 예정</dt><dd>${fmtWhen(d.ride.pickup_at)}</dd></div>` : ''}
      ${car ? `<div><dt>차량</dt><dd>${esc(car)}</dd></div>` : ''}
      ${info?.pickup_memo ? `<div><dt>만나는 곳</dt><dd>${esc(info.pickup_memo)}</dd></div>` : ''}
    </dl>
  </section>`;
}

function contactButton(r, d, m) {
  const c = d.contacts.find((x) => x.user_id === m.user_id);
  if (!c?.phone) return '';
  const tel = c.phone.replace(/[^0-9+]/g, '');
  return `<span class="phone-actions">
    <a class="mini" href="tel:${tel}" aria-label="${esc(m.name)}에게 전화">📞</a>
    <a class="mini" href="sms:${tel}" aria-label="${esc(m.name)}에게 문자">💬</a>
  </span>`;
}

function driverBar(r, d) {
  const canShare = r.status === 'departed' || r.status === 'matched';
  return `
  <section class="card action-card">
    <h2>운전자 도구</h2>
    <div class="quick">
      <button type="button" class="quick-btn" data-act="quick" data-stage="departed" data-text="지금 출발했어요 🚕">지금 출발했어요</button>
      <button type="button" class="quick-btn" data-act="quick" data-text="5분 뒤 도착해요 ⏱">5분 뒤 도착</button>
      <button type="button" class="quick-btn" data-act="quick" data-text="곧 도착해요! 잠시만 기다려 주세요">거의 도착</button>
      <button type="button" class="quick-btn" data-act="quick" data-stage="arrived" data-text="도착 완료! 오늘도 안전 운전 🏁">도착했어요</button>
    </div>
    <div class="manage-row">
      ${r.status === 'matched' ? `<button type="button" class="btn sm" data-act="status" data-status="departed">🚕 출발함으로 바꾸기</button>` : ''}
      ${r.status === 'departed' ? `<button type="button" class="btn sm" data-act="status" data-status="arrived">🏁 도착 완료</button>` : ''}
      ${r.status === 'open' ? `<button type="button" class="btn sm" data-act="status" data-status="departed">🚕 출발함으로 바꾸기</button>` : ''}
      <button type="button" class="btn sm ${r.live_share ? 'on' : ''}" data-act="share-toggle" data-on="${r.live_share ? '1' : '0'}">
        ${r.live_share ? '📍 위치 공유 중 · 끄기' : '📍 위치 공유 켜기'}
      </button>
    </div>
    <p class="fine">${canShare
      ? '위치 공유를 켜면 15초마다 현재 위치가 동승자 화면의 지도에 표시됩니다. 권한이 없으면 지도를 눌러 위치를 직접 찍을 수 있어요.'
      : '매칭을 확정하면 위치 공유를 켤 수 있어요.'}</p>
  </section>`;
}

function passengerBar(r, d) {
  return `
  <section class="card action-card">
    <h2>동승자 도구</h2>
    <div class="manage-row">
      <button type="button" class="btn sm" data-act="copy-share">📋 카톡 요약 복사</button>
      <button type="button" class="btn" data-act="quick" data-text="지금 도착했어요!">도착했어요</button>
    </div>
    <p class="fine">운전자가 위치를 공유하면 아래 지도에서 차의 현재 위치와 마지막 갱신 시각을 볼 수 있어요.</p>
  </section>`;
}

function sharePanel(r, highlight = false) {
  const text = shareText(r);
  return `
  <section class="card share ${highlight ? 'highlight' : ''}" id="share-panel">
    <h2>카톡 단톡방에 붙여넣기</h2>
    <pre class="share-text" id="share-text">${esc(text)}</pre>
    <div class="manage-row">
      <button type="button" class="btn btn-primary" data-act="copy-share">📋 요약 + 링크 복사</button>
      <button type="button" class="btn sm" data-act="copy-link">🔗 링크만 복사</button>
    </div>
    <p class="fine">복사한 뒤 카톡 단톡방에 붙여넣으면, 링크를 누른 사람은 로그인 없이도 내용과 매칭 상태를 볼 수 있어요.</p>
  </section>`;
}

function mapCard(r, location, role) {
  const lat = location?.lat ?? null;
  const lng = location?.lng ?? null;
  const canPin = role === 'driver' || role === 'driverOwner';
  return `
  <section class="card map-card">
    <h2>차 위치 ${r.live_share ? '<span class="badge-live">공유 중</span>' : ''}</h2>
    <div id="map" class="map" data-lat="${lat ?? ''}" data-lng="${lng ?? ''}" data-pin="${canPin ? '1' : '0'}"></div>
    <div class="map-foot">
      ${location
        ? `<span>마지막 갱신 <b>${ago(location.created_at)}</b> · ${esc(location.created_name || '운전자')}</span>
           <a class="mini" target="_blank" rel="noopener" href="https://map.kakao.com/link/map/${encodeURIComponent('카풀 차량 위치')},${location.lat},${location.lng}">지도앱에서 열기</a>`
        : `<span>아직 위치 정보가 없어요.${canPin ? ' 지도를 누르면 위치를 직접 찍을 수 있어요.' : ''}</span>`}
    </div>
    ${canPin ? `<div class="manage-row">
      <button type="button" class="btn sm" data-act="send-pin" ${state.pin ? '' : 'disabled'}>📌 찍은 위치 알리기</button>
      <button type="button" class="btn sm" data-act="share-toggle" data-on="${r.live_share ? '1' : '0'}">${r.live_share ? 'GPS 공유 끄기' : 'GPS 공유 켜기'}</button>
    </div>` : ''}
    <p class="fine">지도: © OpenStreetMap · 위치는 운전자가 공유를 켰을 때만 갱신됩니다.</p>
  </section>`;
}

/* ── 지도 ─────────────────────────────────────────────────────────── */
function mountMapIfNeeded() {
  const el = document.getElementById('map');
  if (!el) return;
  const lat = Number(el.dataset.lat);
  const lng = Number(el.dataset.lng);
  const hasPin = el.dataset.pin === '1';
  const center = Number.isFinite(lat) && Number.isFinite(lng)
    ? [lat, lng]
    : (placeOf(state.detail?.ride?.from_place) ? [placeOf(state.detail.ride.from_place).lat, placeOf(state.detail.ride.from_place).lng] : [36.0013119, 127.5058117]);

  let map;
  try {
    map = L.map(el, { zoomControl: true, scrollWheelZoom: false, attributionControl: true }).setView(center, 13);
  } catch (err) {
    console.warn('지도를 그리지 못했어요', err);
    return;
  }
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© OpenStreetMap',
  }).addTo(map);

  const icon = L.divIcon({ className: 'car-pin', html: '<span>🚕</span>', iconSize: [34, 34], iconAnchor: [17, 30] });
  const pinIcon = L.divIcon({ className: 'car-pin manual', html: '<span>📌</span>', iconSize: [34, 34], iconAnchor: [17, 30] });

  if (Number.isFinite(lat) && Number.isFinite(lng)) L.marker([lat, lng], { icon }).addTo(map);
  if (state.pin) L.marker([state.pin.lat, state.pin.lng], { icon: pinIcon }).addTo(map);

  if (hasPin) {
    map.on('click', (e) => {
      state.pin = { lat: e.latlng.lat, lng: e.latlng.lng };
      render();
      toast('지도에 위치를 찍었어요. “찍은 위치 알리기”를 눌러 주세요.');
    });
  }
  state.map = map;
  // 지도를 지운 뒤에 늦게 도착한 타이머가 애니메이션을 건드리지 않도록 확인합니다
  setTimeout(() => {
    if (state.map !== map) return;
    try { map.invalidateSize(); } catch { /* 이미 사라진 지도 */ }
  }, 60);
}

function destroyMap() {
  const map = state.map;
  state.map = null;
  if (!map) return;
  try { map.off(); map.remove(); } catch { /* 이미 정리된 지도 */ }
}

/* ── 이벤트 ───────────────────────────────────────────────────────── */
document.addEventListener('click', async (ev) => {
  const target = ev.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;

  if (act === 'home') { ev.preventDefault(); go('home'); return; }
  if (act === 'open') {
    state.justCreated = false;
    const id = target.dataset.id;
    if (id) { ev.preventDefault(); go('ride', id); }
    return;
  }
  if (act === 'new') {
    state.kind = target.dataset.kind || 'need';
    state.draft = null;
    state.justCreated = false;
    go('new');
    return;
  }
  if (act === 'kind') {
    state.kind = target.dataset.kind;
    state.draft = readDraft();
    render();
    return;
  }
  if (act === 'filter') {
    state.filter = target.dataset.filter;
    state.loading = true;
    render();
    loadList();
    return;
  }
  if (act === 'fill-place') {
    const input = document.getElementById(target.dataset.target === 'from' ? 'f-from' : 'f-to');
    if (input) { input.value = target.dataset.name; input.classList.add('filled'); }
    return;
  }
  if (act === 'swap') {
    const a = document.getElementById('f-from');
    const b = document.getElementById('f-to');
    if (a && b) { const t = a.value; a.value = b.value; b.value = t; }
    return;
  }
  if (act === 'seats') {
    const input = document.getElementById('f-seats');
    if (!input) return;
    const next = Math.min(8, Math.max(1, Number(input.value || 1) + Number(target.dataset.delta)));
    input.value = String(next);
    return;
  }
  if (act === 'login') {
    if (target.dataset.ride) local.set('pending-ride', target.dataset.ride);
    if (state.rideId) local.set('pending-ride', state.rideId);
    openSheet(loginSheet());
    return;
  }
  if (act === 'google') {
    if (state.rideId) local.set('pending-ride', state.rideId);
    await loginWithGoogle();
    return;
  }
  if (act === 'logout') {
    await logout();
    state.user = null;
    toast('로그아웃했어요.');
    render();
    return;
  }
  if (act === 'account') { openSheet(accountSheet()); return; }
  if (act === 'theme') {
    state.theme = state.theme === 'day' ? 'night' : 'day';
    local.set('theme', state.theme);
    render();
    return;
  }
  if (act === 'copy-share' || act === 'copy-link') {
    const r = state.detail?.ride;
    if (!r) return;
    const ok = await copyText(act === 'copy-link' ? rideUrl(r.id) : shareText(r));
    toast(ok ? '복사했어요. 카톡에 붙여넣어 주세요!' : '복사가 막혔어요. 아래 문구를 길게 눌러 복사해 주세요.');
    return;
  }
  if (act === 'share-text') {
    const r = state.detail?.ride;
    if (r) openSheet(`<h2>카톡에 붙여넣을 문구</h2><pre class="share-text">${esc(shareText(r))}</pre>
      <div class="manage-row"><button class="btn btn-primary" data-act="copy-share">📋 복사</button><button class="btn" data-act="close-sheet">닫기</button></div>`);
    return;
  }
  if (act === 'close-sheet') { closeSheet(); return; }
  if (act === 'driver-open') { openSheet(driverSheet()); return; }
  if (act === 'join') { await doJoin(); return; }
  if (act === 'decide') { await doDecide(target.dataset.member, target.dataset.accept === '1'); return; }
  if (act === 'status') { await doStatus(target.dataset.status); return; }
  if (act === 'quick') { await doQuick(target.dataset.text, target.dataset.stage); return; }
  if (act === 'share-toggle') { await doShareToggle(target.dataset.on === '1'); return; }
  if (act === 'send-pin') { await doSendPin(); return; }
  if (act === 'cancel-ride') { await doCancel(); return; }
});

function readDraft() {
  return {
    from: document.getElementById('f-from')?.value ?? '',
    to: document.getElementById('f-to')?.value ?? '',
    seats: Number(document.getElementById('f-seats')?.value || 1),
    memo: document.getElementById('f-memo')?.value ?? '',
  };
}

function bindForms() {
  const form = document.getElementById('ride-form');
  if (form) form.addEventListener('submit', onSubmitRide);
  const comment = document.getElementById('comment-form');
  if (comment) comment.addEventListener('submit', onSubmitComment);
  const sheetForm = document.getElementById('driver-form');
  if (sheetForm) sheetForm.addEventListener('submit', onSubmitDriver);
}

async function onSubmitRide(ev) {
  ev.preventDefault();
  if (!state.user) {
    const rideIdNow = state.rideId;
    if (rideIdNow) local.set('pending-ride', rideIdNow);
    openSheet(loginSheet('카풀을 올리려면 로그인이 필요해요.'));
    return;
  }
  const from = document.getElementById('f-from').value.trim();
  const to = document.getElementById('f-to').value.trim();
  const date = document.getElementById('f-date').value;
  const time = document.getElementById('f-time').value;
  const seats = Number(document.getElementById('f-seats').value || 1);
  const memo = document.getElementById('f-memo').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const name = document.getElementById('f-name').value.trim();
  if (!from || !to) return toast('출발지와 도착지를 적어 주세요.');
  if (from === to) return toast('출발지와 도착지가 같아요.');
  const departAt = toIso(date, time);
  if (!departAt) return toast('날짜와 시간을 확인해 주세요.');
  if (!name) return toast('이름을 적어 주세요.');

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = '올리는 중…';
  try {
    local.set('name', name);
    if (phone) local.set('phone', phone);
    const ride = await api.createRide({ kind: state.kind, name, from, to, departAt, seats, memo, phone }, state.user);
    state.justCreated = true;
    state.name = name;
    state.detail = null;
    state.loading = true;
    go('ride', ride.id);
    toast('카풀을 올렸어요. 요약을 복사해 카톡에 붙여넣으세요!');
  } catch (e) {
    toast(e.message || '올리지 못했어요.');
    btn.disabled = false;
    btn.textContent = '카풀 올리기';
  }
}

async function doJoin() {
  if (!state.user) { local.set('pending-ride', state.rideId); openSheet(loginSheet('함께 타려면 로그인이 필요해요.')); return; }
  try {
    const name = state.name || displayName(state.user);
    await api.requestSeat(state.rideId, state.user, name);
    toast('함께 타기를 신청했어요.');
    await loadDetail();
  } catch (e) { toast(e.message || '신청하지 못했어요.'); }
}

async function doDecide(memberId, accept) {
  try {
    await api.decideMember(memberId, accept);
    toast(accept ? '수락했어요.' : '거절했어요.');
    await loadDetail();
  } catch (e) { toast(e.message || '처리하지 못했어요.'); }
}

async function doStatus(status) {
  const r = state.detail?.ride;
  if (!r) return;
  const name = state.name || displayName(state.user);
  const text = status === 'departed' ? '지금 출발했어요 🚕' : status === 'arrived' ? '도착 완료! 오늘도 안전 운전 🏁' : '';
  try {
    await api.setRideStatus(r.id, status, state.user, name, text);
    await loadDetail();
  } catch (e) { toast(e.message || '바꾸지 못했어요.'); }
}

async function doQuick(text, stage) {
  const r = state.detail?.ride;
  if (!r) return;
  const name = state.name || displayName(state.user);
  try {
    if (stage && r.status !== stage && stage !== 'cancelled') {
      await api.setRideStatus(r.id, stage, state.user, name, text);
    } else {
      await api.postEvent(r.id, { kind: 'status', text }, state.user, name);
    }
    toast('알렸어요.');
    await loadDetail();
  } catch (e) { toast(e.message || '알리지 못했어요.'); }
}

async function doShareToggle(wasOn) {
  const r = state.detail?.ride;
  if (!r) return;
  try {
    if (wasOn) {
      await api.setLiveShare(r.id, false);
      if (state.watching != null) { navigator.geolocation.clearWatch(state.watching); state.watching = null; }
      toast('위치 공유를 껐어요.');
      await loadDetail();
      return;
    }
    await api.setLiveShare(r.id, true);
    startGeo(r.id);
    toast('위치 공유를 켰어요. 화면을 닫아도 위치는 전송되지 않습니다.');
    await loadDetail();
  } catch (e) { toast(e.message || '위치 공유를 바꾸지 못했어요.'); }
}

let lastSent = 0;
function startGeo(rideId) {
  if (!('geolocation' in navigator)) {
    toast('이 브라우저는 위치를 읽을 수 없어요. 지도를 눌러 위치를 직접 찍어 주세요.');
    return;
  }
  if (state.watching != null) navigator.geolocation.clearWatch(state.watching);
  state.watching = navigator.geolocation.watchPosition(async (pos) => {
    if (Date.now() - lastSent < 15000) return;
    lastSent = Date.now();
    try {
      await api.postEvent(rideId, { kind: 'location', lat: pos.coords.latitude, lng: pos.coords.longitude }, state.user, state.name || displayName(state.user));
      if (state.view === 'ride' && !state.sheetOpen) loadDetail();
    } catch { /* 조용히 */ }
  }, () => {
    stopGeo();
    toast('위치 권한이 없어요. 지도를 눌러 위치를 직접 찍어 알려 주세요.');
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

function stopGeo() {
  if (state.watching != null && 'geolocation' in navigator) navigator.geolocation.clearWatch(state.watching);
  state.watching = null;
}

async function doSendPin() {
  const r = state.detail?.ride;
  if (!r || !state.pin) return;
  try {
    await api.postEvent(r.id, { kind: 'location', lat: state.pin.lat, lng: state.pin.lng }, state.user, state.name || displayName(state.user));
    toast('찍은 위치를 알렸어요.');
    state.pin = null;
    await loadDetail();
  } catch (e) { toast(e.message || '알리지 못했어요.'); }
}

async function doCancel() {
  const r = state.detail?.ride;
  if (!r) return;
  openSheet(`<h2>카풀을 취소할까요?</h2><p class="sub">지금까지의 알림은 남고, 목록에서는 사라집니다.</p>
    <div class="manage-row"><button class="btn danger" data-act="cancel-confirm">취소하기</button>
    <button class="btn" data-act="close-sheet">그대로 두기</button></div>`);
}

document.addEventListener('click', async (ev) => {
  if (ev.target.closest('[data-act="cancel-confirm"]')) {
    const r = state.detail?.ride;
    if (!r) return;
    try {
      await api.setRideStatus(r.id, 'cancelled', state.user, state.name || displayName(state.user), '카풀이 취소되었어요.');
      closeSheet();
      toast('취소했어요.');
      await loadDetail();
    } catch (e) { toast(e.message || '취소하지 못했어요.'); }
  }
});

async function onSubmitComment(ev) {
  ev.preventDefault();
  const input = document.getElementById('f-comment');
  const text = input?.value.trim();
  if (!text || !state.rideId) return;
  try {
    await api.postEvent(state.rideId, { kind: 'comment', text }, state.user, state.name || displayName(state.user));
    input.value = '';
    await loadDetail();
  } catch (e) { toast(e.message || '보내지 못했어요.'); }
}

/* ── 운전자 매칭 시트 ─────────────────────────────────────────────── */
function driverSheet() {
  const r = state.detail?.ride;
  if (!r) return '';
  return `
  <h2>태워드릴게요</h2>
  <p class="sub">${esc(r.from_place)} → ${esc(r.to_place)} · ${fmtWhen(r.depart_at)}</p>
  <form id="driver-form" class="form">
    <label class="field">
      <span>실제 출발(픽업) 시간</span>
      <input id="d-pickup" type="datetime-local" value="${pickupInput(r.pickup_at)}" required>
    </label>
    <div class="row2">
      <label class="field"><span>차종</span><input id="d-model" type="text" placeholder="예: 카니발" maxlength="20"></label>
      <label class="field"><span>색상</span><input id="d-color" type="text" placeholder="예: 흰색" maxlength="10"></label>
    </div>
    <label class="field">
      <span>번호판 (일부만) </span>
      <input id="d-plate" type="text" placeholder="예: 12가 34**" maxlength="16">
    </label>
    <label class="field">
      <span>만나는 곳 메모</span>
      <input id="d-place" type="text" placeholder="예: 학교 정문 앞" maxlength="60">
    </label>
    <button class="btn btn-offer big" type="submit">매칭 확정</button>
    <p class="fine">확정하면 동승자에게 출발 시간과 차량 정보가 보이고, 위치 공유를 켤 수 있어요.</p>
  </form>`;
}

async function onSubmitDriver(ev) {
  ev.preventDefault();
  const r = state.detail?.ride;
  if (!r || !state.user) return;
  const pickupAt = document.getElementById('d-pickup').value;
  const iso = pickupAt ? new Date(pickupAt).toISOString() : null;
  if (!iso) return toast('출발 시간을 골라 주세요.');
  const name = state.name || displayName(state.user);
  const btn = ev.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api.acceptAsDriver(r.id, {
      name,
      pickupAt: iso,
      pickupLabel: fmtWhen(iso),
      carModel: document.getElementById('d-model').value.trim(),
      carColor: document.getElementById('d-color').value.trim(),
      carPlate: document.getElementById('d-plate').value.trim(),
      pickupMemo: document.getElementById('d-place').value.trim(),
    }, state.user);
    closeSheet();
    toast('매칭을 확정했어요. 동승자에게 알림이 남았습니다.');
    await loadDetail();
  } catch (e) {
    toast(e.message || '매칭하지 못했어요.');
    btn.disabled = false;
  }
}

/* ── 시트(모달) ───────────────────────────────────────────────────── */
function openSheet(html) {
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = `<div class="sheet-inner card">${html}</div>`;
  sheet.hidden = false;
  state.sheetOpen = true;
  document.body.classList.add('sheet-open');
  const form = document.getElementById('driver-form');
  if (form) form.addEventListener('submit', onSubmitDriver);
  const first = sheet.querySelector('input,button');
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
}
function closeSheet() {
  const sheet = document.getElementById('sheet');
  sheet.hidden = true;
  sheet.innerHTML = '';
  state.sheetOpen = false;
  document.body.classList.remove('sheet-open');
}
document.getElementById('sheet')?.addEventListener('click', (e) => {
  if (e.target.id === 'sheet') closeSheet();
});

function loginSheet(note = '') {
  return `
  <h2>로그인</h2>
  ${note ? `<p class="sub">${esc(note)}</p>` : '<p class="sub">같은 계정으로 GOODWAY APPS의 다른 앱도 쓸 수 있어요.</p>'}
  <button class="btn btn-primary big" data-act="google">구글 계정으로 계속하기</button>
  <details class="mail-login">
    <summary>이메일로 로그인</summary>
    <form id="email-login-form" class="form">
      <label class="field"><span>이메일</span><input id="em-email" type="email" autocomplete="email" required></label>
      <label class="field"><span>비밀번호</span><input id="em-pw" type="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">로그인</button>
    </form>
  </details>
  <button class="btn sm" data-act="close-sheet">닫기</button>`;
}

function accountSheet() {  return `
  <h2>내 계정</h2>
  <p class="sub">${esc(state.user?.email || '')}</p>
  <label class="field"><span>표시 이름</span>
    <input id="me-name" type="text" maxlength="24" value="${esc(state.name)}">
  </label>
  <div class="manage-row">
    <button class="btn btn-primary" data-act="save-name">저장</button>
    <button class="btn" data-act="logout">로그아웃</button>
    <button class="btn" data-act="close-sheet">닫기</button>
  </div>
  <p class="fine">이름은 새 카풀 글에 기본으로 채워집니다.</p>`;
}

document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-act="save-name"]')) {
    const v = document.getElementById('me-name')?.value.trim();
    if (v) { state.name = v; local.set('name', v); toast('이름을 저장했어요.'); }
    closeSheet();
    render();
  }
});

/* ── 이메일 로그인 (구글 계정이 없는 분용) ─────────────────────────── */
document.addEventListener('submit', async (ev) => {
  if (ev.target.id !== 'email-login-form') return;
  ev.preventDefault();
  const email = document.getElementById('em-email').value.trim();
  const pw = document.getElementById('em-pw').value;
  const { error } = await loginWithPassword(email, pw);
  if (error) toast('로그인하지 못했어요: ' + (error.message || ''));
  else { closeSheet(); toast('로그인했어요.'); }
});

/* ── 시작 ─────────────────────────────────────────────────────────── */
function boot() {
  document.documentElement.dataset.theme = state.theme;
  const params = new URLSearchParams(location.search);
  if (params.get('ride')) { state.view = 'ride'; state.rideId = params.get('ride'); }
  else if (params.get('new')) { state.view = 'new'; state.kind = params.get('new') === 'offer' ? 'offer' : 'need'; }

  applyAppInfo(' · GOODWAY APPS');
  render();

  onUserChange((user) => welcome(user));

  if (!state.user) {
    // 세션이 이미 있는 경우 onUserChange 가 불리고, 없으면 바로 로그인 화면 없이 손님으로 시작
    supabase.auth.getSession().then(({ data }) => { if (!data.session) welcome(null); });
  }

  if (state.view === 'ride') loadDetail();
  else if (state.view === 'home') loadList();
  schedulePoll();

  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'ride') loadDetail(); });
}

document.getElementById('year')?.replaceChildren(String(new Date().getFullYear()));
boot();
