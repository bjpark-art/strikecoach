import { loadSettings, saveSession } from '../store.js';
import { analyzeVideo, loadVideo, VideoError } from '../pose/video-analyzer.js';
import { analyzeFrames, sessionStats } from '../analysis/offline.js';
import { frameCount } from '../pose/frames.js';
import { putFrames } from '../db.js';
import { icon, fmtTime, bindChips, pressedValue } from '../ui/icons.js';

const FPS = 20;
const chip = (v, label, cur) => `<button class="chip" data-v="${v}" aria-pressed="${v === cur}">${label}</button>`;

export function mount(root, ctx) {
  const s = loadSettings();
  let alive = true;
  let file = null;
  let previewUrl = null;
  let controller = null;
  let wakeLock = null;

  root.innerHTML = `
  <section class="screen">
    <div class="head"><button class="icon-btn" data-back aria-label="뒤로">${icon('back')}</button><h1>영상 분석</h1></div>
    <div class="body">
      <div class="card stack">
        <b>혼자 나오는 훈련 영상을 분석해요</b>
        <div class="small muted">미트 훈련이나 섀도 영상을 올리면 잽·크로스·킥 횟수와 가드가 내려간 순간을 찾아줘요. 영상은 이 기기 안에서만 분석하고 어디에도 올리지 않아요.</div>
      </div>

      <label class="btn btn-ghost" for="file" id="pickBtn">${icon('upload')}<span>영상 선택</span></label>
      <input type="file" id="file" accept="video/*" hidden>

      <div class="card stack" id="preview" hidden>
        <video id="pv" class="preview-video" controls muted playsinline></video>
        <div class="row"><b class="grow" id="fname"></b><span class="small muted num" id="fdur"></span></div>
        <div class="field">
          <div class="small muted">영상 속 내 스탠스</div>
          <div class="chips" data-single id="stance">
            ${chip('orthodox', '오소독스 (왼발 앞)', s.stance)}${chip('southpaw', '사우스포 (오른발 앞)', s.stance)}
          </div>
        </div>
      </div>

      <div class="stack small muted" id="tips">
        <div class="row">${icon('check', 'color:var(--good)')}<span class="grow">머리부터 발끝까지 계속 보이는 영상이 정확해요</span></div>
        <div class="row">${icon('check', 'color:var(--good)')}<span class="grow">화면에 한 사람만 나와야 해요 (2인 스파링은 다음 단계)</span></div>
      </div>

      <div class="card stack" id="progress" hidden>
        <div class="row"><b class="grow">분석 중</b><span class="num" id="pct">0%</span></div>
        <div class="progress"><i id="bar" style="width:0%"></i></div>
        <div class="small muted" id="eta">자세 인식 모델을 준비하는 중…</div>
        <button class="btn btn-ghost" id="cancel">취소</button>
      </div>

      <div class="notice" id="err" hidden></div>
      <div style="flex:1"></div>
      <button class="btn btn-primary" id="start" disabled>${icon('play')}분석 시작</button>
    </div>
  </section>`;

  const $ = (q) => root.querySelector(q);
  bindChips(root);
  $('[data-back]').addEventListener('click', () => ctx.go('home'));

  function showError(msg) {
    $('#err').hidden = !msg;
    $('#err').textContent = msg || '';
  }

  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    showError(null);
    file = null;
    $('#start').disabled = true;
    try {
      const meta = await loadVideo(f); // 열 수 있는 형식인지 미리 확인
      meta.video.removeAttribute('src'); meta.video.load(); URL.revokeObjectURL(meta.url);
      if (!alive) return;
      file = f;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(f);
      $('#pv').src = previewUrl;
      $('#fname').textContent = f.name;
      $('#fdur').textContent = fmtTime(meta.duration);
      $('#preview').hidden = false;
      $('#pickBtn span').textContent = '다른 영상 선택';
      $('#start').disabled = false;
      const estMin = Math.max(1, Math.round(meta.duration * FPS * 0.04 / 60));
      $('#eta').textContent = `예상 시간: 약 ${estMin}분 (기기 성능에 따라 달라요)`;
    } catch (err) {
      showError(err instanceof VideoError ? err.message : `영상을 열지 못했어요. (${err?.message || err})`);
    }
  });

  $('#cancel').addEventListener('click', () => controller?.abort());

  $('#start').addEventListener('click', async () => {
    if (!file) return;
    const stance = pressedValue($('#stance'));
    controller = new AbortController();
    $('#start').disabled = true;
    $('#pickBtn').hidden = true;
    $('#tips').hidden = true;
    $('#progress').hidden = false;
    $('#pv').pause();
    showError(null);
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {}

    const t0 = performance.now();
    try {
      const res = await analyzeVideo(file, {
        fps: FPS,
        signal: controller.signal,
        onProgress: (p) => {
          if (!alive) return;
          $('#pct').textContent = Math.round(p * 100) + '%';
          $('#bar').style.width = (p * 100).toFixed(1) + '%';
          const el = (performance.now() - t0) / 1000;
          if (p > 0.03) $('#eta').textContent = `남은 시간 약 ${fmtTime(el / p - el)}`;
        },
      });
      if (!alive) return;
      $('#eta').textContent = '결과 정리 중…';
      const { summary } = analyzeFrames(res.frames, { stance, level: s.level });
      const id = 'v' + Date.now();
      let framesSaved = true;
      try { await putFrames(id, res.frames); } catch (e) { console.error(e); framesSaved = false; }
      saveSession({
        id,
        date: Date.now(),
        source: 'video',
        stance,
        level: s.level,
        fileName: file.name,
        fileSize: file.size,
        videoDurationSec: Math.round(res.duration * 10) / 10,
        aspect: res.aspect,
        fps: res.fps,
        frameCount: frameCount(res.frames),
        framesSaved,
        rating: null,
        ...sessionStats(summary),
      });
      ctx.videoFile = file;
      ctx.reportId = id;
      ctx.go('report');
    } catch (e) {
      if (!alive) return;
      $('#progress').hidden = true;
      $('#pickBtn').hidden = false;
      $('#tips').hidden = false;
      $('#start').disabled = false;
      if (e?.name === 'AbortError') showError('분석을 취소했어요.');
      else showError(e instanceof VideoError ? e.message : `분석 중 문제가 생겼어요. (${e?.message || e})`);
    } finally {
      try { await wakeLock?.release(); } catch (_) {}
      wakeLock = null;
    }
  });

  return () => {
    alive = false;
    controller?.abort();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    try { wakeLock?.release(); } catch (_) {}
  };
}
