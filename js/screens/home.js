import { loadSettings, listSessions } from '../store.js';
import { icon, esc } from '../ui/icons.js';

const WEEK_GOAL = 4;

export function mount(root, ctx) {
  const settings = loadSettings();
  const sessions = listSessions();
  const weekAgo = Date.now() - 7 * 864e5;
  const thisWeek = sessions.filter((s) => s.date >= weekAgo);
  const withGuard = thisWeek.filter((s) => s.guardPct != null);
  const avgGuard = withGuard.length ? Math.round(withGuard.reduce((a, s) => a + s.guardPct, 0) / withGuard.length) : null;
  const prev = sessions.filter((s) => s.date < weekAgo && s.date >= weekAgo - 7 * 864e5 && s.guardPct != null);
  const prevGuard = prev.length ? Math.round(prev.reduce((a, s) => a + s.guardPct, 0) / prev.length) : null;
  const delta = avgGuard != null && prevGuard != null ? avgGuard - prevGuard : null;

  const dateLabel = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

  root.innerHTML = `
  <section class="screen">
    <div class="head"><h1>${settings.name ? `안녕하세요, ${esc(settings.name)}님` : '안녕하세요'}</h1>
      <button class="icon-btn" id="settings" aria-label="내 정보 수정">${icon('gear')}</button></div>
    <div class="body">
      <div class="week">
        <div class="card">
          <div class="eyebrow">이번 주 세션</div>
          <div class="row" style="align-items:baseline;gap:6px"><span class="num big">${thisWeek.length}</span><span class="muted">/ 목표 ${WEEK_GOAL}</span></div>
          <div class="progress" style="margin-top:8px"><i style="width:${Math.min(100, thisWeek.length / WEEK_GOAL * 100)}%"></i></div>
        </div>
        <div class="card">
          <div class="eyebrow">가드 유지율 (주 평균)</div>
          <div class="row" style="align-items:baseline;gap:6px;flex-wrap:wrap">
            <span class="num big">${avgGuard != null ? avgGuard + '%' : '–'}</span>
            ${delta != null ? `<span class="pill ${delta >= 0 ? 'good' : 'warn'}">${delta >= 0 ? '+' : ''}${delta}%p</span>` : ''}
          </div>
          ${avgGuard == null ? '<div class="small muted">훈련하면 여기에 표시돼요</div>' : ''}
        </div>
      </div>

      <div class="stack">
        <button class="mode primary" id="mitt">
          <span class="ic">${icon('target')}</span>
          <span class="grow"><b>미트 훈련</b><span class="muted small">실시간 음성 피드백 · ${settings.rounds}라운드 × ${Math.round(settings.roundSec / 60)}분</span></span>
        </button>
        <button class="mode" disabled>
          <span class="ic">${icon('wave')}</span>
          <span class="grow"><b>섀도 드릴</b><span class="muted small">곧 추가돼요</span></span>
        </button>
        <button class="mode" id="video">
          <span class="ic">${icon('upload')}</span>
          <span class="grow"><b>영상 분석</b><span class="muted small">찍어둔 훈련 영상을 올려 리뷰 (1인)</span></span>
        </button>
        <button class="mode" disabled>
          <span class="ic">${icon('target')}</span>
          <span class="grow"><b>스파링 리뷰 (2인)</b><span class="muted small">곧 추가돼요</span></span>
        </button>
      </div>

      <div>
        <b>최근 세션</b>
        <div class="stack" style="margin-top:8px" id="recent">
          ${sessions.length ? sessions.slice(0, 5).map((s) => `
            <button class="mode" data-id="${s.id}">
              <span class="ic num" style="font-weight:800;font-size:13px">${dateLabel(s.date)}</span>
              <span class="grow"><b>${s.source === 'video' ? '영상 분석' : '미트 훈련' + (s.source === 'demo' ? ' · 데모' : '')}</b><span class="muted small">펀치 ${s.totalPunches} · 킥 ${s.totalKicks} · 가드 하락 ${s.guardDrops.lead + s.guardDrops.rear}회</span></span>
              <span class="pill ${s.guardPct != null && s.guardPct >= 75 ? 'good' : 'warn'}">${s.guardPct != null ? '가드 ' + s.guardPct + '%' : '인식 부족'}</span>
            </button>`).join('') : `<div class="card empty muted">아직 기록이 없어요. 첫 미트 훈련을 시작해 보세요.</div>`}
        </div>
      </div>
    </div>
  </section>`;

  root.querySelector('#mitt').addEventListener('click', () => ctx.go('setup'));
  root.querySelector('#video').addEventListener('click', () => ctx.go('upload'));
  root.querySelector('#settings').addEventListener('click', () => ctx.go('onboarding'));
  root.querySelector('#recent').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) { ctx.reportId = b.dataset.id; ctx.go('report'); }
  });
}
