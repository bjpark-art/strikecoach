// 프레임마다 감지된 사람들을 A/B 두 사람으로 이어 붙인다 (화면 좌표 기준).
// createTracker: 스파링(A/B = 두 선수). createSoloTracker: 혼자 훈련(여러 감지 중 나를 고름).
import { STRIDE, frameCount } from '../pose/frames.js';
import { appearanceDist, blendAppearance } from '../pose/appearance.js';

const OVERLAP_RATIO = 0.6;     // 두 중심 거리가 몸통 길이의 이 배수보다 가까우면 겹침

const v = (p) => (p ? p.visibility ?? 1 : 0);

/** 사람의 중심(어깨·엉덩이 평균)과 크기(화면상 몸통 길이). */
export function bodyCenter(image) {
  const pts = [11, 12, 23, 24].map((i) => image[i]).filter((p) => v(p) >= 0.3);
  if (!pts.length) return null;
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  const sh = image[11] && image[12] ? { x: (image[11].x + image[12].x) / 2, y: (image[11].y + image[12].y) / 2 } : null;
  const hp = v(image[23]) >= 0.3 && v(image[24]) >= 0.3 ? { x: (image[23].x + image[24].x) / 2, y: (image[23].y + image[24].y) / 2 } : null;
  let size = sh && hp ? Math.hypot(sh.x - hp.x, sh.y - hp.y) : 0;
  if (!size && image[11] && image[12]) size = Math.hypot(image[11].x - image[12].x, image[11].y - image[12].y) * 1.4;
  return { ...c, size: size || 0.2 };
}

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 사람 몸으로 말이 되는 뼈대인지(opts.standing: 앉은 사람도 거름 — 스파링에서 벽 쪽 관중). MediaPipe가 붙어 있는 두 사람을 섞어 한 뼈대로 내거나(팔·다리가 다른 사람까지 뻗음)
 * 한 사람 위에 엉뚱한 뼈대를 그릴 때 거른다. 몸통(어깨 가운데~엉덩이 가운데) 길이 L을 기준으로
 *  - 몸통이 누워 있지 않음(어깨가 엉덩이보다 0.3L 이상 위 — 약 70도까지 숙임은 괜찮음), 어깨 폭 < 1.8L, 엉덩이 폭 < 1.5L
 *  - 위팔·아래팔 < 2L, 허벅지·정강이 < 2.2L (보이는 마디만)
 */
export const PLAUSIBLE = { up: 0.3, shoulder: 1.8, hip: 1.5, arm: 2.0, leg: 2.2 };
export function plausibleBody(image, aspect = 1, opts = {}) {
  const ok = (j) => image[j] && (image[j].visibility ?? 1) >= 0.3;
  // 몸통(어깨·엉덩이)이 확실히 화면 안에 보일 때만 판단한다. 가까이 찍어 몸 일부만 나온 장면(상체만·다리만)은
  // MediaPipe가 안 보이는 관절을 짐작해 비율이 어긋나도 팔·다리 위치는 쓸 만해서 버리지 않는다
  const inFrame = (j) => image[j] && (image[j].visibility ?? 1) >= 0.6 && image[j].x > 0.02 && image[j].x < 0.98 && image[j].y > 0.02 && image[j].y < 0.98;
  if (![11, 12, 23, 24].every(inFrame)) return true;
  // 화면 좌표(0~1)는 가로·세로 단위가 달라서 세로 기준 픽셀 비율로 바꿔 잰다(aspect = 가로/세로)
  const P = (j) => ({ x: image[j].x * aspect, y: image[j].y });
  const sh = { x: (P(11).x + P(12).x) / 2, y: (P(11).y + P(12).y) / 2 };
  const hp = { x: (P(23).x + P(24).x) / 2, y: (P(23).y + P(24).y) / 2 };
  const L = d2(sh, hp);
  if (L < 1e-3 || hp.y - sh.y < PLAUSIBLE.up * L) return false;
  if (d2(P(11), P(12)) > PLAUSIBLE.shoulder * L || d2(P(23), P(24)) > PLAUSIBLE.hip * L) return false;
  for (const [a, b, lim] of [[11, 13, 'arm'], [13, 15, 'arm'], [12, 14, 'arm'], [14, 16, 'arm'], [23, 25, 'leg'], [25, 27, 'leg'], [24, 26, 'leg'], [26, 28, 'leg']]) {
    if (ok(a) && ok(b) && d2(P(a), P(b)) > PLAUSIBLE[lim] * L) return false;
  }
  if (opts.standing) {
    // 앉은 사람(체육관 벽 쪽 관중·대기자): 두 허벅지가 다 수평에 가깝다(무릎이 엉덩이 높이 근처). 선수는 킥 때도 한쪽 다리는 딛고 있다
    // 앉은 자세: 두 허벅지가 수평에 가깝고 두 정강이는 무릎에서 발목까지 아래로 섰음(발목이 보여야 판단 — 가까이 찍혀 다리가 잘린 선수는 거르지 않음)
    const seat = [[23, 25, 27], [24, 26, 28]].filter(([h, k, a]) => {
      if (!inFrame(h) || !inFrame(k) || !inFrame(a)) return false;
      const thigh = d2(P(h), P(k));
      return P(k).y - P(h).y < 0.35 * thigh && P(a).y - P(k).y > 0.6 * thigh;
    });
    if (seat.length === 2) return false;
  }
  return true;
}

