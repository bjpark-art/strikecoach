import { getSession, saveSession } from '../store.js';
import { getFrames, putFrames } from '../db.js';
import { analyzeFrames, guardDropIntervals } from '../analysis/offline.js';
import { sidesFor } from '../analysis/analyzer.js';
import { LM } from '../analysis/geometry.js';
import { frameCount, frameTime, unpackFrame, findFrame, PACK_JOINTS, STRIDE } from '../pose/frames.js';
import { swapFrom } from '../sparring/tracker.js';
import { recomputeAndSave } from '../sparring/session.js';
import { WEIGHTS } from '../sparring/judge.js';
import { drawSkeleton } from '../ui/skeleton.js';
import { icon, esc, fmtTime } from '../ui/icons.js';

const FIX = {
  rear: '펀치를 뻗는 동안 뒷손 장갑을 볼에 붙여두세요.',
  lead: '뻗은 길 그대로 앞손을 턱 앞으로 되돌리세요.',
};
const SPEEDS = [0.25, 0.5, 1];
const SUBJ = { jab: '잽이', cross: '크로스가', hook: '훅이', uppercut: '어퍼컷이', kick: '킥이' };
// 판정 보정 데이터 내보내기는 개발자용. 콘솔에서 localStorage.setItem('strikecoach.dev', '1')로 켠다.
const devMode = () => { try { return localStorage.getItem('strikecoach.dev') === '1'; } catch (_) { return false; } };
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function mount(root, ctx) {
  let s = getSession(ctx.reportId);
  if (!s || (s.source !== 'video' && s.source !== 'sparring')) { ctx.go('home'); return; }
  const spar = s.source === 'sparring';
  const seekTo = ctx.reviewSeek;
  ctx.reviewSeek = null;

  let alive = true, video = null, url = null, raf = 0;
  let data = null, meBuf = null, oppBuf = null;
  let events = [], oppEvents = [], marks = [], gaps = [], overlay = true;
  let durMs = s.videoDurationSec * 1000;
  const colors = { me: css('--accent'), opp: css('--opp') };

  root.innerHTML = `
  <section class="screen">
    <div class="head"><button class="icon-btn" data-back aria-label="리포트로">${icon('back')}</button><h1>영상 리뷰</h1>
      <span class="small muted ellipsis">${esc(s.fileName)}</span></div>
    <div class="body" id="body"><div class="card muted">분석 데이터를 불러오는 중…</div></div>
  </section>`;
  const $ = (q) => root.querySelector(q);
  $('[data-back]').addEventListener('click', () => ctx.go(spar ? 'spar-report' : 'report'));

  (async () => {
    const raw = await getFrames(s.id);
    if (!alive) return;
    if (spar ? !raw?.a : !raw || !frameCount(raw)) {
      $('#body').innerHTML = `<div class="card">이 기록에는 영상 분석 데이터가 남아 있지 않아요. 영상을 다시 분석해 주세요.</div>
        <button class="btn btn-primary" id="redo">${icon('upload')}영상 다시 분석</button>`;
      $('#redo').onclick = () => { ctx.uploadMode = spar ? 'sparring' : null; ctx.go('upload'); };
      return;
    }
    if (spar) data = raw; else meBuf = raw;
    compute();
    const f = ctx.videoFile;
    if (f && f.name === s.fileName && f.size === s.fileSize) attachVideo(f);
    else renderPicker();
  })();

  // ---------- 분석 결과 → 마커 ----------
  function ranges(flags, buf, minMs = 300) {
    const out = [];
    let start = null;
    for (let i = 0; i < flags.length; i++) {
      const t = frameTime(buf, i);
      if (flags[i] && start == null) start = t;
      if (!flags[i] && start != null) { if (t - start >= minMs) out.push({ start, end: t }); start = null; }
    }
    if (start != null) out.push({ start, end: durMs });
    return out;
  }

  function compute() {
    if (spar) {
      meBuf = data[s.me];
      oppBuf = data[s.me === 'a' ? 'b' : 'a'];
    }
    durMs = Math.max(durMs, frameTime(meBuf, frameCount(meBuf) - 1));
    const me = analyzeFrames(meBuf, { stance: s.stance, level: s.level });
    events = me.summary.events;
    const lost = Array.from(me.tracked, (x) => (x ? 0 : 1));
    gaps = ranges(lost, meBuf);
    if (spar) {
      gaps = gaps.concat(ranges(Array.from(data.overlap), meBuf)).sort((x, y) => x.start - y.start);
      oppEvents = analyzeFrames(oppBuf, { stance: s.oppStance, level: s.level }).summary.events;
    }
    const overlaps = (st, en) => gaps.some((g) => g.start < en && g.end > st);
    marks = guardDropIntervals(events, durMs).map((d) => ({ ...d, type: 'drop', t: d.detect, unsure: overlaps(d.start, d.end) }));
    if (spar) {
      for (const h of s.hits) {
        marks.push({ ...h, type: h.by === 'me' ? 'hitMe' : 'hitOpp', start: Math.max(0, h.t - 300), end: h.t + 300 });
      }
    }
    marks.sort((x, y) => x.t - y.t);
  }

  // ---------- 영상 다시 고르기 ----------
  function renderPicker() {
    $('#body').innerHTML = `
      <div class="card stack">
        <b>영상 파일을 다시 선택해 주세요</b>
        <div class="small muted">영상은 저장하지 않아서, 다시 볼 때는 같은 파일(<b>${esc(s.fileName)}</b>)을 골라야 해요. 분석 결과는 저장돼 있어요.</div>
        <label class="btn btn-primary" for="refile">${icon('upload')}영상 선택</label>
        <input type="file" id="refile" accept="video/*" hidden>
      </div>`;
    $('#refile').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      ctx.videoFile = f;
      attachVideo(f, f.name !== s.fileName || f.size !== s.fileSize);
    });
  }

  // ---------- 플레이어 ----------
  const pct = (t) => Math.min(100, Math.max(0, (t / durMs) * 100)).toFixed(2) + '%';
  const MK = { drop: ['!', 'drop'], hitMe: ['✓', 'hit-me'], hitOpp: ['✕', 'hit-opp'] };

  function markerHtml() {
    return marks.map((m, i) => {
      const [sym, cls] = MK[m.type];
      return `<button class="mk ${cls}${m.unsure ? ' low' : ''}" style="left:${pct(m.t)}" data-i="${i}" aria-label="${fmtTime(m.t / 1000)} ${markTitle(m)}">${m.unsure ? '?' : sym}</button>`;
    }).join('');
  }
  const lane = (evs) => evs.filter((e) => e.type === 'punch' || e.type === 'kick').map((e) => `<i class="${e.type}" style="left:${pct(e.t)}"></i>`).join('');

  function attachVideo(file, mismatch = false) {
    if (!url) url = URL.createObjectURL(file);
    const lead = sidesFor(s.stance).lead;
    const handIdx = (hand) => LM[((hand === 'lead') === (lead === 'l') ? 'l' : 'r') + 'Wr'];
    const keepTime = video ? video.currentTime : null;

    $('#body').innerHTML = `
      ${mismatch ? '<div class="notice" style="color:var(--warn)">분석한 영상과 다른 파일 같아요. 뼈대가 영상과 맞지 않을 수 있어요.</div>' : ''}
      <div class="stage player" style="aspect-ratio:${s.aspect || 16 / 9}">
        <video id="vid" playsinline muted preload="auto"></video>
        <canvas id="cv"></canvas>
        <div class="player-top"><span class="pill dark num" id="tpill">0:00 / ${fmtTime(durMs / 1000)}</span><span class="pill dark" id="spill">1x</span></div>
      </div>
      <div>
        <div class="tl" id="tl">
          <div class="tl-track"></div>
          ${gaps.map((g) => `<div class="tl-gap" style="left:${pct(g.start)};width:calc(${pct(g.end)} - ${pct(g.start)})"></div>`).join('')}
          <div class="tl-prog" id="prog"></div>
          <div class="tl-head" id="headDot"></div>
          ${markerHtml()}
        </div>
        ${spar ? `<div class="lane-label small muted">나</div>` : ''}
        <div class="lane me" aria-hidden="true">${lane(events)}</div>
        ${spar ? `<div class="lane-label small muted">상대</div><div class="lane opp" aria-hidden="true">${lane(oppEvents)}</div>` : ''}
        <div class="legend small muted">
          <span><i class="sw-mk"></i>내 가드 하락</span>
          ${spar ? '<span><i class="sw-hitme"></i>내 유효타 후보</span><span><i class="sw-hitopp"></i>상대 유효타 후보</span>' : ''}
          <span><i class="sw-punch"></i>펀치</span><span><i class="sw-kick"></i>킥</span>
          ${gaps.length ? `<span><i class="sw-gap"></i>${spar ? '인식 끊김·겹침' : '인식 끊김'}</span>` : ''}
        </div>
      </div>
      <div class="ctrls">
        <button class="play" id="play" aria-label="재생">${icon('play')}</button>
        <div class="seg" id="speed">${SPEEDS.map((v) => `<button data-s="${v}" aria-pressed="${v === 1}">${v}x</button>`).join('')}</div>
        <button class="switch toggle" role="switch" id="ov" aria-checked="${overlay}"><span class="sw"></span>뼈대</button>
      </div>
      ${spar ? `<button class="link" id="swap">이 시점부터 나와 상대가 바뀌어 보이면 눌러주세요 (두 사람 바꾸기)</button>` : ''}
      <div class="card detail" id="detail"></div>
      ${devMode() ? calibHtml() : ''}`;

    video = $('#vid');
    video.src = url;
    const cv = $('#cv');
    const activeDrop = (t) => marks.find((m) => m.type === 'drop' && t >= m.start && t <= m.end);

    cancelAnimationFrame(raf);
    const loop = () => {
      if (!alive) return;
      const t = video.currentTime * 1000;
      if (overlay) {
        const i = findFrame(meBuf, t);
        const d = activeDrop(t);
        drawSkeleton(cv, i >= 0 ? unpackFrame(meBuf, i).image : null, { aspect: s.aspect, hot: d ? handIdx(d.hand) : null, bone: spar ? colors.me : null, joint: spar ? colors.me : null });
        if (spar && i >= 0) drawSkeleton(cv, unpackFrame(oppBuf, i).image, { aspect: s.aspect, bone: colors.opp, joint: colors.opp, clear: false });
      } else drawSkeleton(cv, null);
      $('#prog').style.width = pct(t);
      $('#headDot').style.left = pct(t);
      $('#tpill').textContent = `${fmtTime(t / 1000)} / ${fmtTime(durMs / 1000)}`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const setPlayIcon = () => {
      $('#play').innerHTML = icon(video.paused ? 'play' : 'pause');
      $('#play').setAttribute('aria-label', video.paused ? '재생' : '일시정지');
    };
    video.addEventListener('play', setPlayIcon);
    video.addEventListener('pause', setPlayIcon);
    $('#play').addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
    $('#speed').addEventListener('click', (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      video.playbackRate = +b.dataset.s;
      $('#spill').textContent = b.dataset.s + 'x';
      root.querySelectorAll('#speed button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    $('#ov').addEventListener('click', (e) => {
      overlay = !overlay;
      e.currentTarget.setAttribute('aria-checked', String(overlay));
    });
    $('#tl').addEventListener('click', (e) => {
      const mk = e.target.closest('[data-i]');
      if (mk) { select(+mk.dataset.i); return; }
      const r = $('#tl').getBoundingClientRect();
      video.currentTime = (Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * durMs) / 1000;
    });
    $('#swap')?.addEventListener('click', swapHere);
    $('#export')?.addEventListener('click', exportData);
    root.querySelectorAll('#result .chip').forEach((b) => b.addEventListener('click', () => {
      root.querySelectorAll('#result .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));

    if (keepTime != null) {
      video.addEventListener('loadedmetadata', () => { video.currentTime = keepTime; }, { once: true });
      select(-1, false);
    } else if (seekTo != null) {
      let best = -1;
      marks.forEach((m, i) => { if (best < 0 || Math.abs(m.t - seekTo) < Math.abs(marks[best].t - seekTo)) best = i; });
      if (best >= 0 && Math.abs(marks[best].t - seekTo) < 1000) {
        video.addEventListener('loadedmetadata', () => select(best), { once: true });
        select(best, false);
      } else {
        video.addEventListener('loadedmetadata', () => { video.currentTime = Math.max(0, seekTo / 1000 - 0.5); }, { once: true });
        select(-1, false);
      }
    } else {
      select(marks.length ? 0 : -1, false);
    }
  }

  // ---------- 장면 설명 ----------
  function markTitle(m) {
    if (m.type === 'drop') return `${m.hand === 'rear' ? '뒷손' : '앞손'} 가드 하락`;
    const where = m.target === 'head' ? '머리' : '몸통';
    return m.type === 'hitMe' ? `내 ${SUBJ[m.kind] || m.kind} 상대 ${where} 근처까지` : `상대 ${SUBJ[m.kind] || m.kind} 내 ${where} 근처까지`;
  }

  function select(i, seek = true) {
    root.querySelectorAll('.mk').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
    const m = marks[i];
    if (!m) {
      const myHits = spar ? s.hits.filter((h) => h.by === 'me').length : 0;
      $('#detail').innerHTML = marks.length
        ? `<div class="small muted">타임라인의 표시를 누르면 그 장면으로 이동해요.</div>`
        : `<div class="row">${icon('check', 'color:var(--good)')}<span class="grow">표시할 장면이 없어요. 가드가 0.4초 넘게 내려간 순간이 없었어요.</span></div>
           <div class="small muted" style="margin-top:6px">펀치 ${s.totalPunches}회 · 킥 ${s.totalKicks}회 · 가드 유지율 ${s.guardPct ?? '–'}%${spar ? ` · 내 유효타 후보 ${myHits}` : ''}</div>`;
      return;
    }
    if (seek && video) {
      video.pause();
      video.currentTime = Math.max(0, (m.start - 500) / 1000);
    }
    let pill, desc, compare, fix;
    if (m.type === 'drop') {
      const sec = (m.downMs / 1000).toFixed(1);
      pill = m.unsure ? '<span class="pill check">확인 필요</span>' : '<span class="pill warn">가드 하락</span>';
      desc = (m.belowCm != null ? `${sec}초 동안 가드 라인보다 최대 ${m.belowCm}cm 아래에 있었어요.` : '영상이 끝날 때까지 손이 올라오지 않았어요.')
        + (m.unsure ? ' 이 구간에 자세를 놓친 부분이 있어 판정이 틀릴 수 있어요.' : '');
      compare = [['내 동작', `${m.belowCm != null ? m.belowCm + 'cm 아래 · ' : ''}${sec}초`], ['기준', '가드 라인 위 · 0.4초 안에 복귀']];
      fix = FIX[m.hand];
    } else {
      const w = WEIGHTS.hit[m.kind === 'kick' ? 'kick' : 'punch'][m.target];
      const pts = m.guarded ? w * WEIGHTS.guardedFactor : w;
      const mine = m.type === 'hitMe';
      pill = m.unsure ? '<span class="pill check">확인 필요</span>' : mine ? '<span class="pill good">내 유효타 후보</span>' : '<span class="pill warn">상대 유효타 후보</span>';
      desc = (mine
        ? (m.guarded ? '그때 상대 손이 얼굴 앞에 있어서 가드에 막혔을 수 있어요.' : '그때 상대 가드가 열려 있었어요.')
        : (m.guarded ? '내 가드가 올라가 있어서 막았을 수 있어요.' : '그때 내 가드가 열려 있었어요.'))
        + (m.unsure ? ' 두 사람이 겹친 구간이라 확인이 필요해요.' : '') + ' 실제로 맞았는지는 영상으로 확인해 주세요.';
      compare = [['부위', m.target === 'head' ? '머리 근처' : '몸통 근처'], ['채점 반영', `${mine ? '나' : '상대'} +${pts}점${m.guarded ? ' (가드로 절반)' : ''}`]];
      fix = mine ? '좋은 장면이에요. 이때의 거리와 타이밍을 기억하세요.'
        : m.target === 'head' ? '상대가 이 공격을 낼 때 턱을 당기고 뒷손을 볼에 붙여두세요.' : '팔꿈치를 몸통에 붙여 막거나 한 발 빠지세요.';
    }
    $('#detail').innerHTML = `
      <div class="row"><span class="eyebrow grow num">${fmtTime(m.start / 1000)} · ${i + 1} / ${marks.length}</span>${pill}</div>
      <h4>${markTitle(m)}</h4>
      <div class="small muted">${desc}</div>
      <div class="compare">${compare.map(([k, v]) => `<div><div class="small muted">${k}</div><b class="num">${v}</b></div>`).join('')}</div>
      <div class="fix" style="margin-top:10px">→ ${fix}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-ghost grow small-btn" id="prev" ${i === 0 ? 'disabled' : ''}>이전</button>
        <button class="btn btn-ghost grow small-btn" id="replay">${icon('play')}0.25x로 보기</button>
        <button class="btn btn-ghost grow small-btn" id="next" ${i === marks.length - 1 ? 'disabled' : ''}>다음</button>
      </div>`;
    $('#prev').onclick = () => select(i - 1);
    $('#next').onclick = () => select(i + 1);
    $('#replay').onclick = () => {
      video.currentTime = Math.max(0, (m.start - 500) / 1000);
      root.querySelector('#speed [data-s="0.25"]').click();
      video.play().catch(() => {});
    };
  }

  // ---------- 두 사람 바꾸기 ----------
  async function swapHere() {
    const btn = $('#swap');
    btn.disabled = true;
    const i = Math.max(0, findFrame(data.a, video.currentTime * 1000));
    swapFrom(data.a, data.b, i);
    try { await putFrames(s.id, data); } catch (e) { console.error(e); }
    s = recomputeAndSave(s, data);
    compute();
    attachVideo(ctx.videoFile);
    $('#detail').insertAdjacentHTML('afterbegin', `<div class="small" style="color:var(--good);margin-bottom:6px">${fmtTime(frameTime(data.a, i) / 1000)}부터 두 사람을 바꿔서 다시 계산했어요.</div>`);
  }

  // ---------- 보정 데이터 ----------
  function calibHtml() {
    const fields = [['jab', '잽', s.punches.jab], ['cross', '크로스', s.punches.cross], ['kick', '킥', s.totalKicks], ['drop', '가드 하락', s.guardDrops.lead + s.guardDrops.rear]];
    const res = s.actual?.result;
    return `
      <details class="card calib">
        <summary><b>판정 정확도 높이기</b> <span class="small muted">실제와 비교</span></summary>
        <div class="stack" style="margin-top:12px">
          <div class="small muted">이 영상에서 실제로 ${spar ? '내가 ' : ''}친 횟수를 적고 데이터 파일을 저장해 보내주시면, 판정 기준을 맞추는 데 써요. 파일에는 영상이 아니라 관절 좌표만 들어가요.</div>
          ${spar ? `<div class="field"><div class="small">실제 결과 (코치·심판 판정이나 내 생각)</div>
            <div class="chips" id="result">${[['win', '내가 이김'], ['lose', '내가 짐'], ['draw', '비김']].map(([v, l]) => `<button class="chip" data-v="${v}" aria-pressed="${res === v}">${l}</button>`).join('')}</div></div>` : ''}
          <div class="calib-grid">
            ${fields.map(([k, label, app]) => `
              <label for="act-${k}">${spar ? '내 ' : ''}${label}<span class="small muted"> (앱: ${app})</span></label>
              <input id="act-${k}" class="text-input" type="number" min="0" inputmode="numeric" value="${s.actual?.[k] ?? ''}" placeholder="실제">`).join('')}
          </div>
          <button class="btn btn-ghost" id="export">데이터 파일 저장</button>
          <div class="small" id="exported" style="color:var(--good)" hidden></div>
        </div>
      </details>`;
  }

  function exportData() {
    const num = (k) => { const v = root.querySelector('#act-' + k).value; return v === '' ? null : Math.max(0, Math.round(+v)); };
    s.actual = { jab: num('jab'), cross: num('cross'), kick: num('kick'), drop: num('drop'), result: root.querySelector('#result [aria-pressed="true"]')?.dataset.v || null };
    saveSession(s);
    const round4 = (buf) => Array.from(buf, (x) => Math.round(x * 1e4) / 1e4);
    const payload = {
      app: 'strikecoach',
      format: spar ? 2 : 1,
      exportedAt: new Date().toISOString(),
      session: { ...s },
      actual: s.actual,
      packJoints: PACK_JOINTS,
      stride: STRIDE,
      ...(spar
        ? { me: s.me, frames: { a: round4(data.a), b: round4(data.b) }, overlap: Array.from(data.overlap) }
        : { frames: round4(meBuf) }),
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    const name = `strikecoach-${new Date(s.date).toISOString().slice(0, 10)}-${s.id}.json`;
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('#exported').hidden = false;
    $('#exported').textContent = `${name} 파일을 저장했어요 (${(blob.size / 1e6).toFixed(1)}MB).`;
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (url) URL.revokeObjectURL(url);
  };
}
