import { frameCount, frameTime, unpackFrame } from '../pose/frames.js';
import { bodyCenter } from '../sparring/tracker.js';
import { buildSparringSession } from '../sparring/session.js';
import { saveSession } from '../store.js';
import { drawSkeleton } from '../ui/skeleton.js';
import { icon } from '../ui/icons.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 두 사람이 다 보이고 겹치지 않은 첫 프레임 (없으면 둘 다 보이는 첫 프레임). */
function pickFrame(data) {
  const n = Math.min(frameCount(data.a), frameCount(data.b));
  let fallback = -1;
  for (let i = 0; i < n; i++) {
    const a = unpackFrame(data.a, i).image, b = unpackFrame(data.b, i).image;
    if (!a || !b) continue;
    if (!data.overlap?.[i]) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

export function mount(root, ctx) {
  const pending = ctx.pendingSpar;
  if (!pending) { ctx.go('upload'); return; }
  const { data, base } = pending;
  const i = pickFrame(data);
  let url = null, alive = true;

  root.innerHTML = `
  <section class="screen">
    <div class="head"><h1>누가 나인가요?</h1></div>
    <div class="body" id="body"></div>
  </section>`;
  const body = root.querySelector('#body');

  if (i < 0) {
    body.innerHTML = `<div class="card stack"><b>두 사람을 함께 찾지 못했어요</b>
      <div class="small muted">영상에서 두 사람이 동시에 잡힌 장면이 없어요. 두 사람의 전신이 보이도록 옆에서 찍은 영상으로 다시 해보세요.</div></div>
      <button class="btn btn-primary" id="back">${icon('upload')}다른 영상 고르기</button>`;
    body.querySelector('#back').onclick = () => { ctx.uploadMode = 'sparring'; ctx.go('upload'); };
    return;
  }

  const fa = unpackFrame(data.a, i).image, fb = unpackFrame(data.b, i).image;
  const ca = bodyCenter(fa), cb = bodyCenter(fb);
  const aLeft = ca.x <= cb.x;
  const colors = { a: css('--accent'), b: css('--opp') };

  body.innerHTML = `
    <div class="small muted">분석한 영상에서 두 사람이 함께 보이는 장면이에요. 내 쪽을 눌러주세요. 다음 화면부터 나는 코랄, 상대는 파랑으로 보여요.</div>
    <div class="stage player" id="stage" style="aspect-ratio:${base.aspect || 16 / 9}">
      <video id="vid" muted playsinline preload="auto"></video>
      <canvas id="cv"></canvas>
      <button class="pick-zone ${aLeft ? 'left' : 'right'}" data-p="a" aria-label="${aLeft ? '왼쪽' : '오른쪽'} 사람이 나"><span>${aLeft ? '왼쪽' : '오른쪽'}</span></button>
      <button class="pick-zone ${aLeft ? 'right' : 'left'}" data-p="b" aria-label="${aLeft ? '오른쪽' : '왼쪽'} 사람이 나"><span>${aLeft ? '오른쪽' : '왼쪽'}</span></button>
    </div>
    <div class="row">
      <button class="btn btn-ghost grow" data-p="${aLeft ? 'a' : 'b'}">왼쪽이 나</button>
      <button class="btn btn-ghost grow" data-p="${aLeft ? 'b' : 'a'}">오른쪽이 나</button>
    </div>
    <div class="notice" id="status" hidden></div>`;

  const cv = body.querySelector('#cv');
  const draw = () => {
    drawSkeleton(cv, fa, { aspect: base.aspect, bone: colors.a, joint: colors.a });
    drawSkeleton(cv, fb, { aspect: base.aspect, bone: colors.b, joint: colors.b, clear: false });
  };
  if (ctx.videoFile) {
    url = URL.createObjectURL(ctx.videoFile);
    const v = body.querySelector('#vid');
    v.src = url;
    v.addEventListener('loadeddata', () => { v.currentTime = frameTime(data.a, i) / 1000; }, { once: true });
    v.addEventListener('seeked', draw);
  }
  requestAnimationFrame(draw);

  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    body.querySelectorAll('[data-p]').forEach((x) => { x.disabled = true; });
    const status = body.querySelector('#status');
    status.hidden = false;
    status.textContent = '두 사람의 공격과 유효타 후보를 계산하는 중…';
    setTimeout(() => {
      if (!alive) return;
      const session = buildSparringSession(base, data, { me: b.dataset.p });
      saveSession(session);
      ctx.pendingSpar = null;
      ctx.reportId = session.id;
      ctx.go('spar-report');
    }, 30);
  });

  return () => {
    alive = false;
    if (url) URL.revokeObjectURL(url);
  };
}