// 같은 사람을 두 번 감지했는지: 어깨·엉덩이 4점이 거의 같은 자리(평균 거리 < 몸통 길이 × DUP_RATIO)
const DUP_RATIO = 0.25;
const CORE4 = [11, 12, 23, 24];
function sameBody(p, q) {
  let sum = 0, n = 0;
  for (const j of CORE4) {
    const a = p.d.image[j], b = q.d.image[j];
    if (v(a) < 0.3 || v(b) < 0.3) continue;
    sum += d2(a, b); n++;
  }
  return n >= 2 && sum / n < DUP_RATIO * Math.max(p.c.size, q.c.size);
}
const quality = (image) => [11, 12, 13, 14, 15, 16, 23, 24].reduce((s, j) => s + v(image[j]), 0);

// 줄(A/B)과 감지의 거리 비용(몸통 길이 단위). 움직이던 방향으로 예측한 자리와 비교하고, 크기 차이와 오래 안 보인 시간을 더한다.
const NEW_COST = 4;         // 아직 아무도 맡지 않은 줄
const AGE_COST = 0.5;       // 안 보인 1초마다 더하는 비용(방금까지 따라가던 줄을 우선)
const SIZE_COST = 1.5;
// 감지가 하나뿐인데 방금까지 보이던 두 사람 어느 쪽과도 멀면(비용 > REJECT_COST) 아무에게도 주지 않는다
// (MediaPipe가 두 사람 팔다리를 섞어 만든 뼈대가 한 사람에게 붙는 것을 막음)
// color: 옷 색 차이 1당 비용(몸통 길이 단위). 감지에 app(생김새, pose/appearance.js)이 있을 때만 쓴다.
// 같은 사람의 색 차이는 대개 0.01~0.04(가끔 0.1), 다른 두 사람은 0.06~0.3(Pexels 스파링 5개) → 0.1 차이 ≈ 몸통 길이 1만큼 멀리 있는 것
// colorMax: 옷 색 비용의 상한(조명이 바뀌거나 색을 잘못 읽어도 위치가 맞으면 그 사람)
export const TRACK_TUNE = { reject: 1.5, color: 10, colorMax: 1 };
const COLOR_MAX = 1; // 혼자 훈련

