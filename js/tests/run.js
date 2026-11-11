import { createAnalyzer } from '../analysis/analyzer.js';
import { createCueEngine } from '../feedback/cues.js';
import { demoFrameAt, DEMO_LOOP_SEC } from '../pose/demo-source.js';
import { framingStatus } from '../ui/skeleton.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message]); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 기대 ${b}, 실제 ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }

function runDemo(seconds, { stance = 'orthodox', level = 'beginner', fps = 30 } = {}) {
  const an = createAnalyzer({ stance, level });
  for (let i = 0; i <= seconds * fps; i++) an.update(demoFrameAt(i / fps, stance));
  return an.summary();
}

test('데모 1루프: 잽 4, 크로스 3, 뒷발 킥 1, 뒷손 가드 하락 1', () => {
  const s = runDemo(DEMO_LOOP_SEC - 0.05);
  eq(s.punches, { jab: 4, cross: 3 }, '펀치');
  eq(s.kicks, { lead: 0, rear: 1 }, '킥');
  eq(s.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
  ok(s.guardPct >= 80 && s.guardPct <= 95, `가드 유지율 80~95% 사이여야 함 (실제 ${s.guardPct}%)`);
  eq(s.trackedPct, 100, '인식률');
});

test('데모 2루프: 횟수가 두 배', () => {
  const s = runDemo(DEMO_LOOP_SEC * 2 - 0.05);
  eq(s.punches, { jab: 8, cross: 6 }, '펀치');
  eq(s.kicks.rear, 2, '뒷발 킥');
  eq(s.guardDrops.rear, 2, '뒷손 가드 하락');
});

test('사우스포: 좌우가 바뀌어도 잽/크로스 구분이 같음', () => {
  const s = runDemo(DEMO_LOOP_SEC - 0.05, { stance: 'southpaw' });
  eq(s.punches, { jab: 4, cross: 3 }, '펀치');
  eq(s.kicks, { lead: 0, rear: 1 }, '킥');
  eq(s.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
});

test('스탠스 설정이 실제와 반대면 잽/크로스가 뒤바뀜', () => {
  const an = createAnalyzer({ stance: 'southpaw' });
  for (let i = 0; i <= (DEMO_LOOP_SEC - 0.05) * 30; i++) an.update(demoFrameAt(i / 30, 'orthodox'));
  eq(an.summary().punches, { jab: 3, cross: 4 }, '펀치');
});

test('중급자 기준에서도 데모 가드는 유지로 판정', () => {
  const s = runDemo(DEMO_LOOP_SEC - 0.05, { level: 'intermediate' });
  eq(s.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
});

test('관절이 안 보이면 분석하지 않음', () => {
  const an = createAnalyzer();
  for (let i = 0; i < 60; i++) {
    const f = demoFrameAt(i / 30);
    f.image.forEach((p) => { p.visibility = 0.1; });
    const r = an.update(f);
    ok(!r.tracked, '추적 안 됨이어야 함');
  }
  const s = an.summary();
  eq(s.totalPunches, 0, '펀치');
  eq(s.guardPct, null, '가드 유지율');
});

test('팔을 아래로 늘어뜨린 자세는 펀치가 아니고 가드 하락', () => {
  const an = createAnalyzer();
  let drops = 0;
  for (let i = 0; i < 30; i++) {
    const f = demoFrameAt(0);
    f.t = i * 33;
    f.world[13] = { x: 0.2, y: -0.25, z: 0, visibility: 1 };
    f.world[15] = { x: 0.21, y: 0, z: 0, visibility: 1 };
    f.world[14] = { x: -0.2, y: -0.25, z: 0.05, visibility: 1 };
    f.world[16] = { x: -0.21, y: 0, z: 0.05, visibility: 1 };
    drops += an.update(f).events.filter((e) => e.type === 'guardDrop').length;
  }
  eq(an.summary().totalPunches, 0, '펀치');
  eq(drops, 2, '양손 가드 하락 이벤트');
});

test('음성 큐: 같은 오류는 10초 안에 반복하지 않음', () => {
  const c = createCueEngine({ freq: 'normal' });
  const drop = [{ type: 'guardDrop', hand: 'rear' }];
  ok(c.onEvents(drop, 1000), '첫 큐는 나와야 함');
  eq(c.onEvents(drop, 4000), null, '3초 뒤 같은 큐');
  eq(c.onEvents(drop, 10999), null, '10초 직전');
  ok(c.onEvents(drop, 11000), '10초 뒤에는 다시 나와야 함');
});

test('음성 큐: 서로 다른 큐도 최소 간격(보통 2.5초)을 지킴', () => {
  const c = createCueEngine({ freq: 'normal' });
  ok(c.onEvents([{ type: 'guardDrop', hand: 'rear' }], 0), '첫 큐');
  eq(c.onEvents([{ type: 'guardDrop', hand: 'lead' }], 1000), null, '1초 뒤 다른 큐');
  ok(c.onEvents([{ type: 'guardDrop', hand: 'lead' }], 3000), '3초 뒤 다른 큐');
});

test('음성 큐: 펀치 20개 동안 가드 하락이 없으면 칭찬', () => {
  const c = createCueEngine();
  let cue = null;
  for (let i = 0; i < 20; i++) cue = c.onEvents([{ type: 'punch' }], 20000 + i * 500);
  ok(cue && cue.key === 'praise', '칭찬 큐가 나와야 함');
});

test('촬영 프레이밍: 데모 자세는 전신이 보임, 발이 잘리면 안내', () => {
  const f = demoFrameAt(0);
  ok(framingStatus(f.image).ok, '전신 보임이어야 함');
  f.image[27].y = 1.1;
  const st = framingStatus(f.image);
  ok(!st.ok && st.msg.includes('뒤로'), '뒤로 가라는 안내여야 함');
});

const failed = results.filter((r) => !r[1]);
document.getElementById('list').innerHTML = results.map(([n, pass, msg]) =>
  `<li class="${pass ? 'pass' : 'fail'}">${pass ? '✓' : '✗'} ${n}${msg ? `<pre>${msg}</pre>` : ''}</li>`).join('');
document.getElementById('result').textContent = failed.length ? `실패 ${failed.length} / ${results.length}` : `모두 통과 (${results.length})`;
document.title = failed.length ? 'FAIL' : 'PASS';
window.__testResults = results;
