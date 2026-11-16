// 라운드별 채점과 AI 추정 우세 판정. 공식 판정이 아니라 영상에서 보이는 것만으로 낸 추정이다.

export const WEIGHTS = {
  hit: { punch: { head: 2, body: 1 }, kick: { head: 3, body: 2 } },
  guardedFactor: 0.5,     // 상대 가드에 막혔을 수 있는 후보는 절반만
  perAttack: 0.1,         // 던진 공격 1개당
  pressureMax: 1,         // 라운드의 절반 이상을 밀고 들어가면 최대
  drawMargin: 1,          // 라운드 점수 차가 이보다 작으면 박빙
};

const MIN_LAST_ROUND_MS = 30000;

export function splitRounds(durMs, roundSec) {
  if (!roundSec) return [{ start: 0, end: durMs }];
  const len = roundSec * 1000;
  const out = [];
  for (let s = 0; s < durMs; s += len) out.push({ start: s, end: Math.min(durMs, s + len) });
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < MIN_LAST_ROUND_MS) {
    const last = out.pop();
    out[out.length - 1].end = last.end; // 짧은 자투리는 앞 라운드에 붙인다
  }
  return out;
}

const inRange = (t, r) => t >= r.start && t < r.end;

function sideScore(hits, attacks, pressSecs, roundSecs) {
  let hitPts = 0, head = 0, body = 0;
  for (const h of hits) {
    const w = WEIGHTS.hit[h.kind === 'kick' ? 'kick' : 'punch'][h.target];
    hitPts += h.guarded ? w * WEIGHTS.guardedFactor : w;
    if (h.target === 'head') head++; else body++;
  }
  const pressRatio = roundSecs ? pressSecs / roundSecs : 0;
  const press = Math.min(WEIGHTS.pressureMax, pressRatio * 2 * WEIGHTS.pressureMax);
  const score = hitPts + attacks * WEIGHTS.perAttack + press;
  return { score: Math.round(score * 10) / 10, hitsHead: head, hitsBody: body, attacks, pressurePct: Math.round(pressRatio * 100) };
}

/**
 * @param {object} p
 * @param {number} p.durMs
 * @param {number|null} p.roundSec
 * @param {Array|null} p.roundRanges — 있으면 roundSec 대신 이 구간들이 라운드
 * @param {Array} p.hitsMe / p.hitsOpp — detectHits 결과
 * @param {Array} p.attacksMe / p.attacksOpp — 공격 이벤트(t)
 * @param {Array} p.pressure — [{t, who: 'me'|'opp'|null}]
 * @param {{bothTrackedPct:number, overlapPct:number}} p.quality
 */
export function scoreRounds({ durMs, roundSec = null, roundRanges = null, hitsMe, hitsOpp, attacksMe, attacksOpp, pressure, quality }) {
  // roundRanges: [{start, end}](ms) 분석 구간을 고른 경우 구간 하나가 한 라운드
  const split = roundRanges?.length ? roundRanges : splitRounds(durMs, roundSec);
  const rounds = split.map((r, i) => {
    const secs = pressure.filter((p) => inRange(p.t, r)).length || Math.max(1, Math.round((r.end - r.start) / 1000));
    const me = sideScore(hitsMe.filter((h) => inRange(h.t, r)), attacksMe.filter((a) => inRange(a.t, r)).length,
      pressure.filter((p) => p.who === 'me' && inRange(p.t, r)).length, secs);
    const opp = sideScore(hitsOpp.filter((h) => inRange(h.t, r)), attacksOpp.filter((a) => inRange(a.t, r)).length,
      pressure.filter((p) => p.who === 'opp' && inRange(p.t, r)).length, secs);
    const diff = me.score - opp.score;
    const winner = Math.abs(diff) < WEIGHTS.drawMargin ? 'draw' : diff > 0 ? 'me' : 'opp';
    const points = winner === 'draw' ? { me: 10, opp: 10 } : winner === 'me' ? { me: 10, opp: 9 } : { me: 9, opp: 10 };
    return { index: i + 1, start: r.start, end: r.end, me, opp, winner, points };
  });

  const total = rounds.reduce((a, r) => ({ me: a.me + r.points.me, opp: a.opp + r.points.opp }), { me: 0, opp: 0 });
  const q = quality || { bothTrackedPct: 0, overlapPct: 100 };
  const confidence = q.bothTrackedPct >= 80 && q.overlapPct <= 15 ? 'high'
    : q.bothTrackedPct >= 60 && q.overlapPct <= 30 ? 'medium' : 'low';
  const leaning = total.me > total.opp ? 'me' : total.me < total.opp ? 'opp' : 'draw';
  const verdict = confidence === 'low' ? 'hold' : leaning;
  return { rounds, total, verdict, leaning, confidence };
}