export function createTracker() {
  const tr = { a: null, b: null }; // { x, y, size, vx, vy, t }
  const prev = { a: null, b: null }; // 겹침 판정용 마지막 중심(예전과 같음)
  let frameNo = 0;

  function cost(k, it, t) {
    const s = tr[k];
    if (!s) return NEW_COST;
    const age = t - s.t;
    const col = TRACK_TUNE.color && it.d.app && s.app ? Math.min(TRACK_TUNE.colorMax, TRACK_TUNE.color * appearanceDist(it.d.app, s.app)) : 0;
    const lead = Math.min(age, 300) / 1000;
    const px = s.x + s.vx * lead, py = s.y + s.vy * lead;
    const size = Math.max(0.05, (s.size + it.c.size) / 2);
    let c = Math.hypot(it.c.x - px, it.c.y - py) / size + SIZE_COST * Math.abs(Math.log(it.c.size / Math.max(0.02, s.size)));
    return c + col + (Math.min(age, 5000) / 1000) * AGE_COST;
  }

  function update(k, it, t) {
    const s = tr[k];
    if (s && t > s.t && t - s.t <= 500) {
      const dt = (t - s.t) / 1000;
      s.vx = 0.6 * s.vx + 0.4 * (it.c.x - s.x) / dt;
      s.vy = 0.6 * s.vy + 0.4 * (it.c.y - s.y) / dt;
      s.size = 0.8 * s.size + 0.2 * it.c.size;
    } else if (s) { s.vx = 0; s.vy = 0; s.size = it.c.size; }
    tr[k] = { ...(tr[k] || { vx: 0, vy: 0, size: it.c.size }), x: it.c.x, y: it.c.y, t };
    if (it.d.app && it.sure) tr[k].app = blendAppearance(tr[k].app, it.d.app, tr[k].app ? 0.1 : 1); // 확실할 때만 생김새를 배움
  }

  /** dets: [{image, world}], t: 프레임 시각(ms, 없으면 초당 20장으로 셈) → { a, b, overlap } */
  function assign(dets, t = null) {
    if (t == null) t = frameNo * 50;
    frameNo++;
    let items = dets.map((d) => ({ d, c: bodyCenter(d.image), q: quality(d.image) })).filter((x) => x.c);
    // 같은 사람을 두 번 잡았으면 더 잘 보이는 하나만 남긴다(한 사람만 있을 때 뼈대가 두 줄로 겹쳐 "나"가 "상대"로 넘어가던 문제)
    // 겹친 둘 중에는 방금까지 따라가던 사람과 이어지는(위치·옷 색이 맞는) 쪽을 남긴다. 처음엔 더 잘 보이는 쪽
    // (사람이 내 앞을 지나갈 때 나 대신 지나가는 사람이 남아 뼈대가 넘어가던 문제)
    if (tr.a || tr.b) for (const it of items) it.k = Math.min(tr.a ? cost('a', it, t) : Infinity, tr.b ? cost('b', it, t) : Infinity);
    items.sort((p, q) => (p.k ?? 0) - (q.k ?? 0) || q.q - p.q);
    const kept = [];
    for (const it of items) if (!kept.some((k) => sameBody(k, it))) kept.push(it);
    items = kept.slice(0, 2);
    let a = null, b = null;

    if (items.length === 2) {
      const [p, q] = items;
      if (!tr.a && !tr.b) {
        [a, b] = p.c.x <= q.c.x ? [p, q] : [q, p]; // 처음엔 왼쪽 사람을 A로
      } else {
        const keep = cost('a', p, t) + cost('b', q, t);
        const swap = cost('a', q, t) + cost('b', p, t);
        [a, b] = keep <= swap ? [p, q] : [q, p];
      }
    } else if (items.length === 1) {
      const x = items[0];
      if (!tr.a && !tr.b) a = x;
      else {
        const ca = cost('a', x, t), cb = cost('b', x, t);
        let k = ca <= cb ? 'a' : 'b';
        const o = k === 'a' ? 'b' : 'a';
        const recent = (q) => tr[q] && t - tr[q].t < 500;
        if (TRACK_TUNE.reject != null && recent(k) && Math.min(ca, cb) > TRACK_TUNE.reject && tr[o]) {
          k = recent(o) ? null : o; // 둘 다 방금 보였으면 버리고, 다른 사람이 잠깐 안 보이던 중이면 그 사람에게
        }
        if (k === 'a') a = x; else if (k === 'b') b = x;
      }
    }

    // 생김새를 배워도 되는 경우: 두 사람이 떨어져 있거나(겹치지 않음) 한 사람만 있는데 방금 따라가던 사람과 가까움
    if (a && b) { const sep = d2(a.c, b.c) > 0.8 * (a.c.size + b.c.size) / 2; a.sure = sep; b.sure = sep; }
    else if (a || b) { const x = a || b, k = a ? 'a' : 'b'; x.sure = !tr[k] || cost(k, x, t) < 0.8; }

    let overlap = 0;
    if (a && b) {
      const size = (a.c.size + b.c.size) / 2;
      if (d2(a.c, b.c) < size * OVERLAP_RATIO) overlap = 1;
    } else if ((a || b) && prev.a && prev.b) {
      // 한 사람이 갑자기 안 보임 → 겹쳐서 가려졌을 가능성
      const size = (prev.a.size + prev.b.size) / 2;
      if (d2(prev.a, prev.b) < size * 1.5) overlap = 1;
    }

    if (a) { update('a', a, t); prev.a = a.c; }
    if (b) { update('b', b, t); prev.b = b.c; }
    return { a: a ? a.d : null, b: b ? b.d : null, overlap };
  }

  return { assign };
}

/**
 * 혼자 훈련: 감지된 사람들 중 "나"를 프레임마다 고른다. 감지에 primary: true가 있으면 그 뼈대(한 사람 모드, 더 정확)를 우선한다. 두 사람 신원을 끝까지 나눠 따라가는 대신
 * (같은 사람을 잠깐 두 번 감지하면 내가 "다른 사람" 줄로 넘어가 끝까지 안 돌아오던 문제) 방금 고른 나와 이어지는 사람을 고른다.
 *  - 둘이 보이면: 방금 내 자리(움직이던 방향으로 예측)와 가깝고 크기·옷 색이 비슷한 쪽
 *  - 하나만 보이면: 나로 본다. 단, 방금(1초 안) 떨어진 두 사람이 보였고 이 감지가 내 자리에서 멀고 그 다른 사람 자리에 있으면 다른 사람
 *  - 처음(또는 1.5초 넘게 나를 못 봤을 때) 둘이 보이면 primary, 없으면 크고 가운데 가까운 쪽
 */
