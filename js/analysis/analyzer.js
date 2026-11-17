import { LM, allVisible, torso, armMetrics, dist } from './geometry.js';
import { createStrikeDetector } from './punch-classifier.js';

// 가드 판정 여유(몸통 길이 배수). 입문자는 너그럽게, 중급자는 엄격하게 (PRD 7절).
const GUARD_SLACK = { beginner: 0.25, intermediate: 0.1 };

// 판정 기준값. createAnalyzer({ tune })로 일부만 덮어쓸 수 있다(검증 도구 tools/validate 에서 사용).
export const DEFAULT_TUNE = {
  straight: 0.92,    // 팔 펴짐 이 이상이면 스트레이트 펀치
  reach: 0.85,       // 어깨~손목 거리 / 몸통 길이
  coreVis: 0.3,      // 양 어깨·팔꿈치·손목 가시성이 모두 이 이상이어야 분석
                     // (0.5 → 0.3: 옆모습에서 가려진 먼 팔 때문에 프레임을 버리던 문제. 실제 영상 검증, PROGRESS.md 참고)
  curvedProb: 0.55,  // 훅·어퍼컷: 분류기 확률이 이 이상이어야 센다
  guardFilter: true,   // 가드 하락 중이거나 손을 다시 올리는 순간의 타격 구간은 세지 않음
  // 킥: 발목이 반대쪽 무릎보다 올라간 뒤, 다리를 펴거나(엉덩이~발목 / 다리 길이) 발목을 엉덩이 근처까지 올려야 센다.
  // 달리기처럼 무릎을 굽힌 채 뒤꿈치만 올라가는 동작을 빼기 위함(실제 영상: 달리기는 펴짐 ≤ 0.80, 발목 높이 ≤ -0.46).
  kickExt: 0.85,
  kickAnkle: -0.35,  // (엉덩이 y - 발목 y) / 몸통 길이. 0이면 엉덩이 높이
  // 스트레이트(잽·크로스) 확인 조건. 팔을 펴는 순간이 아니라 다시 굽힐 때(회수) 센다 → 최대 straightHoldMs만큼 늦게 센다.
  // 준비운동·스트레칭·팔 흔들기가 펀치로 세지던 문제(펀치 없는 영상에서 분당 11개)를 줄이려고 넣었다.
  // 검증(2026-11-17): 펀치 없는 영상 분당 11.0 → 5.9, 직접 단 정답 영상 센 비율 그대로(48.7%), Mixkit 29.1 → 27.3%,
  // BoxingVI 35.8 → 34.7%. 인식이 끊긴 프레임은 시간에 넣지 않는다.
  straightHoldMs: 600,   // 이 시간 안에 회수해야 펀치. null이면 펴는 순간 바로 센다(이전 방식)
  // 아래 두 조건은 없는 펀치를 더 줄이지만(분당 4.4까지) 실제 펀치도 잃어서(BoxingVI -2~5%p, 높이 든 미트 치기) 기본은 끔
  straightPreBent: null, // 예: 0.82 — 펴기 직전 0.3초 안에 팔 펴짐이 이 값 이하였던 적이 있어야 펀치
  straightMaxRise: null, // 예: 0.3 — 손목이 어깨보다 몸통 길이 × 이 값 넘게 위면 펀치 아님
  // 준비운동·스트레칭이 펀치로 세지던 문제(펀치 없는 영상 분당 5.9)를 줄이는 조건 3개 (2026-11-17, PROGRESS.md 참고).
  // 검증: 펀치 없는 영상 47 → 25개(분당 3.2), 직접 단 정답 펀치 센 비율 그대로, BoxingVI 1,847개 중 2개만 잃음
  // - 양팔을 함께 옆으로 벌림(T자·팔 흔들기): 두 팔 모두 펴짐 ≥ 0.7이고, 두 팔 방향과 어깨선 바깥쪽의 코사인이 둘 다 이 값 이상이면 스트레이트 아님
  //   (실제 펀치는 두 값 중 작은 쪽이 최대 0.55. 옆모습 잽은 한 팔만 어깨선 방향이라 걸리지 않음)
  straightMaxSpread: 0.7,
  // - 두 손을 함께 머리 위로(머리 위 스트레칭): 두 손목 모두 어깨보다 몸통 길이 × 이 값 넘게 위면 스트레이트 아님
  straightBothRaised: 0.3,
  // - 훅·어퍼컷: 양팔이 함께 움직이면 아님. [반대 팔 이동 / 친 팔 이동 최소, 두 손목 세로 속도 상관 최소] (구간 시작 0.2초 전~끝)
  curvedMirror: [0.8, 0.85],
  punchSource: 'rule', //'rule': 스트레이트는 3D 규칙, 훅·어퍼컷은 분류기 / 'classifier': 모든 펀치를 분류기로
};
const RETRACT_STRAIGHT = 0.8;
const RETRACT_REACH = 0.6;
const PUNCH_MIN_GAP_MS = 180;
const RETURN_GRACE_MS = 350;   // 펀치를 회수하는 동안은 가드 하락으로 보지 않음
const GUARD_DROP_MS = 400;     // 이만큼 계속 내려가 있어야 오류로 기록
const KICK_MIN_GAP_MS = 400;
// 상체 모드: 엉덩이가 안 보이면 몸통 길이 대신 3D 어깨 너비 × 이 비율을 기준 길이로 쓴다.
export const UPPER_TORSO_RATIO = 1.4;
export const CURVED_MIN_PROB = DEFAULT_TUNE.curvedProb;
const STRAIGHT_OVERLAP_MS = 150;

