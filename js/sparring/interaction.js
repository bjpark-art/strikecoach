// 두 사람 사이의 상호작용: 스탠스 추정, 유효타 후보, 압박(전진).
// 모두 화면 좌표(0~1) 기준. 카메라가 두 사람을 옆에서 찍었을 때 가장 정확하다.
import { frameCount, frameTime, unpackFrame, findFrame } from '../pose/frames.js';
import { bodyCenter } from './tracker.js';

const HEAD_REACH = 0.45;   // 상대 몸통 길이 대비: 주먹·발이 코에서 이 안이면 머리 도달
const BODY_REACH = 0.35;   // 상대 몸통 중심선에서 이 안이면 몸통 도달
const GUARD_NEAR = 0.35;   // 상대 손목이 코에서 이 안이면 가드가 막고 있었을 수 있음
const LOOKAHEAD = 4;       // 펀치 감지 뒤 몇 프레임까지 가장 멀리 뻗은 순간을 찾을지
const PRESS_STEP = 0.015;  // 1초 동안 이만큼(화면 폭 대비) 상대 쪽으로 움직이면 전진

const vis = (p, m = 0.4) => p && (p.visibility ?? 1) >= m;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy || 1e-9;
  const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return Math.hypot(p.x - (a.x + k * dx), p.y - (a.y + k * dy));
}

function torsoLine(img) {
  const sh = { x: (img[11].x + img[12].x) / 2, y: (img[11].y + img[12].y) / 2 };
  const hipsOk = vis(img[23]) && vis(img[24]);
  const hp = hipsOk ? { x: (img[23].x + img[24].x) / 2, y: (img[23].y + img[24].y) / 2 } : null;
  const len = hp ? dist(sh, hp) : Math.hypot(img[11].x - img[12].x, img[11].y - img[12].y) * 1.4;
  return { sh, hp: hp || { x: sh.x, y: sh.y + len }, len: len || 0.2 };
}

/** 상대에게 더 가까이 있는 손을 앞손으로 보고 스탠스를 추정한다. */
export function inferStance(selfBuf, oppBuf) {
  let left = 0, right = 0;
  const n = Math.min(frameCount(selfBuf), frameCount(oppBuf));
  for (let i = 0; i < n; i += 2) {
    const me = unpackFrame(selfBuf, i).image, op = unpackFrame(oppBuf, i).image;
    if (!me || !op || !vis(me[15]) || !vis(me[16])) continue;
    const oc = bodyCenter(op);
    if (!oc) continue;
    if (dist(me[15], oc) < dist(me[16], oc)) left++; else right++;
  }
  return right > left ? 'southpaw' : 'orthodox';
}

/**
 * 공격자의 펀치·킥 이벤트마다, 뻗은 순간 주먹(발)이 상대 머리·몸통 근처까지 갔는지 본다.
 * @returns [{ t, kind, target: 'head'|'body', guarded, unsure }]
 */
// origin: 이벤트 시각의 기준(ms). 없으면 첫 프레임 시각(analyzeFrames 기본값과 같음).
export function detectHits(attBuf, defBuf, events, overlap = null, origin = null) {
  const out = [];
  const n = Math.min(frameCount(attBuf), frameCount(defBuf));
  const t0 = origin ?? (frameCount(attBuf) ? frameTime(attBuf, 0) : 0);
  for (const e of events) {
    if (e.type !== 'punch' && e.type !== 'kick') continue;
    const idx = e.type === 'punch' ? (e.side === 'l' ? 15 : 16) : (e.side === 'l' ? 27 : 28);
    const sh = e.type === 'punch' ? (e.side === 'l' ? 11 : 12) : (e.side === 'l' ? 23 : 24);
    const i0 = findFrame(attBuf, e.t + t0);
    let best = null;
    for (let i = i0; i < Math.min(n, i0 + LOOKAHEAD); i++) {
      const at = unpackFrame(attBuf, i).image, df = unpackFrame(defBuf, i).image;
      if (!at || !df || !vis(at[idx]) || !vis(df[11]) || !vis(df[12])) continue;
      const tip = at[idx];
      const tl = torsoLine(df);
      // 주먹(발)이 어깨(엉덩이)보다 상대에게 더 가까워야 상대 쪽으로 뻗은 것
      if (vis(at[sh]) && dist(tip, tl.sh) >= dist(at[sh], tl.sh)) continue;
      const head = vis(df[0]) ? dist(tip, df[0]) / tl.len : Infinity;
      const body = distToSegment(tip, tl.sh, tl.hp) / tl.len;
      const target = head < HEAD_REACH ? 'head' : body < BODY_REACH ? 'body' : null;
      if (!target) continue;
      const score = target === 'head' ? head : body;
      if (!best || score < best.score) {
        const guarded = target === 'head'
          ? [15, 16].some((w) => vis(df[w]) && vis(df[0]) && dist(df[w], df[0]) / tl.len < GUARD_NEAR)
          : [13, 14].some((el) => vis(df[el]) && dist(df[el], tip) / tl.len < 0.25);
        best = { i, target, score, guarded };
      }
    }
    if (best) {
      out.push({
        t: e.t,
        kind: e.type === 'kick' ? 'kick' : e.kind,
        target: best.target,
        guarded: best.guarded,
        unsure: !!(overlap && overlap[best.i]),
      });
    }
  }
  return out;
}

/** 1초 단위로 누가 상대 쪽으로 밀고 들어갔는지. [{ t, who: 'a'|'b'|null }] */
export function pressure(aBuf, bBuf, origin = null) {
  const n = Math.min(frameCount(aBuf), frameCount(bBuf));
  if (!n) return [];
  const t0 = origin ?? frameTime(aBuf, 0);
  const centerAt = (buf, i) => { const im = unpackFrame(buf, i).image; return im ? bodyCenter(im) : null; };
  const out = [];
  let i = 0;
  while (i < n) {
    const tStart = frameTime(aBuf, i);
    let j = i;
    while (j + 1 < n && frameTime(aBuf, j + 1) - tStart < 1000) j++;
    const a0 = centerAt(aBuf, i), a1 = centerAt(aBuf, j), b0 = centerAt(bBuf, i), b1 = centerAt(bBuf, j);
    let who = null;
    if (a0 && a1 && b0 && b1 && j > i) {
      const dirA = Math.sign(b0.x - a0.x) || 1; // A가 B를 향하는 방향
      const advA = (a1.x - a0.x) * dirA;
      const advB = (b1.x - b0.x) * -dirA;
      if (advA > PRESS_STEP && advA > advB) who = 'a';
      else if (advB > PRESS_STEP && advB > advA) who = 'b';
    }
    out.push({ t: tStart - t0, who });
    i = j + 1;
  }
  return out;
}