export const SOLO_TUNE = { far: 1.5, twoMs: 1000, lostMs: 1500, relockFrames: 20 };
const PRIMARY_BONUS = 0.5;
export function createSoloTracker() {
  let me = null;      // { x, y, size, vx, vy, t, app }
  let twoAt = -1e9;   // 두 사람이 함께 보인 마지막 시각
  let other = null;   // 그때 나 아닌 사람의 자리
  let lastP = null;   // 직전 한 사람 모드 뼈대 { c, t, ok: 받아들였는지 }
  let pending = null; // 내 자리에서 멀리 떨어져 이어지는 감지 { c, t, n }
  let frameNo = 0;
  const mainScore = (it) => it.c.size * (1 - 0.8 * Math.abs(it.c.x - 0.5));
  function cost(it, t) {
    const lead = Math.min(t - me.t, 300) / 1000;
    const px = me.x + me.vx * lead, py = me.y + me.vy * lead;
    const size = Math.max(0.05, (me.size + it.c.size) / 2);
    const col = it.d.app && me.app ? Math.min(COLOR_MAX, TRACK_TUNE.color * appearanceDist(it.d.app, me.app)) : 0;
    return Math.hypot(it.c.x - px, it.c.y - py) / size + SIZE_COST * Math.abs(Math.log(it.c.size / Math.max(0.02, me.size))) + col;
  }
  function assign(dets, t = null) {
    if (t == null) t = frameNo * 50;
    frameNo++;
    let items = dets.map((d) => ({ d, c: bodyCenter(d.image), q: quality(d.image) })).filter((x) => x.c);
    const fresh = me && t - me.t <= SOLO_TUNE.lostMs;
    if (fresh) for (const it of items) it.k = cost(it, t);
    // primary(한 사람 모드 MediaPipe의 뼈대, 더 정확함)를 같은 사람의 다른 감지보다 먼저 남긴다
    // 한 사람 모드 뼈대가 직전에 받아들인 뼈대에서 이어지면 같은 사람 중복 감지 중 늘 그것을 남긴다
    const prim0 = items.find((it) => it.d.primary);
    const contP = prim0 && lastP && lastP.ok && t - lastP.t <= 150 && d2(prim0.c, lastP.c) < 0.5 * Math.max(0.05, prim0.c.size, lastP.c.size);
    const rank = (it) => (contP && it === prim0 ? -Infinity : (it.k ?? 0) - (it.d.primary ? PRIMARY_BONUS : 0));
    items.sort((p, q) => rank(p) - rank(q) || (q.d.primary ? 1 : 0) - (p.d.primary ? 1 : 0) || q.q - p.q);
    const kept = [];
    for (const it of items) if (!kept.some((k) => sameBody(k, it))) kept.push(it);
    items = kept;
    // "내가 다른 곳에 있다"는 증거: 서로 몸통 길이 넘게 떨어진 두 사람이 보이고 그중 하나가 방금 내 자리와 이어짐
    // (두 사람 모드가 같은 사람을 두 번 잡은 것은 증거가 아님 — 예전엔 이것도 두 사람으로 쳐서 맞는 뼈대를 계속 버렸음)
    if (fresh && items.length >= 2) {
      const [p, q] = items;
      const apart = d2(p.c, q.c) > Math.max(p.c.size, q.c.size);
      if (apart && Math.min(p.k, q.k) < SOLO_TUNE.far) { twoAt = t; other = (p.k <= q.k ? q : p).c; } // 나 아닌 쪽의 자리
    }
    let pick = null;
    // 처음(또는 오래 놓친 뒤): 한 사람 모드가 고른 사람(primary)이 있으면 그 사람, 없으면 크고 가운데 가까운 쪽
    const primC = contP ? prim0 : null;
    // 한 사람 모드 뼈대가 직전에 받아들인 뼈대에서 이어지면 그대로 쓴다(두 사람 모드 뼈대는 덜 정확하고, 5프레임마다 끼어들면 뼈대가 들쭉날쭉함)
    if (items.length >= 2 && contP) pick = primC;
    else if (items.length >= 2) pick = fresh ? items[0] : items.find((it) => it.d.primary) || items.reduce((a, b) => (mainScore(b) > mainScore(a) ? b : a));
    else if (items.length === 1) {
      const x = items[0];
      // 버리는 경우: 방금 다른 사람이 보인 자리에 이 감지가 있음(한 사람 모드가 그 사람으로 넘어감).
      // 그냥 멀기만 한 것(킥처럼 자세가 크게 바뀜, 샌드백을 사람으로 본 것)은 버리지 않는다
      const onOther = other && d2(x.c, other) < Math.max(x.c.size, 0.05);
      // 직전 프레임에 받아들인 한 사람 모드 뼈대에서 끊김 없이 이어지면(같은 사람을 계속 추적 중) 버리지 않는다.
      // 다른 사람으로 넘어갈 때는 뼈대가 한 번에 튄다(킥·무릎으로 자세가 크게 바뀌어도 이어짐은 유지됨)
      const cont = x.d.primary && lastP && lastP.ok && t - lastP.t <= 150 && d2(x.c, lastP.c) < 0.5 * Math.max(0.05, x.c.size, lastP.c.size);
      pick = fresh && !cont && t - twoAt < SOLO_TUNE.twoMs && x.k > SOLO_TUNE.far && onOther ? null : x;
    }
    // 두 사람 모드 뼈대는 방금까지 따라가던 나와 이어질 때만 쓴다(덜 정확함). 영상 처음처럼 아직 나를 모를 때는 쓰지 않는다
    if (pick && !pick.d.primary && !(fresh && (pick.k ?? Infinity) < SOLO_TUNE.far)) pick = null;
    const prim = items.find((it) => it.d.primary);
    if (prim) lastP = { c: prim.c, t, ok: pick === prim };
    // 내 자리 기억은 멀리 떨어지고 몸 크기가 두 배 넘게 다른 감지로 바로 옮기지 않는다: 1초(20프레임) 넘게 이어질 때만 옮김.
    // (한 사람 모드가 잠깐 샌드백·다른 사람으로 튀었다 돌아올 때, 돌아온 진짜 나를 "다른 사람"으로 버리던 문제)
    let move = true;
    if (pick && fresh && (pick.k ?? 0) > SOLO_TUNE.far && Math.abs(Math.log(Math.max(0.02, pick.c.size) / Math.max(0.02, me.size))) > Math.log(2)) {
      const sz = Math.max(0.05, pick.c.size);
      pending = pending && t - pending.t <= 150 && d2(pending.c, pick.c) < 0.5 * sz ? { c: pick.c, t, n: pending.n + 1 } : { c: pick.c, t, n: 1 };
      move = pending.n >= SOLO_TUNE.relockFrames;
    } else if (pick) pending = null;
    if (pick && move) {
      const sure = items.length === 1 || !fresh || (items[1] && items[1].k - pick.k > 1);
      if (me && t > me.t && t - me.t <= 500) {
        const dt = (t - me.t) / 1000;
        me.vx = 0.6 * me.vx + 0.4 * (pick.c.x - me.x) / dt;
        me.vy = 0.6 * me.vy + 0.4 * (pick.c.y - me.y) / dt;
        me.size = 0.8 * me.size + 0.2 * pick.c.size;
      } else me = { vx: 0, vy: 0, size: pick.c.size, app: me?.app };
      Object.assign(me, { x: pick.c.x, y: pick.c.y, t });
      if (pick.d.app && sure) me.app = blendAppearance(me.app, pick.d.app, me.app ? 0.1 : 1);
    }
    return pick ? pick.d : null;
  }
  return { assign };
}

