import { createAnalyzer } from './analyzer.js';
import { frameCount, unpackFrame } from '../pose/frames.js';

/** 저장된 프레임 데이터 전체를 분석기에 통과시킨다. 스탠스를 바꿔 다시 계산할 때도 쓴다. */
export function analyzeFrames(buf, { stance = 'orthodox', level = 'beginner' } = {}) {
  const an = createAnalyzer({ stance, level });
  const n = frameCount(buf);
  const tracked = new Uint8Array(n);
  for (let i = 0; i < n; i++) tracked[i] = an.update(unpackFrame(buf, i)).tracked ? 1 : 0;
  return { summary: an.summary(), tracked };
}

/** 가드 하락 이벤트와 회복 이벤트를 묶어 구간으로 만든다. */
export function guardDropIntervals(events, endMs, dropDelayMs = 400) {
  const out = [];
  events.forEach((e, i) => {
    if (e.type !== 'guardDrop') return;
    const rec = events.slice(i + 1).find((x) => x.type === 'guardRecover' && x.hand === e.hand);
    const start = Math.max(0, e.t - dropDelayMs);
    const end = rec ? rec.t : endMs;
    out.push({ hand: e.hand, start, detect: e.t, end, downMs: rec ? rec.downMs : end - start, belowCm: rec ? rec.belowCm : null });
  });
  return out;
}

/** 리포트·기록에 저장하는 숫자들. */
export function sessionStats(summary) {
  return {
    guardPct: summary.guardPct,
    trackedPct: summary.trackedPct,
    punches: summary.punches,
    kicks: summary.kicks,
    guardDrops: summary.guardDrops,
    totalPunches: summary.totalPunches,
    totalKicks: summary.totalKicks,
    durationSec: Math.round(summary.activeMs / 1000),
    dropTimes: summary.events.filter((e) => e.type === 'guardDrop').slice(0, 300).map((e) => [Math.round(e.t), e.hand]),
  };
}
