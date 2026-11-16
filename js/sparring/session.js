// 스파링 세션 저장·재계산. 고르기 화면, 리포트(스탠스 바꾸기), 리뷰(두 사람 바꾸기)에서 함께 쓴다.
import { saveSession } from '../store.js';
import { sessionStats } from '../analysis/offline.js';
import { analyzeSparring } from './analyze.js';

export function buildSparringSession(base, data, { me, meStance = null }) {
  const durMs = Math.round(base.videoDurationSec * 1000);
  // 앱의 영상 프레임은 영상 속 시각으로 저장돼 있어 origin 0(전체 분석이면 첫 프레임이 0초라 결과가 같다)
  const r = analyzeSparring(data, { me, meStance, level: base.level, roundSec: base.roundSec, durMs, ranges: base.ranges, origin: 0 });
  const meStats = sessionStats(r.me);
  return {
    ...base,
    source: 'sparring',
    me,
    meStanceManual: !!meStance,
    stance: r.stance.me,
    oppStance: r.stance.opp,
    ...meStats,                       // 기존 화면(홈 기록 등)이 그대로 읽을 수 있게
    oppStats: sessionStats(r.opp),
    hits: r.hits.map((h) => ({ t: Math.round(h.t), by: h.by, kind: h.kind, target: h.target, guarded: h.guarded, unsure: h.unsure })),
    pressureSecs: {
      me: r.pressure.filter((p) => p.who === 'me').length,
      opp: r.pressure.filter((p) => p.who === 'opp').length,
      total: r.pressure.length,
    },
    quality: r.quality,
    judge: r.judge,
  };
}

export function recomputeAndSave(session, data, opts = {}) {
  const next = buildSparringSession(session, data, {
    me: opts.me ?? session.me,
    meStance: opts.meStance !== undefined ? opts.meStance : (session.meStanceManual ? session.stance : null),
  });
  saveSession(next);
  return next;
}
