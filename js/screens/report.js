import { getSession, listSessions, saveSession } from '../store.js';
import { getFrames } from '../db.js';
import { analyzeFrames, sessionStats } from '../analysis/offline.js';
import { icon, fmtTime } from '../ui/icons.js';

function topErrors(s) {
  const list = [];
  if (s.guardDrops.rear) list.push({
    count: s.guardDrops.rear, title: '뒷손 가드가 내려가요', badge: `${s.guardDrops.rear}회`,
    fix: '펀치를 뻗는 동안 뒷손 장갑을 볼에 붙여두세요',
  });
  if (s.guardDrops.lead) list.push({
    count: s.guardDrops.lead, title: '잽 후 앞손 회수가 늦어요', badge: `${s.guardDrops.lead}회`,
    fix: '뻗은 길 그대로 앞손을 턱 앞으로 되돌리세요',
  });
  if (s.trackedPct < 80) list.push({
    count: 0, low: true, title: '자세를 놓친 구간이 있어요', badge: `인식 ${s.trackedPct}%`,
    fix: '전신이 화면에 들어오게, 밝은 곳에서 촬영해 주세요',
  });
  return list.sort((a, b) => b.count - a.count).slice(0, 3);
}

export function mount(root, ctx) {
  const s = (ctx.reportId && getSession(ctx.reportId)) || listSessions()[0];
  if (!s) { ctx.go('home'); return; }

  const d = new Date(s.date);
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const g = s.guardPct ?? 0;
  const C = 2 * Math.PI * 40;
  const errs = topErrors(s);
  const tech = [['잽', s.punches.jab, false], ['크로스', s.punches.cross, false], ['앞발 킥', s.kicks.lead, true], ['뒷발 킥', s.kicks.rear, true]];
  const max = Math.max(1, ...tech.map((t) => t[1]));
  const durMs = Math.max(1, s.durationSec * 1000);

  root.innerHTML = `
  <section class="screen">
    <div class="head"><button class="icon-btn" data-home aria-label="홈으로">${icon('back')}</button><h1>세션 리포트</h1>
      <span class="small muted">${dateLabel}${s.source === 'demo' ? ' · 데모' : s.source === 'video' ? ' · 영상 분석' : ''}</span></div>
    <div class="body">
      <div class="card score">
        <svg class="ring" viewBox="0 0 96 96" role="img" aria-label="가드 유지율 ${s.guardPct ?? '측정 안 됨'}%">
          <circle cx="48" cy="48" r="40" fill="none" stroke="var(--surface-2)" stroke-width="10"/>
          <circle cx="48" cy="48" r="40" fill="none" stroke="${g >= 75 ? 'var(--good)' : 'var(--accent)'}" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${(C * g / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 48 48)"/>
          <text x="48" y="54" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-weight="700" font-size="22" fill="var(--ink)">${s.guardPct != null ? s.guardPct + '%' : '–'}</text>
        </svg>
        <div class="grow">
          <div class="eyebrow">가드 유지율</div>
          <div class="kpis">
            <div><div class="num">${s.totalPunches}</div><div class="small muted">펀치</div></div>
            <div><div class="num">${s.totalKicks}</div><div class="small muted">킥</div></div>
            <div><div class="num">${fmtTime(s.durationSec)}</div><div class="small muted">분석 시간</div></div>
          </div>
        </div>
      </div>

      <div class="card">
        <b>고칠 점</b>
        <div class="errs" style="margin-top:10px">
          ${errs.length ? errs.map((e, i) => `
            <div class="err">
              <span class="rank num">${i + 1}</span>
              <span><b>${e.title} <span class="pill ${e.low ? 'check' : 'warn'}">${e.badge}</span></b><span class="fix">→ ${e.fix}</span></span>
            </div>`).join('') : `<div class="row">${icon('check', 'color:var(--good)')}<span class="grow">이번 세션에는 눈에 띄는 가드 하락이 없었어요.</span></div>`}
        </div>
        ${s.dropTimes?.length ? `
          <div class="small muted" style="margin-top:14px">가드가 내려간 시점</div>
          <div class="strip" aria-label="가드 하락 시점 ${s.dropTimes.length}곳">
            <div class="track"></div>
            ${s.dropTimes.map(([t]) => `<span class="mk" style="left:${Math.min(100, t / durMs * 100).toFixed(1)}%"></span>`).join('')}
          </div>
          <div class="strip-labels num"><span>0:00</span><span>${fmtTime(s.durationSec)}</span></div>` : ''}
      </div>

      <div class="card">
        <div class="row" style="margin-bottom:10px"><b class="grow">기술별 횟수</b></div>
        <div class="bars">
          ${tech.map(([n, v, k]) => `<div class="bar"><span>${n}</span><div class="track"><div class="fill ${k ? 'kick' : ''}" style="width:${v / max * 100}%"></div></div><span class="num" style="text-align:right">${v}</span></div>`).join('')}
        </div>
        <div class="notice" style="margin-top:12px">지금 버전은 곧게 뻗는 펀치(잽·크로스)와 킥만 셉니다. 훅·어퍼컷 구분은 다음 버전에서 추가돼요.</div>
        ${s.actual && Object.values(s.actual).some((v) => v != null) ? `
          <div class="small muted" style="margin-top:12px">실제 횟수와 비교</div>
          <div class="cmp-table">
            ${[['잽', s.actual.jab, s.punches.jab], ['크로스', s.actual.cross, s.punches.cross], ['킥', s.actual.kick, s.totalKicks], ['가드 하락', s.actual.drop, s.guardDrops.lead + s.guardDrops.rear]]
              .filter(([, a]) => a != null).map(([n, a, app]) => `<span>${n}</span><span class="num">실제 ${a}</span><span class="num">앱 ${app}</span>`).join('')}
          </div>` : ''}
        ${s.source === 'video' && s.framesSaved !== false ? `
          <div style="margin-top:8px"><button class="link" id="flip">잽과 크로스가 반대로 나왔나요? ${s.stance === 'southpaw' ? '오소독스' : '사우스포'}로 다시 계산</button></div>` : ''}
      </div>

      <div class="card">
        <b>이 피드백이 도움이 됐나요?</b>
        <div class="rate" style="margin-top:10px" id="rate">
          <button data-v="up" aria-pressed="${s.rating === 'up'}">도움 됐어요</button>
          <button data-v="down" aria-pressed="${s.rating === 'down'}">별로였어요</button>
        </div>
      </div>
      <div class="row">
        <button class="btn btn-ghost grow" data-home>홈으로</button>
        ${s.source === 'video'
          ? `<button class="btn btn-primary grow" id="review">${icon('play')}영상 리뷰</button>`
          : `<button class="btn btn-primary grow" id="again">${icon('play')}다시 훈련</button>`}
      </div>
    </div>
  </section>`;

  root.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => ctx.go('home')));
  root.querySelector('#again')?.addEventListener('click', () => ctx.go('setup'));
  root.querySelector('#review')?.addEventListener('click', () => { ctx.reportId = s.id; ctx.go('review'); });
  root.querySelector('#flip')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const buf = await getFrames(s.id);
    if (!buf) { e.currentTarget.textContent = '분석 데이터가 없어 다시 계산할 수 없어요'; return; }
    const stance = s.stance === 'southpaw' ? 'orthodox' : 'southpaw';
    const { summary } = analyzeFrames(buf, { stance, level: s.level });
    saveSession({ ...s, stance, ...sessionStats(summary) });
    ctx.reportId = s.id;
    mount(root, ctx);
  });
  root.querySelector('#rate').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    s.rating = b.dataset.v;
    saveSession(s);
    root.querySelectorAll('#rate button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
}
