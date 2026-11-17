import { createAnalyzer } from '../analysis/analyzer.js';
import { createCueEngine } from '../feedback/cues.js';
import { demoFrameAt, DEMO_LOOP_SEC } from '../pose/demo-source.js';
import { framingStatus } from '../ui/skeleton.js';
import { createPacker, unpackFrame, frameCount, findFrame, PACK_JOINTS } from '../pose/frames.js';
import { analyzeFrames, guardDropIntervals } from '../analysis/offline.js';
import { demoSparringFrameAt } from '../pose/demo-source.js';
import { createTracker, swapFrom } from '../sparring/tracker.js';
import { inferStance, detectHits, pressure } from '../sparring/interaction.js';
import { scoreRounds, splitRounds } from '../sparring/judge.js';
import { analyzeSparring } from '../sparring/analyze.js';
import { punchFeatures, classifyFeatures, cocoFrame } from '../analysis/punch-classifier.js';
import FIXTURE from './punch-fixture.js';
import { frameTimes } from '../pose/video-analyzer.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push([name, true]); } catch (e) { results.push([name, false, e.message]); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 기대 ${b}, 실제 ${a}`);
}
function ok(cond, label) { if (!cond) throw new Error(label); }
const jc = (p) => ({ jab: p.jab, cross: p.cross });

function runDemo(seconds, { stance = 'orthodox', level = 'beginner', fps = 30 } = {}) {
  const an = createAnalyzer({ stance, level });
  for (let i = 0; i <= seconds * fps; i++) an.update(demoFrameAt(i / fps, stance));
  return an.summary();
}

