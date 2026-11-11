import { loadSettings, saveSession } from '../store.js';
import { createAnalyzer } from '../analysis/analyzer.js';
import { createCueEngine, speak } from '../feedback/cues.js';
import { drawSkeleton } from '../ui/skeleton.js';
import { icon, fmtTime } from '../ui/icons.js';

const COUNTDOWN_SEC = 3;
const MIN_SAVE_MS = 5000;

export function mount(root, ctx) {
  const s = loadSettings();
  const src = ctx.source;
  const analyzer = createAnalyzer({ stance: s.stance, level: s.level });
  const cues = createCueEngine({ freq: s.cueFreq });
  const startedAt = Date.now();

  let phase = 'countdown';      // countdown | work | rest | done
  let round = 1;
  let remaining = COUNTDOWN_SEC;
  let paused = false;
  let last = performance.now();
  let lostSince = null;
  let frames = 0, fpsT = performance.now(), fps = 0;
  let stopArmed = 0;
  let wakeLock = null;

  root.innerHTML = `
  <section class="screen live">
    <div class="live-top">
      <span class="rec" id="rec"><i></i><span>준비</span></span>
      <span style="color:var(--cam-muted)" id="fps">${src.kind === 'demo' ? '데모 데이터' : ''}</span>
    </div>
    <div class="timer num" id="timer">0:03</div>
    <div class="round" id="round">라운드 1 / ${s.rounds}</div>
    <div class="counts">
      <div><span class="num" id="cPunch">0</span><span>펀치</span></div>
      <div><span class="num" id="cKick">0</span><span>킥</span></div>
      <div><span class="num" id="cGuard">–</span><span>가드 유지</span></div>
    </div>
    <div class="stage live-stage mirror" id="stage">
      <div class="stage-grid"></div>
      <canvas id="cv"></canvas>
      <div class="overlay-big num" id="count">3</div>
      <div class="cue good" id="cue" hidden>
        <div class="ic" id="cueIc">${icon('check')}</div>
        <div class="grow"><b id="cueT"></b><span class="small muted" id="cueS"></span></div>
        ${s.voice ? icon('speaker', 'color:var(--muted)') : ''}
      </div>
    </div>
    <div class="live-ctrl">
      <button class="btn btn-cam" id="pause">${icon('pause')}<span>일시정지</span></button>
      <button class="btn btn-primary" id="stop">${icon('stop')}<span>종료</span></button>
    </div>
  </section>`;

  const $ = (q) => root.querySelector(q);
  const stage = $('#stage'), cv = $('#cv');
  if (src.video) stage.insertBefore(src.video, cv);

  try { navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {}); } catch (_) {}

  function say(text) { if (s.voice) speak(text); }

  function showCue(cue) {
    const el = $('#cue');
    el.hidden = false;
    el.classList.add('swap');
    setTimeout(() => {
      el.className = 'cue ' + cue.kind;
      $('#cueIc').innerHTML = icon(cue.kind === 'good' ? 'check' : 'alert');
      $('#cueT').textContent = cue.title;
      $('#cueS').textContent = cue.detail;
    }, 150);
    say(cue.title);
  }

  function setPhase(next) {
    phase = next;
    if (next === 'work') {
      remaining = s.roundSec;
      analyzer.resume();
      say(round === 1 ? '시작' : `${round}라운드 시작`);
    } else if (next === 'rest') {
      remaining = s.restSec;
      say(`${round}라운드 끝. ${s.restSec}초 휴식`);
    }
    $('#count').hidden = next !== 'countdown';
  }

  function advance() {
    if (phase === 'countdown') setPhase('work');
    else if (phase === 'work') {
      if (round < s.rounds) setPhase('rest');
      else finish();
    } else if (phase === 'rest') {
      round++;
      setPhase('work');
    }
  }

  function renderHeader() {
    $('#timer').textContent = fmtTime(Math.ceil(remaining));
    if (phase === 'countdown') $('#count').textContent = Math.max(1, Math.ceil(remaining));
    $('#round').textContent = phase === 'rest' ? `휴식 · 다음은 ${round + 1}라운드` : `라운드 ${round} / ${s.rounds}`;
    const rec = $('#rec');
    rec.className = 'rec' + (paused ? ' paused' : phase === 'rest' ? ' rest' : '');
    rec.querySelector('span').textContent = paused ? '일시정지됨' : phase === 'rest' ? '휴식 중' : phase === 'work' ? '분석 중' : '준비';
    const p = analyzer.peek();
    $('#cPunch').textContent = p.totalPunches;
    $('#cKick').textContent = p.totalKicks;
    $('#cGuard').textContent = p.guardPct != null ? p.guardPct + '%' : '–';
    if (src.kind === 'camera') $('#fps').textContent = `${fps}fps`;
  }

  const timer = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (!paused && phase !== 'done') {
      remaining -= dt;
      if (remaining <= 0) advance();
    }
    if (now - fpsT >= 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
    if (stopArmed && now > stopArmed) { stopArmed = 0; $('#stop span').textContent = '종료'; }
    if (phase !== 'done') renderHeader();
  }, 200);

  src.listen((f) => {
    frames++;
    let hot = null;
    if (phase === 'work' && !paused) {
      const r = analyzer.update(f);
      if (!r.tracked) {
        lostSince ??= f.t;
        if (f.t - lostSince > 2000) { const c = cues.onLost(f.t); if (c) showCue(c); }
      } else {
        lostSince = null;
        const c = cues.onEvents(r.events, f.t);
        if (c) showCue(c);
        hot = r.hot;
      }
    }
    drawSkeleton(cv, f.image, { aspect: src.aspect, hot });
  });

  $('#pause').addEventListener('click', () => {
    if (phase === 'done') return;
    paused = !paused;
    if (!paused) analyzer.resume();
    $('#pause').innerHTML = paused ? `${icon('play')}<span>계속</span>` : `${icon('pause')}<span>일시정지</span>`;
    renderHeader();
  });

  // 글러브로 잘못 누르는 것을 막기 위해 두 번 눌러야 종료.
  $('#stop').addEventListener('click', () => {
    if (!stopArmed) {
      stopArmed = performance.now() + 3000;
      $('#stop span').textContent = '한 번 더 누르면 종료';
      return;
    }
    finish();
  });

  function finish() {
    if (phase === 'done') return;
    phase = 'done';
    const sum = analyzer.summary();
    if (sum.activeMs < MIN_SAVE_MS) {
      say('기록할 만큼 훈련하지 않아서 저장하지 않았어요');
      ctx.go('setup');
      return;
    }
    const id = 's' + Date.now();
    saveSession({
      id,
      date: startedAt,
      source: src.kind,
      stance: s.stance,
      level: s.level,
      roundsDone: round,
      roundsPlanned: s.rounds,
      durationSec: Math.round(sum.activeMs / 1000),
      guardPct: sum.guardPct,
      trackedPct: sum.trackedPct,
      punches: sum.punches,
      kicks: sum.kicks,
      guardDrops: sum.guardDrops,
      totalPunches: sum.totalPunches,
      totalKicks: sum.totalKicks,
      dropTimes: sum.events.filter((e) => e.type === 'guardDrop').slice(0, 300).map((e) => [Math.round(e.t), e.hand]),
      rating: null,
    });
    say('훈련 끝. 수고했어요');
    ctx.reportId = id;
    ctx.go('report');
  }

  renderHeader();

  return () => {
    clearInterval(timer);
    src.listen(null);
    try { wakeLock?.release(); } catch (_) {}
  };
}
