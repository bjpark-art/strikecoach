import { getSession, saveSession } from '../store.js';
import { getFrames } from '../db.js';
import { analyzeFrames, guardDropIntervals } from '../analysis/offline.js';
import { sidesFor } from '../analysis/analyzer.js';
import { LM } from '../analysis/geometry.js';
import { frameCount, frameTime, unpackFrame, findFrame, PACK_JOINTS, STRIDE } from '../pose/frames.js';
import { drawSkeleton } from '../ui/skeleton.js';
import { icon, esc, fmtTime } from '../ui/icons.js';

const FIX = {
  rear: '펀치를 뻗는 동안 뒷손 장갑을 볼에 붙여두세요.',
  lead: '뻗은 길 그대로 앞손을 턱 앞으로 되돌리세요.',
};
const SPEEDS = [0.25, 0.5, 1];

export function mount(root, ctx) {
  const s = getSession(ctx.reportId);
  if (!s || s.source !== 'video') { ctx.go('home'); return; }

  let alive = true, video = null, url = null, raf = 0, buf = null;
  let events = [], drops = [], gaps = [], sel = -1, overlay = true, durMs = s.videoDurationSec * 1000;

  root.innerHTML = `
  <section class="screen">
    <div class="head"><button class="icon-btn" data-back aria-label="리포트로">${icon('back')}</button><h1>영상 리뷰</h1>
      <span class="small muted ellipsis">${esc(s.fileName)}</span></div>
    <div class="body" id="body"><div class="card muted">분석 데이터를 불러오는 중…</div></div>
  </section>`;
  const $ = (q) => root.querySelector(q);
  $('[data-back]').addEventListener('click', () => ctx.go('report'));

  (async () => {
    buf = await getFrames(s.id);
    if (!alive) return;
    if (!buf || !frameCount(buf)) {
      $('#body').innerHTML = `<div class="card">이 기록에는 영상 분석 데이터가 남아 있지 않아요. 영상을 다시 분석해 주세요.</div>
        <button class="btn btn-primary" id="redo">${icon('upload')}영상 다시 분석</button>`;
      $('#redo').onclick = () => ctx.go('upload');
      return;
    }
    durMs = Math.max(durMs, frameTime(buf, frameCount(buf) - 1));
    const { summary, tracked } = analyzeFrames(buf, { stance: s.stance, level: s.level });
    events = summary.events;
    drops = guardDropIntervals(events, durMs);
    gaps = untrackedRanges(buf, tracked);
    drops.forEach((d) => { d.unsure = gaps.some((g) => g.start < d.end && g.end > d.start); });

    const f = ctx.videoFile;
    if (f && f.name === s.fileName && f.size === s.fileSize) attachVideo(f);
    else renderPicker();
  })();

  function untrackedRanges(b, tracked) {
    const out = [];
    let start = null;
    for (let i = 0; i < tracked.length; i++) {
      const t = frameTime(b, i);
      if (!tracked[i] && start == null) start = t;
      if (tracked[i] && start != null) { if (t - start >= 300) out.push({ start, end: t }); start = null; }
    }
    if (start != null) out.push({ start, end: durMs });
    return out;
  }

  function renderPicker() {
    $('#body').innerHTML = `
      <div class="card stack">
        <b>영상 파일을 다시 선택해 주세요</b>
        <div class="small muted">영상은 저장하지 않아서, 다시 볼 때는 같은 파일(<b>${esc(s.fileName)}</b>)을 골라야 해요. 분석 결과는 저장돼 있어요.</div>
        <label class="btn btn-primary" for="refile">${icon('upload')}영상 선택</label>
        <input type="file" id="refile" accept="video/*" hidden>
        <div class="small" id="mismatch" style="color:var(--warn)" hidden></div>
      </div>`;
    $('#refile').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      ctx.videoFile = f;
      attachVideo(f, f.name !== s.fileName || f.size !== s.fileSize);
    });
  }

  function attachVideo(file, mismatch = false) {
    url = URL.createObjectURL(file);
    const pct = (t) => Math.min(100, Math.max(0, t / durMs * 100)).toFixed(2) + '%';
    const lead = sidesFor(s.stance).lead;
    const handIdx = (hand) => LM[((hand === 'lead') === (lead === 'l') ? 'l' : 'r') + 'Wr'];

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
          ${drops.map((d, i) => `<button class="mk ${d.unsure ? 'low' : ''}" style="left:${pct(d.detect)}" data-i="${i}" aria-label="${fmtTime(d.start / 1000)} ${d.hand === 'rear' ? '뒷손' : '앞손'} 가드 하락">${d.unsure ? '?' : '!'}</button>`).join('')}
        </div>
        <div class="lane" aria-hidden="true">
          ${events.filter((e) => e.type === 'punch' || e.type === 'kick').map((e) => `<i class="${e.type}" style="left:${pct(e.t)}"></i>`).join('')}
        </div>
        <div class="legend small muted">
          <span><i class="sw-mk"></i>가드 하락</span><span><i class="sw-punch"></i>펀치</span><span><i class="sw-kick"></i>킥</span>${gaps.length ? '<span><i class="sw-gap"></i>인식 끊김</span>' : ''}
        </div>
      </div>
      <div class="ctrls">
        <button class="play" id="play" aria-label="재생">${icon('play')}</button>
        <div class="seg" id="speed">${SPEEDS.map((v) => `<button data-s="${v}" aria-pressed="${v === 1}">${v}x</button>`).join('')}</div>
        <button class="switch toggle" role="switch" id="ov" aria-checked="true"><span class="sw"></span>뼈대</button>
      </div>
      <div class="card detail" id="detail"></div>
      <details class="card calib" id="calib">
        <summary><b>판정 정확도 높이기</b> <span class="small muted">실제 횟수와 비교</span></summary>
        <div class="stack" style="margin-top:12px">
          <div class="small muted">이 영상에서 실제로 친 횟수를 적고 데이터 파일을 저장해 보내주시면, 판정 기준을 맞추는 데 써요. 파일에는 영상이 아니라 관절 좌표만 들어가요.</div>
          <div class="calib-grid">
            ${[['jab', '잽', s.punches.jab], ['cross', '크로스', s.punches.cross], ['kick', '킥', s.totalKicks], ['drop', '가드 하락', s.guardDrops.lead + s.guardDrops.rear]].map(([k, label, app]) => `
              <label for="act-${k}">${label}<span class="small muted"> (앱: ${app})</span></label>
              <input id="act-${k}" class="text-input" type="number" min="0" inputmode="numeric" value="${s.actual?.[k] ?? ''}" placeholder="실제">`).join('')}
          </div>
          <button class="btn btn-ghost" id="export">데이터 파일 저장</button>
          <div class="small" id="exported" style="color:var(--good)" hidden></div>
        </div>
      </details>`;

    video = $('#vid');
    video.src = url;
    const cv = $('#cv');

    function activeDrop(t) { return drops.find((d) => t >= d.start && t <= d.end); }

    const loop = () => {
      if (!alive) return;
      const t = video.currentTime * 1000;
      if (overlay && buf) {
        const i = findFrame(buf, t);
        const d = activeDrop(t);
        drawSkeleton(cv, i >= 0 ? unpackFrame(buf, i).image : null, { aspect: s.aspect, hot: d ? handIdx(d.hand) : null });
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
      video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * durMs / 1000;
    });
    $('#export').addEventListener('click', exportData);

    select(drops.length ? 0 : -1, false);
  }

  function select(i, seek = true) {
    sel = i;
    root.querySelectorAll('.mk').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
    const d = drops[i];
    if (!d) {
      $('#detail').innerHTML = `<div class="row">${icon('check', 'color:var(--good)')}<span class="grow">이 영상에서는 가드가 0.4초 넘게 내려간 순간이 없었어요.</span></div>
        <div class="small muted" style="margin-top:6px">펀치 ${s.totalPunches}회 · 킥 ${s.totalKicks}회 · 가드 유지율 ${s.guardPct ?? '–'}%</div>`;
      return;
    }
    if (seek && video) {
      video.pause();
      video.currentTime = Math.max(0, (d.start - 500) / 1000);
    }
    const sec = (d.downMs / 1000).toFixed(1);
    $('#detail').innerHTML = `
      <div class="row"><span class="eyebrow grow num">${fmtTime(d.start / 1000)} · ${i + 1} / ${drops.length}</span>
        ${d.unsure ? '<span class="pill check">확인 필요</span>' : '<span class="pill warn">가드 하락</span>'}</div>
      <h4>${d.hand === 'rear' ? '뒷손' : '앞손'} 가드가 내려갔어요</h4>
      <div class="small muted">${d.belowCm != null ? `${sec}초 동안 가드 라인보다 최대 ${d.belowCm}cm 아래에 있었어요.` : `영상이 끝날 때까지 손이 올라오지 않았어요.`}${d.unsure ? ' 이 구간에 자세를 놓친 부분이 있어 판정이 틀릴 수 있어요.' : ''}</div>
      <div class="compare">
        <div><div class="small muted">내 동작</div><b class="num">${d.belowCm != null ? d.belowCm + 'cm 아래 · ' : ''}${sec}초</b></div>
        <div><div class="small muted">기준</div><b>가드 라인 위 · 0.4초 안에 복귀</b></div>
      </div>
      <div class="fix" style="margin-top:10px">→ ${FIX[d.hand]}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-ghost grow small-btn" id="prev" ${i === 0 ? 'disabled' : ''}>이전</button>
        <button class="btn btn-ghost grow small-btn" id="replay">${icon('play')}0.25x로 보기</button>
        <button class="btn btn-ghost grow small-btn" id="next" ${i === drops.length - 1 ? 'disabled' : ''}>다음</button>
      </div>`;
    $('#prev').onclick = () => select(i - 1);
    $('#next').onclick = () => select(i + 1);
    $('#replay').onclick = () => {
      video.currentTime = Math.max(0, (d.start - 500) / 1000);
      root.querySelector('#speed [data-s="0.25"]').click();
      video.play().catch(() => {});
    };
  }

  function exportData() {
    const num = (k) => { const v = root.querySelector('#act-' + k).value; return v === '' ? null : Math.max(0, Math.round(+v)); };
    s.actual = { jab: num('jab'), cross: num('cross'), kick: num('kick'), drop: num('drop') };
    saveSession(s);
    const data = {
      app: 'strikecoach',
      format: 1,
      exportedAt: new Date().toISOString(),
      session: { ...s },
      actual: s.actual,
      analyzed: { punches: s.punches, kicks: s.kicks, guardDrops: s.guardDrops, guardPct: s.guardPct, trackedPct: s.trackedPct },
      packJoints: PACK_JOINTS,
      stride: STRIDE,
      frames: Array.from(buf, (v) => Math.round(v * 1e4) / 1e4),
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
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