test('데모 1루프: 잽 4, 크로스 3, 뒷발 킥 1, 뒷손 가드 하락 1', () => {
  const s = runDemo(DEMO_LOOP_SEC - 0.05);
  eq(jc(s.punches), { jab: 4, cross: 3 }, '펀치');
  eq(s.kicks, { lead: 0, rear: 1 }, '킥');
  eq(s.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
  ok(s.guardPct >= 80 && s.guardPct <= 95, `가드 유지율 80~95% 사이여야 함 (실제 ${s.guardPct}%)`);
  eq(s.trackedPct, 100, '인식률');
});

test('데모 2루프: 횟수가 두 배', () => {
  const s = runDemo(DEMO_LOOP_SEC * 2 - 0.05);
  eq(jc(s.punches), { jab: 8, cross: 6 }, '펀치');
  eq(s.kicks.rear, 2, '뒷발 킥');
  eq(s.guardDrops.rear, 2, '뒷손 가드 하락');
});

test('사우스포: 좌우가 바뀌어도 잽/크로스 구분이 같음', () => {
  const s = runDemo(DEMO_LOOP_SEC - 0.05, { stance: 'southpaw' });
  eq(jc(s.punches), { jab: 4, cross: 3 }, '펀치');
  eq(s.kicks, { lead: 0, rear: 1 }, '킥');
  eq(s.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
});

test('스탠스 설정이 실제와 반대면 잽/크로스가 뒤바뀜', () => {
  const an = createAnalyzer({ stance: 'southpaw' });
  for (let i = 0; i <= (DEMO_LOOP_SEC - 0.05) * 30; i++) an.update(demoFrameAt(i / 30, 'orthodox'));
  eq(jc(an.summary().punches), { jab: 3, cross: 4 }, '펀치');
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
  ok(st.ok && st.level === 'upper', '발이 잘려도 상체가 보이면 상체 모드');
  f.image[15].x = 1.2;
  ok(!framingStatus(f.image).ok, '팔까지 잘리면 안내');
});

test('프레임 저장 형식: 저장했다 꺼낸 값이 원래 좌표와 같음', () => {
  const p = createPacker(4);
  const f = demoFrameAt(0.65);
  p.push(f);
  p.push({ t: 50, image: null, world: null });
  const buf = p.finish();
  eq(frameCount(buf), 2, '프레임 수');
  const u = unpackFrame(buf, 0);
  for (const idx of PACK_JOINTS) {
    ok(Math.abs(u.world[idx].x - f.world[idx].x) < 1e-5 && Math.abs(u.image[idx].y - f.image[idx].y) < 1e-5, `관절 ${idx} 좌표`);
  }
  eq(unpackFrame(buf, 1).image, null, '사람 없는 프레임');
});

test('저장 형식으로 다시 분석해도 실시간 분석과 결과가 같음', () => {
  const p = createPacker(10);
  for (let i = 0; i <= (DEMO_LOOP_SEC - 0.05) * 20; i++) p.push(demoFrameAt(i / 20));
  const buf = p.finish();
  const { summary, tracked } = analyzeFrames(buf, { stance: 'orthodox' });
  eq(jc(summary.punches), { jab: 4, cross: 3 }, '펀치');
  eq(summary.kicks, { lead: 0, rear: 1 }, '킥');
  eq(summary.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
  eq(tracked.every((x) => x === 1), true, '전부 추적');
  const flipped = analyzeFrames(buf, { stance: 'southpaw' }).summary;
  eq(jc(flipped.punches), { jab: 3, cross: 4 }, '스탠스 바꿔 다시 계산');
});

test('가드 하락 구간: 시작·끝·지속시간·깊이를 기록', () => {
  const p = createPacker(10);
  for (let i = 0; i <= (DEMO_LOOP_SEC - 0.05) * 30; i++) p.push(demoFrameAt(i / 30));
  const { summary } = analyzeFrames(p.finish());
  const iv = guardDropIntervals(summary.events, DEMO_LOOP_SEC * 1000);
  eq(iv.length, 1, '구간 수');
  const d = iv[0];
  eq(d.hand, 'rear', '손');
  ok(d.start > 3800 && d.start < 4000, `시작 3.8~4.0초 (실제 ${d.start})`);
  ok(d.end > 4900 && d.end < 5100, `끝 4.9~5.1초 (실제 ${d.end})`);
  ok(d.downMs > 900 && d.downMs < 1250, `지속 약 1초 (실제 ${d.downMs})`);
  ok(d.belowCm >= 10 && d.belowCm <= 25, `깊이 10~25cm (실제 ${d.belowCm})`);
});

test('영상 시점으로 프레임 찾기', () => {
  const p = createPacker(4);
  [0, 50, 100, 150].forEach((t) => p.push({ t, image: null, world: null }));
  const buf = p.finish();
  eq([findFrame(buf, 0), findFrame(buf, 49), findFrame(buf, 50), findFrame(buf, 999)], [0, 0, 1, 3], '프레임 번호');
});

// ---------- 상체 모드 ----------
const hideLower = (f) => { [23, 24, 25, 26, 27, 28].forEach((i) => { f.image[i] = { ...f.image[i], visibility: 0.05 }; }); return f; };

test('상체 모드: 엉덩이·다리가 안 보여도 펀치와 가드는 판정', () => {
  const an = createAnalyzer();
  let mode = null;
  for (let i = 0; i <= (DEMO_LOOP_SEC - 0.05) * 30; i++) mode = an.update(hideLower(demoFrameAt(i / 30))).mode;
  const s = an.summary();
  eq(mode, 'upper', '모드');
  eq(jc(s.punches), { jab: 4, cross: 3 }, '펀치');
  eq(s.guardDrops, { lead: 0, rear: 1 }, '가드 하락');
  eq(s.totalKicks, 0, '킥은 세지 않음');
  eq(s.upperPct, 100, '상체 모드 비율');
  eq(s.trackedPct, 100, '인식률');
});

// ---------- 스파링 ----------
function sparBuffers(sec, opts = {}, fps = 20, shuffle = false) {
  const pa = createPacker(10), pb = createPacker(10), tr = createTracker();
  const n = Math.round(sec * fps);
  const overlap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const f = demoSparringFrameAt(i / fps, opts);
    const dets = shuffle && i % 2 ? [f.b, f.a] : [f.a, f.b];
    const r = tr.assign(dets);
    pa.push({ t: f.t, ...(r.a || {}) });
    pb.push({ t: f.t, ...(r.b || {}) });
    overlap[i] = r.overlap;
  }
  return { a: pa.finish(), b: pb.finish(), overlap };
}

test('추적기: 감지 순서가 매번 바뀌어도 A는 왼쪽 사람으로 유지', () => {
  const d = sparBuffers(3, {}, 20, true);
  for (let i = 0; i < frameCount(d.a); i++) {
    const a = unpackFrame(d.a, i).image, b = unpackFrame(d.b, i).image;
    ok(a[11].x < 0.5 && b[11].x > 0.5, `프레임 ${i}에서 A/B가 뒤바뀜`);
  }
  eq(Array.from(d.overlap).some(Boolean), false, '겹침 없음');
});

test('추적기: 한 명이 잠깐 안 보여도 같은 자리로 복귀', () => {
  const tr = createTracker();
  const f0 = demoSparringFrameAt(0);
  tr.assign([f0.a, f0.b]);
  const r1 = tr.assign([f0.b]);          // A가 가려짐
  ok(!r1.a && r1.b, '보이는 사람은 B로');
  const r2 = tr.assign([f0.b, f0.a]);
  ok(r2.a === f0.a && r2.b === f0.b, 'A/B 복귀');
});

test('두 사람 바꾸기: 지정한 프레임부터만 바뀜', () => {
  const d = sparBuffers(1);
  const before = unpackFrame(d.a, 0).image[11].x;
  swapFrom(d.a, d.b, 10);
  eq(unpackFrame(d.a, 0).image[11].x, before, '앞부분 그대로');
  ok(unpackFrame(d.a, 10).image[11].x > 0.5, '10번째부터 오른쪽 사람');
});

test('스탠스 자동 추정: 상대에게 가까운 손 = 앞손', () => {
  const d = sparBuffers(DEMO_LOOP_SEC);
  eq(inferStance(d.a, d.b), 'orthodox', 'A');
  eq(inferStance(d.b, d.a), 'orthodox', 'B');
});

test('유효타 후보: 가까우면 A의 잽이 B 머리 근처로 잡히고, 멀면 없음', () => {
  const near = sparBuffers(DEMO_LOOP_SEC - 0.05);
  const evs = analyzeFrames(near.a, { stance: 'orthodox' }).summary.events;
  const hits = detectHits(near.a, near.b, evs, near.overlap);
  ok(hits.some((h) => h.kind === 'jab' && h.target === 'head'), `잽 머리 후보 (실제 ${JSON.stringify(hits)})`);
  ok(hits.every((h) => !h.unsure), '겹침 없음');
  const far = sparBuffers(DEMO_LOOP_SEC - 0.05, { gap: 0.6 });
  const farEvs = analyzeFrames(far.a, { stance: 'orthodox' }).summary.events;
  eq(detectHits(far.a, far.b, farEvs, far.overlap).length, 0, '멀면 후보 없음');
});

test('압박: 제자리면 아무도 전진하지 않음', () => {
  const d = sparBuffers(4);
  const p = pressure(d.a, d.b);
  eq(p.length, 4, '초 단위 구간');
  ok(p.every((x) => x.who === null), '전진 없음');
});

test('라운드 나누기: 짧은 자투리는 앞 라운드에 붙임', () => {
  eq(splitRounds(380000, 180).map((r) => [r.start, r.end]), [[0, 180000], [180000, 380000]], '20초 자투리는 붙임');
  eq(splitRounds(400000, 180).length, 3, '40초는 따로 라운드');
  eq(splitRounds(90000, null).length, 1, '영상 전체 한 라운드');
});

test('판정: 유효타가 많은 쪽이 우세, 신뢰도 낮으면 보류', () => {
  const base = {
    durMs: 360000, roundSec: 180,
    hitsMe: [{ t: 1000, kind: 'jab', target: 'head', guarded: false }, { t: 2000, kind: 'kick', target: 'body', guarded: false }, { t: 200000, kind: 'cross', target: 'head', guarded: false }],
    hitsOpp: [{ t: 190000, kind: 'kick', target: 'head', guarded: false }, { t: 191000, kind: 'kick', target: 'head', guarded: false }],
    attacksMe: [], attacksOpp: [], pressure: [],
    quality: { bothTrackedPct: 95, overlapPct: 5 },
  };
  const r = scoreRounds(base);
  eq(r.rounds.map((x) => x.winner), ['me', 'opp'], '라운드 승자');
  eq(r.total, { me: 19, opp: 19 }, '합계');
  eq(r.verdict, 'draw', '박빙');
  eq(r.confidence, 'high', '신뢰도');
  const low = scoreRounds({ ...base, hitsOpp: [], quality: { bothTrackedPct: 40, overlapPct: 50 } });
  eq([low.verdict, low.leaning], ['hold', 'me'], '판정 보류지만 기울기는 나');
  const guarded = scoreRounds({ ...base, roundSec: null, hitsMe: [{ t: 1, kind: 'jab', target: 'head', guarded: true }], hitsOpp: [] });
  eq(guarded.rounds[0].me.score, 1, '가드에 막혔을 수 있는 후보는 절반');
});

test('스파링 분석 전체: 데모 영상에서 판정과 신뢰도가 나옴', () => {
  const d = sparBuffers(DEMO_LOOP_SEC * 2);
  const r = analyzeSparring(d, { me: 'a', durMs: DEMO_LOOP_SEC * 2000 });
  eq(r.stance, { me: 'orthodox', opp: 'orthodox' }, '스탠스');
  eq(r.quality, { bothTrackedPct: 100, overlapPct: 0 }, '품질');
  eq(r.judge.confidence, 'high', '신뢰도');
  ok(['me', 'opp', 'draw'].includes(r.judge.verdict), '판정');
  ok(r.hits.some((h) => h.by === 'me') && r.hits.some((h) => h.by === 'opp'), '양쪽 유효타 후보');
});

// ---------- 펀치 종류 분류기 (BoxingVI 학습) ----------
test('분류기: JS 특징·확률이 파이썬 학습 코드와 일치', () => {
  for (const fx of FIXTURE) {
    const clip = fx.clip.map((f) => f.map((p) => (p[0] > 0 && p[1] > 0 ? p : null)));
    const r = punchFeatures(clip);
    ok(r, `${fx.kind} 특징 계산`);
    eq(r.features.length, fx.features.length, `${fx.kind} 특징 수`);
    const maxDiff = Math.max(...r.features.map((v, i) => Math.abs(v - fx.features[i])));
    ok(maxDiff < 1e-6, `${fx.kind} 특징 차이 ${maxDiff}`);
    const c = classifyFeatures(r.features);
    const pd = Math.max(...c.probs.map((v, i) => Math.abs(v - fx.proba[i])));
    ok(pd < 1e-4, `${fx.kind} 확률 차이 ${pd}`);
  }
});

test('분류기: MediaPipe 좌표를 COCO 순서로 바꿈', () => {
  const f = cocoFrame(demoFrameAt(0).image);
  ok(f[5] && f[6] && f[9] && f[10] && f[11], '어깨·손목·엉덩이');
  eq(f[1], null, '쓰지 않는 관절');
});

test('훅·어퍼컷 감지: 데모(잽·크로스·킥·가드 하락)에서는 하나도 세지 않음', () => {
  for (const stance of ['orthodox', 'southpaw']) {
    const an = createAnalyzer({ stance });
    for (let i = 0; i <= (DEMO_LOOP_SEC * 2 - 0.05) * 30; i++) an.update(demoFrameAt(i / 30, stance));
    const p = an.summary().punches;
    eq([p.hook, p.uppercut], [0, 0], `${stance} 훅·어퍼컷`);
  }
  const d = sparBuffers(DEMO_LOOP_SEC);
  const p = analyzeFrames(d.a).summary.punches;
  eq([p.hook, p.uppercut], [0, 0], '옆모습 데모');
});

test('분석 구간: 고른 구간의 프레임만, 영상 속 시각 그대로', () => {
  eq(frameTimes(2, 2).length, 5, '구간 없으면 영상 전체');
  const ts = frameTimes(10, 2, [[1, 2], [5, 6]]);
  eq(ts, [1, 1.5, 2, 5, 5.5, 6], '두 구간');
});

test('분석 구간: origin 0이면 이벤트 시각이 영상 속 시각', () => {
  const run = (offsetSec, origin) => {
    const an = createAnalyzer({ origin });
    for (let i = 0; i <= DEMO_LOOP_SEC * 30; i++) an.update({ ...demoFrameAt(i / 30, 'orthodox'), t: offsetSec * 1000 + (i / 30) * 1000 });
    return an.summary().events.filter((e) => e.type === 'punch' || e.type === 'kick');
  };
  const base = run(0, null);
  ok(base.length > 0, '데모에서 펀치·킥이 있어야 함');
  eq(run(60, 0).map((e) => Math.round(e.t - 60000)), base.map((e) => Math.round(e.t)), '60초 뒤 구간이면 60초 밀림');
  eq(run(60, null).map((e) => Math.round(e.t)), base.map((e) => Math.round(e.t)), '기준 없으면 첫 프레임 기준(실시간 훈련)');
});

test('스파링 구간: 고른 구간 하나가 한 라운드', () => {
  const hit = (t) => ({ t, kind: 'jab', target: 'head', guarded: false });
  const r = scoreRounds({
    durMs: 600000, roundSec: 180,
    roundRanges: [{ start: 10000, end: 130000 }, { start: 200000, end: 320000 }],
    hitsMe: [hit(20000), hit(30000), hit(150000)], hitsOpp: [hit(250000), hit(260000)],
    attacksMe: [], attacksOpp: [], pressure: [], quality: { bothTrackedPct: 90, overlapPct: 0 },
  });
  eq(r.rounds.map((x) => [x.start, x.end]), [[10000, 130000], [200000, 320000]], '라운드 = 고른 구간 (roundSec 무시)');
  eq(r.rounds.map((x) => x.winner), ['me', 'opp'], '구간 밖(150초) 유효타는 어느 라운드에도 안 들어감');
});

test('스트레이트: 팔을 뻗은 채 2초 두면(스트레칭) 세지 않고, 바로 회수하면 센다', () => {
  // 데모에서 첫 잽이 감지되는 시각을 찾아, 그 프레임을 2초 동안 그대로 두는 영상을 만든다
  const probe = createAnalyzer({ tune: { straightHoldMs: null } });
  let jabT = null;
  for (let i = 0; i <= DEMO_LOOP_SEC * 30 && jabT == null; i++) {
    const r = probe.update(demoFrameAt(i / 30));
    if (r.events.some((e) => e.type === 'punch' && e.kind === 'jab')) jabT = i / 30;
  }
  ok(jabT != null, '데모에 잽이 있어야 함');
  const run = (holdSec) => {
    const an = createAnalyzer();
    let t = 0;
    for (; t <= jabT; t += 1 / 30) an.update({ ...demoFrameAt(t), t: t * 1000 });
    const held = demoFrameAt(jabT);
    for (let k = 1; k <= holdSec * 30; k++) an.update({ ...held, t: (jabT + k / 30) * 1000 });
    for (let k = 1; k <= 30; k++) an.update({ ...demoFrameAt(jabT + k / 30), t: (jabT + holdSec + k / 30) * 1000 });
    return an.summary().punches.jab;
  };
  eq(run(0), 1, '바로 회수한 잽');
  eq(run(2), 0, '2초 뻗고 있던 팔');
});

test('스트레칭: 양팔을 옆으로 벌리거나 머리 위로 뻗으면 세지 않고, 앞으로 친 크로스는 센다', () => {
  // 직접 만든 자세(미터, y 아래 방향, z 음수 = 카메라 쪽). 어깨 높이 -0.5, 몸통 길이 0.5
  const P = (x, y, z) => ({ x, y, z, visibility: 1 });
  const guard = { l: [P(0.22, -0.3, -0.12), P(0.12, -0.55, -0.2)], r: [P(-0.22, -0.3, -0.12), P(-0.12, -0.55, -0.2)] };
  const pose = (arms) => {
    const w = new Array(33).fill(null);
    w[0] = P(0, -0.7, -0.05); w[9] = P(0.03, -0.63, -0.08); w[10] = P(-0.03, -0.63, -0.08);
    w[11] = P(0.18, -0.5, 0); w[12] = P(-0.18, -0.5, 0);
    [w[13], w[15]] = (arms.l || guard.l); [w[14], w[16]] = (arms.r || guard.r);
    w[23] = P(0.1, 0, 0); w[24] = P(-0.1, 0, 0); w[25] = P(0.1, 0.45, 0); w[26] = P(-0.1, 0.45, 0); w[27] = P(0.1, 0.9, 0); w[28] = P(-0.1, 0.9, 0);
    const image = w.map((p) => p && { x: 0.5 + p.x * 0.4, y: 0.5 + p.y * 0.4, visibility: 1 });
    return { world: w, image };
  };
  const run = (arms) => {
    const an = createAnalyzer({ stance: 'orthodox' });
    let t = 0;
    const feed = (f, n) => { for (let k = 0; k < n; k++) { an.update({ ...f, t }); t += 50; } };
    feed(pose({}), 10); feed(pose(arms), 4); feed(pose({}), 10);
    return jc(an.summary().punches);
  };
  const side = (s) => [P(s * 0.46, -0.5, 0), P(s * 0.74, -0.5, 0)];
  const up = (s) => [P(s * 0.2, -0.78, -0.02), P(s * 0.22, -1.06, -0.04)];
  eq(run({ l: side(1), r: side(-1) }), { jab: 0, cross: 0 }, '양팔 옆으로(T자)');
  eq(run({ l: up(1), r: up(-1) }), { jab: 0, cross: 0 }, '양팔 머리 위로');
  eq(run({ r: [P(-0.16, -0.5, -0.28), P(-0.14, -0.5, -0.56)] }), { jab: 0, cross: 1 }, '앞으로 친 크로스');
});

const failed = results.filter((r) => !r[1]);
document.getElementById('list').innerHTML = results.map(([n, pass, msg]) =>
  `<li class="${pass ? 'pass' : 'fail'}">${pass ? '✓' : '✗'} ${n}${msg ? `<pre>${msg}</pre>` : ''}</li>`).join('');
document.getElementById('result').textContent = failed.length ? `실패 ${failed.length} / ${results.length}` : `모두 통과 (${results.length})`;
document.title = failed.length ? 'FAIL' : 'PASS';
window.__testResults = results;