const CORE = [LM.lSh, LM.rSh, LM.lEl, LM.rEl, LM.lWr, LM.rWr];
const HIPS = [LM.lHip, LM.rHip];
const LEGS = [LM.lKn, LM.rKn, LM.lAn, LM.rAn];

// 두 팔이 각자 어깨선 바깥쪽을 얼마나 향하는지(코사인) 중 작은 값. 양팔을 옆으로 벌리면 1에 가깝다.
function armsSpread(m, om) {
  const u = { x: m.shoulder.x - om.shoulder.x, y: m.shoulder.y - om.shoulder.y, z: m.shoulder.z - om.shoulder.z };
  const cos = (from, to, sign) => {
    const v = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const n = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
    return n ? (sign * (u.x * v.x + u.y * v.y + u.z * v.z)) / n : 0;
  };
  return Math.min(cos(m.shoulder, m.wrist, 1), cos(om.shoulder, om.wrist, -1));
}

export function sidesFor(stance) {
  return stance === 'southpaw' ? { lead: 'r', rear: 'l' } : { lead: 'l', rear: 'r' };
}

/**
 * 프레임 단위 자세 분석기.
 * frame = { t: ms, world: 3D 랜드마크(미터, y 아래 방향), image: 정규화 랜드마크(가시성 판단용) }
 */