/** i번째 프레임부터 A/B를 서로 바꾼다 (리뷰에서 수동 보정). 두 버퍼를 제자리에서 바꾼다. */
export function swapFrom(a, b, i) {
  const n = Math.min(frameCount(a), frameCount(b));
  if (i >= n) return;
  const start = i * STRIDE, end = n * STRIDE;
  const tmp = a.slice(start, end);
  a.set(b.subarray(start, end), start);
  b.set(tmp, start);
}

/** A/B 결과로 겹침 프레임 표시(createTracker와 같은 기준): 둘이 몸통 0.6배보다 가깝거나, 둘 다 보이다 한 사람이 갑자기 안 보이면(가려짐) 1 */
export function overlapFlags(out) {
  const flags = new Uint8Array(out.length);
  let pa = null, pb = null;
  out.forEach((o, i) => {
    const ca = o.a && bodyCenter(o.a.image), cb = o.b && bodyCenter(o.b.image);
    if (ca && cb) { if (d2(ca, cb) < ((ca.size + cb.size) / 2) * OVERLAP_RATIO) flags[i] = 1; }
    else if ((ca || cb) && pa && pb && d2(pa, pb) < ((pa.size + pb.size) / 2) * 1.5) flags[i] = 1;
    if (ca) pa = ca;
    if (cb) pb = cb;
  });
  return flags;
}

