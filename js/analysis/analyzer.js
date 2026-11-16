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

export function sidesFor(stance) {
  return stance === 'southpaw' ? { lead: 'r', rear: 'l' } : { lead: 'l', rear: 'r' };
}

/**
 * 프레임 단위 자세 분석기.
 * frame = { t: ms, world: 3D 랜드마크(미터, y 아래 방향), image: 정규화 랜드마크(가시성 판단용) }
 */
export function createAnalyzer({ stance = 'orthodox', level = 'beginner', curved = true, tune = {} } = {}) {
  const P = { ...DEFAULT_TUNE, ...tune };
  const { lead, rear } = sidesFor(stance);
  const role = { [lead]: 'lead', [rear]: 'rear' };
  const slack = GUARD_SLACK[level] ?? 0.2;

  const arm = { l: { ext: false, last: -1e9, retract: -1e9 }, r: { ext: false, last: -1e9, retract: -1e9 } };
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
  let startT = null;
  const strikes = curved ? createStrikeDetector(tune) : null;
  const straightTimes = { l: [], r: [] };
  const recoverTimes = { l: [], r: [] }; // 가드 하락에서 손을 다시 올린 시점 (어퍼컷으로 오인하지 않게)

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
    const guardLine = shY + slack * T; // y는 아래로 증가: 손목 y가 이보다 작으면 가드가 올라간 상태
    const ok = {};
    const below = {}; // 손목이 가드 라인보다 얼마나 아래인지(미터, +면 아래)

    for (const sd of ['l', 'r']) {
      const m = armMetrics(world, sd, T);
      const a = arm[sd];
      const atShoulderHeight = m.wrist.y < shY + 0.35 * T; // 팔을 늘어뜨린 것과 구분
      if (!a.ext && m.straight > P.straight && m.reach > P.reach && atShoulderHeight && t - a.last > PUNCH_MIN_GAP_MS) {
        a.ext = true;
        a.last = t;
        if (P.punchSource === 'rule') {
          const kind = role[sd] === 'lead' ? 'jab' : 'cross';
          s.punches[kind]++;
          straightTimes[sd].push(t);
          if (straightTimes[sd].length > 10) straightTimes[sd].shift();
          events.push({ type: 'punch', kind, hand: role[sd], side: sd, t: t - startT });
        }
      } else if (a.ext && (m.straight < RETRACT_STRAIGHT || m.reach < RETRACT_REACH)) {
        a.ext = false;
        a.retract = t;
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
          g.last = t;
          s.kicks[role[sd]]++;
          events.push({ type: 'kick', leg: role[sd], side: sd, t: t - startT });
        } else if (g.up && ankle.y > standingKnee.y + 0.1 * T) {
          g.up = false;
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