// origin: 이벤트 시각(t)의 기준(ms). 없으면 첫 프레임 시각. 영상 분석은 0을 넘겨 영상 속 실제 시각으로 맞춘다(일부 구간만 분석할 때 필요).
export function createAnalyzer({ stance = 'orthodox', level = 'beginner', curved = true, tune = {}, origin = null } = {}) {
  const P = { ...DEFAULT_TUNE, ...tune };
  const { lead, rear } = sidesFor(stance);
  const role = { [lead]: 'lead', [rear]: 'rear' };
  const slack = GUARD_SLACK[level] ?? 0.2;

  const arm = { l: { ext: false, last: -1e9, retract: -1e9, hist: [], pending: null }, r: { ext: false, last: -1e9, retract: -1e9, hist: [], pending: null } };
  const hand = { l: { badSince: null, reported: false, worst: 0 }, r: { badSince: null, reported: false, worst: 0 } };
  const leg = { l: { up: false, last: -1e9 }, r: { up: false, last: -1e9 } };

  const s = {
    frames: 0, tracked: 0, upper: 0, guardOk: 0, activeMs: 0,
    punches: { jab: 0, cross: 0, hook: 0, uppercut: 0 },
    kicks: { lead: 0, rear: 0 },
    guardDrops: { lead: 0, rear: 0 },
    events: [],
  };
  let lastT = null;
  let startT = origin;
  const strikes = curved ? createStrikeDetector(tune) : null;
  const straightTimes = { l: [], r: [] };
  const recoverTimes = { l: [], r: [] }; // 가드 하락에서 손을 다시 올린 시점 (어퍼컷으로 오인하지 않게)
  const fh = []; // 최근 1.5초 인식된 프레임: { t, pl, pr: 손목 위치(어깨 기준, 몸통 길이 배수 [x, y, z]) }
  // 양팔이 함께 움직였는지: { ratio: 반대 팔 이동 / 친 팔 이동, corr: 두 손목 세로 속도 상관 }
  function mirror(side, t0, t1) {
    const hs = fh.filter((h) => h.t >= t0 && h.t <= t1);
    if (hs.length < 4) return null;
    const me = side === 'l' ? 'pl' : 'pr', ot = side === 'l' ? 'pr' : 'pl';
    let ps = 0, po = 0; const va = [], vb = [];
    for (let i = 1; i < hs.length; i++) {
      const a0 = hs[i - 1][me], a1 = hs[i][me], b0 = hs[i - 1][ot], b1 = hs[i][ot];
      ps += Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
      po += Math.hypot(b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]);
      va.push(a1[1] - a0[1]); vb.push(b1[1] - b0[1]);
    }
    const ma = va.reduce((x, y) => x + y, 0) / va.length, mb = vb.reduce((x, y) => x + y, 0) / vb.length;
    let num = 0, da = 0, db = 0;
    va.forEach((v, i) => { num += (v - ma) * (vb[i] - mb); da += (v - ma) ** 2; db += (vb[i] - mb) ** 2; });
    return { ratio: po / (ps + 1e-6), corr: num / Math.sqrt(da * db + 1e-12) };
  }

  // 분류기가 낸 타격 구간을 펀치로 센다.
  // rule 모드: 훅·어퍼컷만 (스트레이트는 3D 규칙), 같은 팔 스트레이트와 겹치면 뺀다. classifier 모드: 스트레이트도 잽/크로스로 센다.
  // 'none'(펀치 아님)과 가드 하락에서 손을 올리는 동작은 세지 않는다.
  function handleStrikes(list, events) {
    for (const st of list) {
      const curved = st.label === 'hook' || st.label === 'uppercut';
      const straight = st.label === 'straight' && P.punchSource === 'classifier';
      if (!curved && !straight) continue;
      if (st.prob < P.curvedProb) continue;
      if (P.punchSource === 'rule') {
        const overlaps = straightTimes[st.side].some((x) => x >= st.start - STRAIGHT_OVERLAP_MS && x <= st.end + STRAIGHT_OVERLAP_MS);
        if (overlaps) continue;
      }
      const recovering = recoverTimes[st.side].some((x) => x >= st.start - 300 && x <= st.end + 100) || hand[st.side].reported;
      if (recovering && P.guardFilter) continue;
      if (curved && P.curvedMirror) {
        const mm = mirror(st.side, st.start - 200, st.end);
        if (mm && mm.ratio >= P.curvedMirror[0] && mm.corr >= P.curvedMirror[1]) continue;
      }
      const kind = straight ? (role[st.side] === 'lead' ? 'jab' : 'cross') : st.label;
      s.punches[kind]++;
      events.push({ type: 'punch', kind, hand: role[st.side], side: st.side, t: st.end - startT, prob: Math.round(st.prob * 100) / 100 });
    }
  }

  function update(frame) {
    const { t, world, image } = frame;
    s.frames++;
    if (startT == null) startT = t;
    const dt = lastT == null ? 0 : Math.min(200, Math.max(0, t - lastT));
    lastT = t;
    s.activeMs += dt;

    // 2D 타격 구간은 양팔이 다 안 보이는 프레임에서도 계속 따라간다(분류기 모드에선 이때도 센다).
    const strikeOut = strikes ? strikes.update(t, image) : [];
    const vis = image || world;
    if (!world || !vis || !allVisible(vis, CORE, P.coreVis)) {
      const events = [];
      if (P.punchSource === 'classifier') { handleStrikes(strikeOut, events); s.events.push(...events); }
      return { tracked: false, events, guardOk: null, hot: null, mode: null };
    }
    s.tracked++;

    const fullBody = allVisible(vis, HIPS);
    if (!fullBody) s.upper++;
    const T = (fullBody ? torso(world) : dist(world[LM.lSh], world[LM.rSh]) * UPPER_TORSO_RATIO) || 0.5;
    const events = [];
    const shY = (world[LM.lSh].y + world[LM.rSh].y) / 2;
    const relWrist = (sd) => { const w = world[LM[sd + 'Wr']], o = world[LM[sd + 'Sh']]; return [(w.x - o.x) / T, (w.y - o.y) / T, (w.z - o.z) / T]; };
    fh.push({ t, pl: relWrist('l'), pr: relWrist('r') });
    while (fh.length && t - fh[0].t > 1500) fh.shift();
    const guardLine = shY + slack * T; // y는 아래로 증가: 손목 y가 이보다 작으면 가드가 올라간 상태
    const ok = {};
    const below = {}; // 손목이 가드 라인보다 얼마나 아래인지(미터, +면 아래)

    for (const sd of ['l', 'r']) {
      const m = armMetrics(world, sd, T);
      const a = arm[sd];
      const atShoulderHeight = m.wrist.y < shY + 0.35 * T; // 팔을 늘어뜨린 것과 구분
      // 펴짐 기록(펴기 직전에 팔이 굽어 있었는지 보려고 0.4초만 둔다)
      a.hist.push([t, m.straight]);
      while (a.hist.length && t - a.hist[0][0] > 400) a.hist.shift();
      const countStraight = (at) => {
        const kind = role[sd] === 'lead' ? 'jab' : 'cross';
        s.punches[kind]++;
        events.push({ type: 'punch', kind, hand: role[sd], side: sd, t: at - startT });
      };
      // 오래 뻗고 있으면 펀치 아님. 인식이 끊긴 프레임은 시간에 넣지 않는다(회수하는 순간이 안 보였을 수 있어서)
      if (a.pending != null) { a.pendingAge += dt; if (P.straightHoldMs != null && a.pendingAge > P.straightHoldMs) a.pending = null; }
      if (!a.ext && m.straight > P.straight && m.reach > P.reach && atShoulderHeight && t - a.last > PUNCH_MIN_GAP_MS) {
        a.ext = true;
        a.last = t;
        if (P.punchSource === 'rule') {
          straightTimes[sd].push(t);
          if (straightTimes[sd].length > 10) straightTimes[sd].shift();
          const wasBent = P.straightPreBent == null || a.hist.some(([ht, st]) => t - ht <= 300 && st <= P.straightPreBent);
          const notRaised = P.straightMaxRise == null || (m.shoulder.y - m.wrist.y) / T <= P.straightMaxRise;
          const om = armMetrics(world, sd === 'l' ? 'r' : 'l', T); // 반대 팔
          const notStretch = (P.straightMaxSpread == null || om.straight < 0.7 || armsSpread(m, om) < P.straightMaxSpread)
            && (P.straightBothRaised == null || Math.min(m.shoulder.y - m.wrist.y, om.shoulder.y - om.wrist.y) / T <= P.straightBothRaised);
          if (wasBent && notRaised && notStretch) {
            if (P.straightHoldMs == null) countStraight(t);
            else { a.pending = t; a.pendingAge = 0; } // 회수하면 센다
          }
        }
      } else if (a.ext && (m.straight < RETRACT_STRAIGHT || m.reach < RETRACT_REACH)) {
        a.ext = false;
        a.retract = t;
        if (a.pending != null) { countStraight(a.pending); a.pending = null; }
      }
      ok[sd] = m.wrist.y < guardLine || a.ext || t - a.retract < RETURN_GRACE_MS;
      below[sd] = m.wrist.y - guardLine;
    }

    let hot = null;
    for (const sd of ['l', 'r']) {
      const h = hand[sd];
      if (ok[sd]) {
        if (h.reported) {
          recoverTimes[sd].push(t);
          if (recoverTimes[sd].length > 5) recoverTimes[sd].shift();
          events.push({ type: 'guardRecover', hand: role[sd], t: t - startT, downMs: Math.round(t - h.badSince), belowCm: Math.max(0, Math.round(h.worst * 100)) });
        }
        h.badSince = null;
        h.reported = false;
        continue;
      }
      if (h.badSince == null) { h.badSince = t; h.worst = 0; }
      h.worst = Math.max(h.worst, below[sd]);
      if (!h.reported && t - h.badSince >= GUARD_DROP_MS) {
        h.reported = true;
        s.guardDrops[role[sd]]++;
        events.push({ type: 'guardDrop', hand: role[sd], t: t - startT });
      }
      if (h.reported) hot = LM[sd + 'Wr'];
    }

    const guardOk = ok.l && ok.r;
    if (guardOk) s.guardOk++;

    if (allVisible(vis, LEGS, 0.4)) {
      for (const sd of ['l', 'r']) {
        const other = sd === 'l' ? 'r' : 'l';
        const ankle = world[LM[sd + 'An']];
        const standingKnee = world[LM[other + 'Kn']];
        const g = leg[sd];
        if (!g.up && ankle.y < standingKnee.y && t - g.last > KICK_MIN_GAP_MS) {
          g.up = true;
          g.counted = false;
          g.last = t;
        } else if (g.up && ankle.y > standingKnee.y + 0.1 * T) {
          g.up = false;
        }
        if (g.up && !g.counted) {
          const hip = world[LM[sd + 'Hip']], knee = world[LM[sd + 'Kn']];
          const seg = dist(hip, knee) + dist(knee, ankle);
          const ext = seg ? dist(hip, ankle) / seg : 0;
          const ankleH = (hip.y - ankle.y) / T;
          if (ext >= P.kickExt || ankleH >= P.kickAnkle) {
            g.counted = true;
            s.kicks[role[sd]]++;
            events.push({ type: 'kick', leg: role[sd], side: sd, t: t - startT });
          }
        }
      }
    }

    if (P.punchSource === 'rule') handleStrikes(strikeOut, events);

    s.events.push(...events);
    return { tracked: true, events, guardOk, hot, mode: fullBody ? 'full' : 'upper' };
  }

  // 일시정지·휴식 뒤 재개할 때 시간 간격을 활동 시간에 넣지 않도록.
  function resume() { lastT = null; }

  // 훈련 중 화면 숫자용 (이벤트 목록 복사 없이 가볍게).
  function peek() {
    return {
      guardPct: s.tracked ? Math.round((s.guardOk / s.tracked) * 100) : null,
      totalPunches: s.punches.jab + s.punches.cross + s.punches.hook + s.punches.uppercut,
      totalKicks: s.kicks.lead + s.kicks.rear,
    };
  }

  function summary() {
    return {
      frames: s.frames,
      trackedFrames: s.tracked,
      trackedPct: s.frames ? Math.round((s.tracked / s.frames) * 100) : 0,
      upperPct: s.tracked ? Math.round((s.upper / s.tracked) * 100) : 0,
      guardPct: s.tracked ? Math.round((s.guardOk / s.tracked) * 100) : null,
      punches: { ...s.punches },
      kicks: { ...s.kicks },
      guardDrops: { ...s.guardDrops },
      totalPunches: s.punches.jab + s.punches.cross + s.punches.hook + s.punches.uppercut,
      totalKicks: s.kicks.lead + s.kicks.rear,
      activeMs: Math.round(s.activeMs),
      events: s.events.slice(),
    };
  }

  return { update, resume, peek, summary };
}