/**
 * 스파링 업로드 분석(영상 전체를 본 뒤): 프레임마다 감지(최대 둘)를 A/B에 붙이는 모든 경우 중
 * 영상 전체 비용이 가장 작은 순서를 고른다(비터비). 한두 프레임의 잡음으로는 사람이 바뀌지 않고,
 * 생김새 증거가 계속 쌓일 때만 바뀐다.
 *  비용 = 움직임(같은 줄의 몸 중심이 직전 감지 프레임에서 얼마나 움직였나, 몸통 길이 단위)
 *       + 넘김(직전 프레임의 한 사람과 거의 같은 자리인 감지를 다른 줄에 붙임)
 *       + 생김새(두 사람의 생김새 평균과의 차이 — 함께 보인 쌍에서 배운, 두 사람을 가르는 방향으로만)
 * detsPerFrame: [[{image, world, app}, ...]] → [{ a, b }]
 */
// move: 움직임 1 몸통당 비용, hand: 같은 자리 감지를 다른 줄로 넘길 때 벌점, app: 생김새 비용 배율,
// trustLo/Hi: 함께 보인 쌍이 생김새로 갈리는 비율이 Lo 이하면 생김새 무시(위치만), Hi 이상이면 다 믿음
// drop: 감지 하나를 버리는 벌점, size: 몸 크기(몸통 길이) 변화 비용
export const VITERBI_TUNE = { move: 1, hand: 8, app: 1, trustLo: 0.6, trustHi: 0.85, drop: 8, size: 1 };
export function identifyViterbi(detsPerFrame) {
  const n = detsPerFrame.length;
  const D = 12;
  const vec = (app) => (app ? [...app.top, ...(app.bottom || [NaN, NaN, NaN]), ...(app.shin || [NaN, NaN, NaN]), ...(app.skin || [null, null, null]).map((x) => (x == null ? NaN : x))] : null);
  // 프레임마다 감지 정리(같은 사람 두 번 감지 제거, 최대 둘)
  const F = detsPerFrame.map((dets) => {
    const items = dets.map((d) => ({ d, c: bodyCenter(d.image), q: quality(d.image), v: vec(d.app) })).filter((x) => x.c).sort((p, q) => q.q - p.q);
    const kept = [];
    for (const it of items) if (!kept.some((k) => sameBody(k, it))) kept.push(it);
    return kept.slice(0, 2);
  });
  // 생김새 모델: 함께 보인 쌍의 차이에서 두 사람을 가르는 방향 u, 두 사람 평균 m0/m1, 흩어짐
  const all = F.flat().filter((it) => it.v);
  const dimMean = Array.from({ length: D }, (_, j) => { const xs = all.map((it) => it.v[j]).filter((x) => !Number.isNaN(x)); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; });
  const dimStd = Array.from({ length: D }, (_, j) => { const xs = all.map((it) => it.v[j]).filter((x) => !Number.isNaN(x)); if (xs.length < 2) return 1; const m = dimMean[j]; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) || 1; });
  const z = (v) => v.map((x, j) => (Number.isNaN(x) ? 0 : (x - dimMean[j]) / dimStd[j])); // 없는 값은 평균(0)
  // 확실한 사슬: 다음 프레임에 가까운 감지가 하나뿐이고 옆에 다른 사람이 없을 때 이음
  const chainPrev = new Map(), chainNext = new Map();
  for (let i = 1; i < n; i++) for (const it of F[i]) {
    const near = F[i - 1].filter((pv) => d2(pv.c, it.c) < 0.3 * Math.max(0.05, it.c.size));
    const others = F[i].filter((x) => x !== it && d2(x.c, it.c) < 1.5 * Math.max(0.05, it.c.size));
    if (near.length === 1 && !others.length && !chainNext.has(near[0])) { chainPrev.set(it, near[0]); chainNext.set(near[0], it); }
  }
  // 생김새를 사슬 앞뒤 5프레임까지 평균(한 프레임의 색은 잡음이 큼)
  for (const it of F.flat()) {
    const list = [it];
    for (let p = it, k = 0; k < 5 && chainPrev.has(p); k++) { p = chainPrev.get(p); list.push(p); }
    for (let p = it, k = 0; k < 5 && chainNext.has(p); k++) { p = chainNext.get(p); list.push(p); }
    const vs = list.map((x) => x.v).filter(Boolean);
    it.raw = it.v;
    if (vs.length) it.v = Array.from({ length: D }, (_, j) => { const xs = vs.map((v) => v[j]).filter((x) => !Number.isNaN(x)); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN; });
  }
  const pairs = F.filter((f) => f.length === 2 && f[0].v && f[1].v);
  // 차원 가중치: 두 사람 차이(같은 프레임의 쌍) ÷ 같은 사람 차이(이어지는 프레임에서 확실히 같은 사람)
  //  → 프레임마다 흔들리기만 하는 색(둘 다 검은 상의 등)은 0, 사람마다 다른 색(정강이 맨살 등)은 크게
  // 같은 사람 쌍: 확실한 것만 이은 사슬(다음 프레임에 가까운 감지가 하나뿐이고 옆에 다른 사람 없음)에서 10프레임(0.5초) 떨어진 두 감지
  const same = [];
  for (let i = 0; i < n; i++) for (const it of F[i]) {
    let p = it, k = 0;
    while (k < 10 && chainPrev.has(p)) { p = chainPrev.get(p); k++; }
    if (k === 10 && it.raw && p.raw) same.push([p, it]);
  }
  // 중앙값(이상한 쌍 — 관중에게 간 뼈대·섞인 뼈대 — 에 덜 흔들림)
  const dvar = (list) => Array.from({ length: D }, (_, j) => {
    const xs = [];
    for (const [p, q] of list) if (!Number.isNaN(p.v[j]) && !Number.isNaN(q.v[j])) xs.push(((p.v[j] - q.v[j]) / dimStd[j]) ** 2);
    xs.sort((a, b) => a - b);
    return xs.length ? xs[xs.length >> 1] : 0;
  });
  const vb = dvar(pairs), vw = dvar(same);
  // 같은 사람 차이가 0에 가까우면(맨살 비율처럼 값이 자주 똑같음) 무한대가 되지 않게 바닥(0.1)과 상한(10)
  const fw = vb.map((b, j) => Math.min(10, Math.sqrt(Math.max(0, b / Math.max(0.1, vw[j]) - 1))));
  const zw = (v) => z(v).map((x, j) => x * fw[j]);
  const M = Array.from({ length: D }, () => new Array(D).fill(0));
  for (const [p, q] of pairs) {
    const a = zw(p.v), b = zw(q.v);
    const d = a.map((x, j) => (Number.isNaN(p.v[j]) || Number.isNaN(q.v[j]) ? 0 : x - b[j]));
    for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) M[i][j] += d[i] * d[j];
  }
  let u = new Array(D).fill(1 / Math.sqrt(D));
  for (let it = 0; it < 60; it++) { const v = M.map((row) => row.reduce((s, m, j) => s + m * u[j], 0)); const norm = Math.hypot(...v) || 1; u = v.map((x) => x / norm); }
  const proj = (it) => (it.v ? zw(it.v).reduce((s, x, j) => s + x * u[j], 0) : null);
  for (const it of F.flat()) it.p = proj(it);
  // 쌍에서 큰 쪽/작은 쪽 평균 → 두 사람 평균. 흩어짐 = 같은 쪽 안의 표준편차
  let hi = [], lo = [];
  for (const [p, q] of pairs) { if (p.p >= q.p) { hi.push(p.p); lo.push(q.p); } else { hi.push(q.p); lo.push(p.p); } }
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const m = [mean(lo), mean(hi)];
  const sd = Math.sqrt((lo.reduce((s, x) => s + (x - m[0]) ** 2, 0) + hi.reduce((s, x) => s + (x - m[1]) ** 2, 0)) / Math.max(1, lo.length + hi.length));
  const mid = (m[0] + m[1]) / 2;
  const pairAcc = pairs.length ? pairs.filter(([p, q]) => (p.p - mid) * (q.p - mid) < 0).length / pairs.length : 0.5;
  const T = VITERBI_TUNE;
  const trust = Math.min(1, Math.max(0, (pairAcc - T.trustLo) / (T.trustHi - T.trustLo)));
  const spread = Math.max(1e-3, sd, Math.abs(m[1] - m[0]) / 2);
  // 생김새 비용: 사람 k(0=A, 1=B)에 붙일 때. 두 사람 차이만 본다(공통 부분은 빼서 0 근처)
  const appCost = (it, k) => (it.p == null || !trust ? 0 : T.app * trust * (((it.p - m[k]) / spread) ** 2 - ((it.p - m[1 - k]) / spread) ** 2) / 2);
  // 상태: 프레임의 감지를 A/B에 붙이는 방법. [A에 붙는 감지 번호|-1, B에 붙는 감지 번호|-1]
  // 감지를 버리는 경우도 상태에 넣는다(버리면 감지 하나당 drop 벌점): 갑자기 튀거나 크기가 확 바뀌거나
  // 이미 있는 사람 위에 겹친 뼈대는 A/B 어느 쪽에 붙여도 비싸서 버려진다
  const statesOf = (f) => {
    if (f.length === 0) return [[-1, -1]];
    if (f.length === 1) return [[0, -1], [-1, 0], [-1, -1]];
    return [[0, 1], [1, 0], [0, -1], [-1, 0], [1, -1], [-1, 1], [-1, -1]];
  };
  const S = F.map(statesOf);
  const emit = (i, s) => (s[0] >= 0 ? appCost(F[i][s[0]], 0) : 0) + (s[1] >= 0 ? appCost(F[i][s[1]], 1) : 0) + T.drop * (F[i].length - (s[0] >= 0) - (s[1] >= 0));
  // 전이: 직전 감지 프레임(빈 프레임은 건너뜀)과 비교
  const trans = (pi, ps, i, s, gap) => {
    let c = 0;
    const scale = Math.max(1, gap / 2); // 오래 끊겼으면 움직임을 너그럽게
    for (let k = 0; k < 2; k++) {
      if (ps[k] >= 0 && s[k] >= 0) {
        const a = F[pi][ps[k]].c, b = F[i][s[k]].c;
        c += T.move * d2(a, b) / Math.max(0.05, (a.size + b.size) / 2) / scale;
        c += T.size * Math.abs(Math.log(Math.max(0.02, b.size) / Math.max(0.02, a.size))) / scale; // 몸 크기가 갑자기 바뀜
      }
    }
    // 넘김: 직전 프레임의 한 사람과 거의 같은 자리인 감지가 다른 줄로 감
    for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) {
      if (k === j || ps[k] < 0 || s[j] < 0) continue;
      const a = F[pi][ps[k]].c, b = F[i][s[j]].c;
      const dd = d2(a, b) / Math.max(0.05, (a.size + b.size) / 2);
      if (dd < 0.5 * scale) c += T.hand * (1 - dd / (0.5 * scale));
    }
    return c;
  };
  // 비터비
  const cost = [], back = [];
  let prevI = -1;
  for (let i = 0; i < n; i++) {
    const st = S[i];
    cost[i] = new Array(st.length); back[i] = new Array(st.length);
    if (prevI < 0 || !F[i].length) {
      // 처음이거나 빈 프레임: 직전 비용 최솟값을 그대로 이어받음
      const base = prevI < 0 ? 0 : Math.min(...cost[i - 1]);
      const arg = prevI < 0 ? -1 : cost[i - 1].indexOf(base);
      st.forEach((s, si) => { cost[i][si] = base + emit(i, s); back[i][si] = arg; });
      if (F[i].length) prevI = i;
      continue;
    }
    // 직전 감지 프레임 prevI까지 사이의 빈 프레임은 상태 하나뿐이라 그대로 지나감 → prevI의 상태로 바로 잇는다
    const gap = i - prevI;
    st.forEach((s, si) => {
      let best = Infinity, arg = 0;
      S[prevI].forEach((ps, pj) => {
        const v = costAt(prevI, pj) + trans(prevI, ps, i, s, gap);
        if (v < best) { best = v; arg = pj; }
      });
      cost[i][si] = best + emit(i, s); back[i][si] = { i: prevI, s: arg };
    });
    prevI = i;
  }
  function costAt(pi, pj) { return cost[pi][pj]; }
  // 거슬러 올라가기
  const choice = new Array(n).fill(0);
  let i = n - 1;
  while (i >= 0 && !F[i].length) i--;
  if (i >= 0) {
    let si = cost[i].indexOf(Math.min(...cost[i]));
    while (i >= 0) {
      choice[i] = si;
      const b = back[i][si];
      if (b && typeof b === 'object') { i = b.i; si = b.s; } else break;
    }
  }
  const out = F.map((f, k) => { const s = S[k][choice[k]] || [-1, -1]; return { a: s[0] >= 0 ? f[s[0]].d : null, b: s[1] >= 0 ? f[s[1]].d : null }; });
  // 처음 둘이 함께 보인 프레임에서 A가 왼쪽이 되게
  const first = out.find((o) => o.a && o.b);
  if (first && bodyCenter(first.a.image).x > bodyCenter(first.b.image).x) for (const o of out) [o.a, o.b] = [o.b, o.a];
  if (VITERBI_TUNE.debug) VITERBI_TUNE.debug = { pairAcc, trust, m, sd, pairs: pairs.length, fw: fw.map((x) => +x.toFixed(2)) }; // 검증 도구용
  return out;
}
