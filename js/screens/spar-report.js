import { getSession, listSessions } from '../store.js';
import { getFrames } from '../db.js';
import { recomputeAndSave } from '../sparring/session.js';
import { icon, fmtTime } from '../ui/icons.js';

const VERDICT = {
  me: { title: '나 우세', cls: 'win' },
  opp: { title: '상대 우세', cls: 'lose' },
  draw: { title: '박빙', cls: 'draw' },
  hold: { title: '판정 보류', cls: 'hold' },
};
const CONF = { high: '신뢰도 높음', medium: '신뢰도 보통', low: '신뢰도 낮음' };
const KIND_SUBJ = { jab: '잽이', cross: '크로스가', hook: '훅이', uppercut: '어퍼컷이', kick: '킥이' };
const STANCE = { orthodox: '오소독스', southpaw: '사우스포' };

export function mount(root, ctx) {
  const s = getSession(ctx.reportId) || listSessions().find((x) => x.source === 'sparring');
  if (!s || s.source !== 'sparring') { ctx.go('home'); return; }
  ctx.reportId = s.id;
  const j = s.judge;
  const v = VERDICT[j.verdict];
  const d = new Date(s.date);
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  const hitsBy = (who, target) => s.hits.filter((h) => h.by === who && (!target || h.target === target)).length;
  const press = s.pressureSecs.total ? (who) => Math.round((s.pressureSecs[who] / s.pressureSecs.total) * 100) : () => 0;
  const rows = [
    ['유효타 후보 · 머리', hitsBy('me', 'head'), hitsBy('opp', 'head'), ''],
    ['유효타 후보 · 몸통', hitsBy('me', 'body'), hitsBy('opp', 'body'), ''],
    ['펀치', s.totalPunches, s.oppStats.totalPunches, ''],
    ['킥', s.totalKicks, s.oppStats.totalKicks, ''],
    ...(s.totalKnees != null ? [['무릎', s.totalKnees, s.oppStats.totalKnees ?? 0, '']] : []),
    ['가드 유지율', s.guardPct ?? 0, s.oppStats.guardPct ?? 0, '%'],
    ['압박 (전진한 시간)', press('me'), press('opp'), '%'],
  ];

  // 주요 장면: 내가 넣은 후보, 내가 맞은 후보, 내 가드 하락
  const moments = [
    ...s.hits.map((h) => ({
      t: h.t,
      kind: h.by === 'me' ? 'good' : 'bad',
      text: `${h.by === 'me' ? '내' : '상대'} ${KIND_SUBJ[h.kind] || h.kind} ${h.by === 'me' ? '상대' : '내'} ${h.target === 'head' ? '머리' : '몸통'} 근처까지`,
      note: [h.guarded ? '가드에 막혔을 수 있음' : '', h.unsure ? '겹침 구간 · 확인 필요' : ''].filter(Boolean).join(' · '),
    })),
    ...(s.dropTimes || []).map(([t, hand]) => ({ t, kind: 'warn', text: `내 ${hand === 'rear' ? '뒷손' : '앞손'} 가드 하락`, note: '' })),
  ].sort((a, b) => a.t - b.t);

  root.innerHTML = `
  <section class="screen">
    <div class="head"><button class="icon-btn" data-home aria-label="홈으로">${icon('back')}</button><h1>스파링 분석</h1>
      <span class="small muted">${dateLabel}</span></div>
    <div class="body">
      <div class="card verdict ${v.cls}">
        <div class="row"><span class="eyebrow grow">AI 추정 판정</span><span class="pill ${j.confidence === 'high' ? 'good' : j.confidence === 'medium' ? 'warn' : 'check'}">${CONF[j.confidence]}</span></div>
        <div class="verdict-title">${v.title}</div>
        <div class="verdict-score num"><span class="me">${j.total.me}</span><span class="muted">:</span><span class="opp">${j.total.opp}</span></div>
        <div class="small muted">${j.verdict === 'hold'
          ? `두 사람이 겹치거나 화면 밖으로 나간 구간이 많아서 판정을 보류했어요 (둘 다 보인 구간 ${s.quality.bothTrackedPct}%, 겹침 ${s.quality.overlapPct}%). 점수만 보면 ${j.leaning === 'me' ? '내 쪽' : j.leaning === 'opp' ? '상대 쪽' : '비슷'}이에요.`
          : '라운드마다 10점 만점으로 채점한 합계예요.'}
          실제로 맞았는지, 막았는지는 영상만으로 확실히 알 수 없어서 공식 판정과 다를 수 있어요.</div>
      </div>

      <div class="card">
        <b>라운드별 점수</b>
        <div class="rounds">
          <span class="h">라운드</span><span class="h me">나</span><span class="h opp">상대</span><span class="h">결과</span>
          ${j.rounds.map((r) => `
            <span class="num">${r.index}R <span class="small muted">${fmtTime(r.start / 1000)}~</span></span>
            <span class="num me">${r.me.score}</span><span class="num opp">${r.opp.score}</span>
            <span><b class="num">${r.points.me}-${r.points.opp}</b> <span class="small muted">${r.winner === 'me' ? '나' : r.winner === 'opp' ? '상대' : '박빙'}</span></span>`).join('')}
        </div>
        <div class="small muted" style="margin-top:8px">점수 = 유효타 후보(머리 펀치 2 · 몸통 펀치 1 · 몸통 킥 2 · 머리 킥 3, 가드에 막혔을 수 있으면 절반) + 공격 1개당 0.1 + 압박 최대 1</div>
      </div>

      <div class="card">
        <div class="row"><b class="grow">나 vs 상대</b><span class="small"><i class="dot me"></i>나 <i class="dot opp"></i>상대</span></div>
        <div class="vs">
          ${rows.map(([label, a, b, unit]) => {
            const max = Math.max(1, a, b);
            return `<div class="vs-row"><span class="vs-label small">${label}</span>
              <span class="num vs-num me">${a}${unit}</span>
              <div class="vs-bars"><div class="vs-bar me" style="width:${(a / max) * 100}%"></div><div class="vs-bar opp" style="width:${(b / max) * 100}%"></div></div>
              <span class="num vs-num opp">${b}${unit}</span></div>`;
          }).join('')}
        </div>
      </div>

      <div class="card">
        <div class="row"><b class="grow">주요 장면</b><span class="small muted">눌러서 영상으로</span></div>
        <div class="moments" id="moments">
          ${moments.length ? moments.slice(0, 30).map((m) => `
            <button class="moment" data-t="${m.t}">
              <span class="num small muted">${fmtTime(m.t / 1000)}</span>
              <span class="mdot ${m.kind}"></span>
              <span class="grow"><span>${m.text}</span>${m.note ? `<span class="small muted"> · ${m.note}</span>` : ''}</span>
            </button>`).join('') : '<div class="small muted">눈에 띄는 장면을 찾지 못했어요.</div>'}
        </div>
      </div>

      <div class="small muted">
        내 스탠스: ${STANCE[s.stance]}${s.meStanceManual ? '' : ' (자동 추정)'} · 상대: ${STANCE[s.oppStance]} (자동 추정)
        <button class="link" id="flip">내 스탠스 바꿔서 다시 계산</button>
      </div>
      <div class="notice">훅·어퍼컷은 손목 움직임으로 추정해요(공개 데이터로 학습, 처음 보는 영상 기준 약 72% 정확도). 확신이 낮은 동작은 세지 않아요. 블록·슬립 같은 방어, 클린치, 니·엘보는 판정에 들어가지 않아요.</div>

      <div class="row">
        <button class="btn btn-ghost grow" data-home>홈으로</button>
        <button class="btn btn-primary grow" id="review">${icon('play')}영상 리뷰</button>
      </div>
    </div>
  </section>`;

  const $ = (q) => root.querySelector(q);
  root.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => ctx.go('home')));
  $('#review').addEventListener('click', () => { ctx.reviewSeek = null; ctx.go('review'); });
  $('#moments').addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (b) { ctx.reviewSeek = +b.dataset.t; ctx.go('review'); }
  });
  $('#flip').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    const data = await getFrames(s.id);
    if (!data?.a) { e.currentTarget.textContent = '분석 데이터가 없어 다시 계산할 수 없어요'; return; }
    recomputeAndSave(s, data, { meStance: s.stance === 'southpaw' ? 'orthodox' : 'southpaw' });
    mount(root, ctx);
  });
}
