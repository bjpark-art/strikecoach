import { loadSettings, saveSettings } from '../store.js';
import { createCameraSource, listCameras, CameraError } from '../pose/camera-source.js';
import { createDemoSource } from '../pose/demo-source.js';
import { drawSkeleton, framingStatus } from '../ui/skeleton.js';
import { speak } from '../feedback/cues.js';
import { icon, esc, bindChips, pressedValue } from '../ui/icons.js';

const chip = (v, label, cur) => `<button class="chip" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${label}</button>`;

export function mount(root, ctx) {
  const s = loadSettings();
  let alive = true;
  let framingOkSince = null;

  root.innerHTML = `
  <section class="screen">
    <div class="head"><button class="icon-btn" data-back aria-label="뒤로">${icon('back')}</button><h1>촬영 준비</h1></div>
    <div class="body">
      <div class="stage setup-stage mirror" id="stage">
        <div class="stage-grid"></div>
        <canvas id="cv"></canvas>
        <div class="guide-box" id="guide" hidden></div>
        <div class="stage-msg" id="msg" hidden></div>
        <div class="stage-center" id="center">
          <div class="spinner"></div><div>카메라 켜는 중…</div>
        </div>
      </div>
      <div class="row" id="camRow" hidden>
        <label class="small muted" for="camSelect" style="flex:none">카메라</label>
        <select id="camSelect" class="text-input grow" style="padding:8px 10px"></select>
      </div>
      <div class="stack small">
        <div class="row">${icon('check', 'color:var(--good)')}<span class="grow">머리부터 발끝까지 화면 안에 들어오게</span></div>
        <div class="row">${icon('check', 'color:var(--good)')}<span class="grow">폰은 허리 높이, 정면에서 옆으로 45° 정도</span></div>
      </div>
      <div class="card stack">
        <div class="row"><span class="grow">라운드</span>
          <div class="stepper"><button data-d="-1" aria-label="라운드 줄이기">−</button><b class="num" id="rounds">${s.rounds}</b><button data-d="1" aria-label="라운드 늘리기">+</button></div></div>
        <div class="row"><span class="grow">라운드 시간</span>
          <div class="chips" data-single id="roundSec">${chip(60, '1분', s.roundSec)}${chip(120, '2분', s.roundSec)}${chip(180, '3분', s.roundSec)}</div></div>
        <div class="row"><span class="grow">음성 큐 빈도</span>
          <div class="chips" data-single id="cueFreq">${chip('low', '적게', s.cueFreq)}${chip('normal', '보통', s.cueFreq)}${chip('high', '많이', s.cueFreq)}</div></div>
        <div class="row"><span class="grow">음성으로 알려주기</span>
          <button class="switch" role="switch" id="voice" aria-checked="${s.voice}" aria-label="음성 피드백"><span class="sw"></span></button></div>
      </div>
      <button class="btn btn-primary" id="start" disabled>${icon('play')}훈련 시작</button>
      <div style="text-align:center"><button class="link" id="demo">카메라 없이 데모로 해보기</button></div>
    </div>
  </section>`;

  const $ = (q) => root.querySelector(q);
  const stage = $('#stage'), cv = $('#cv');
  bindChips(root);
  $('[data-back]').addEventListener('click', () => ctx.go('home'));
  root.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', () => {
    const el = $('#rounds');
    el.textContent = Math.max(1, Math.min(12, +el.textContent + +b.dataset.d));
  }));
  $('#voice').addEventListener('click', (e) => {
    const sw = e.currentTarget;
    sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
  });

  function showCenter(html) {
    $('#center').hidden = !html;
    if (html) $('#center').innerHTML = html;
  }

  function attach(source) {
    if (!alive) { source.stop(); return; }
    if (ctx.source && ctx.source !== source) ctx.source.stop();
    ctx.source = source;
    stage.querySelector('video')?.remove();
    if (source.video) stage.insertBefore(source.video, cv);
    showCenter(null);
    $('#guide').hidden = false;
    $('#msg').hidden = false;
    $('#start').disabled = false;
    $('#demo').hidden = source.kind === 'demo';
    if (source.kind === 'demo') $('#start').innerHTML = `${icon('play')}데모로 훈련 시작`;
    else fillCameraList(source.deviceId);

    let noPoseSince = null;
    source.listen((f) => {
      drawSkeleton(cv, f.image, { aspect: source.aspect });
      let st = framingStatus(f.image);
      // 영상은 들어오는데 사람이 계속 안 잡히면, 웹캠 덮개·카메라 차단 키를 의심하도록 안내.
      if (f.image) noPoseSince = null;
      else if ((noPoseSince ??= f.t) && f.t - noPoseSince > 6000 && source.kind === 'camera') {
        st = { ok: false, msg: '화면에 내가 안 보이면 웹캠 덮개·카메라 차단 키를 확인하세요' };
      }
      if (st.ok) framingOkSince ??= f.t; else framingOkSince = null;
      $('#guide').classList.toggle('bad', !st.ok);
      $('#msg').innerHTML = `${icon(st.ok ? 'check' : 'alert', `width:16px;height:16px;color:${st.ok ? 'var(--good)' : 'var(--warn)'}`)}${st.msg}`;
    });
  }

  // 가상 카메라(OBS, NVIDIA Broadcast 등)가 기본으로 잡히면 X 아이콘만 나올 수 있어 직접 고르게 한다.
  async function fillCameraList(currentId) {
    const cams = await listCameras();
    if (!alive) return;
    const sel = $('#camSelect');
    sel.innerHTML = cams.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
    if (currentId) sel.value = currentId;
    $('#camRow').hidden = cams.length === 0;
  }
  $('#camSelect').addEventListener('change', (e) => {
    s.cameraId = e.target.value;
    saveSettings({ ...loadSettings(), cameraId: s.cameraId });
    if (ctx.source) { ctx.source.stop(); ctx.source = null; }
    stage.querySelector('video')?.remove();
    drawSkeleton(cv, null);
    startCamera();
  });

  async function startCamera() {
    showCenter('<div class="spinner"></div><div>카메라와 자세 인식 모델을 준비하는 중…</div>');
    try {
      attach(await createCameraSource({ deviceId: s.cameraId || null }));
    } catch (e) {
      if (!alive) return;
      console.error(e);
      const msg = e instanceof CameraError ? e.message : `카메라를 시작하지 못했어요. (${e && (e.message || e.name)})`;
      showCenter(`<div style="color:var(--warn)">${icon('alert', 'width:32px;height:32px')}</div><div>${msg}</div>
        <div class="row" style="justify-content:center"><button class="btn btn-ghost" id="retry" style="padding:10px 14px;font-size:14px">다시 시도</button>
        <button class="btn btn-primary" id="demo2" style="padding:10px 14px;font-size:14px">데모로 해보기</button></div>`);
      $('#retry').onclick = startCamera;
      $('#demo2').onclick = useDemo;
    }
  }
  function useDemo() { attach(createDemoSource({ stance: s.stance })); }

  $('#demo').addEventListener('click', useDemo);
  $('#start').addEventListener('click', () => {
    const voice = $('#voice').getAttribute('aria-checked') === 'true';
    saveSettings({
      ...s,
      cameraId: ctx.source?.kind === 'camera' ? ctx.source.deviceId || s.cameraId : s.cameraId,
      rounds: +$('#rounds').textContent,
      roundSec: +pressedValue($('#roundSec')),
      cueFreq: pressedValue($('#cueFreq')),
      voice,
    });
    // 브라우저는 사용자 동작 안에서 처음 말해야 이후 음성 재생을 허용한다.
    if (voice) speak('준비하세요');
    ctx.go('live');
  });

  if (ctx.source) attach(ctx.source);
  else startCamera();

  return () => {
    alive = false;
    if (ctx.source) ctx.source.listen(null);
  };
}
