// 스파링 분석 전체 흐름: 사람별 동작 → 상호작용 → 라운드 채점.
import { analyzeFrames } from '../analysis/offline.js';
import { inferStance, detectHits, pressure } from './interaction.js';
import { scoreRounds } from './judge.js';

/**
 * @param {{a: Float32Array, b: Float32Array, overlap: Uint8Array}} data
 * @param {{me: 'a'|'b', meStance?: string|null, level?: string, roundSec?: number|null, durMs: number}} opts
 */
export function analyzeSparring(data, { me = 'a', meStance = null, level = 'beginner', roundSec = null, durMs }) {
  const meBuf = me === 'a' ? data.a : data.b;
  const oppBuf = me === 'a' ? data.b : data.a;
  const stance = { me: meStance || inferStance(meBuf, oppBuf), opp: inferStance(oppBuf, meBuf) };

  const meRes = analyzeFrames(meBuf, { stance: stance.me, level });
  const oppRes = analyzeFrames(oppBuf, { stance: stance.opp, level });

  const attacks = (evs) => evs.filter((e) => e.type === 'punch' || e.type === 'kick');
  const hitsMe = detectHits(meBuf, oppBuf, meRes.summary.events, data.overlap).map((h) => ({ ...h, by: 'me' }));
  const hitsOpp = detectHits(oppBuf, meBuf, oppRes.summary.events, data.overlap).map((h) => ({ ...h, by: 'opp' }));

  const press = pressure(meBuf, oppBuf).map((p) => ({ t: p.t, who: p.who === 'a' ? 'me' : p.who === 'b' ? 'opp' : null }));

  const n = Math.min(meRes.tracked.length, oppRes.tracked.length);
  let both = 0, ov = 0;
  for (let i = 0; i < n; i++) {
    if (meRes.tracked[i] && oppRes.tracked[i]) both++;
    if (data.overlap?.[i]) ov++;
  }
  const quality = {
    bothTrackedPct: n ? Math.round((both / n) * 100) : 0,
    overlapPct: n ? Math.round((ov / n) * 100) : 0,
  };

  const judge = scoreRounds({
    durMs,
    roundSec,
    hitsMe,
    hitsOpp,
    attacksMe: attacks(meRes.summary.events),
    attacksOpp: attacks(oppRes.summary.events),
    pressure: press,
    quality,
  });

  return {
    stance,
    me: meRes.summary,
    opp: oppRes.summary,
    tracked: { me: meRes.tracked, opp: oppRes.tracked },
    hits: [...hitsMe, ...hitsOpp].sort((x, y) => x.t - y.t),
    pressure: press,
    quality,
    judge,
  };
}
