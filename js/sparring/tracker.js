// 2인 영상에서 프레임마다 감지된 사람들을 A/B 두 사람으로 이어 붙인다 (화면 좌표 기준).
import { STRIDE, frameCount } from '../pose/frames.js';

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
export const TRACK_TUNE = { reject: 1.5 };

export function createTracker() {
  const tr = { a: null, b: null }; // { x, y, size, vx, vy, t }
  const prev = { a: null, b: null }; // 겹침 판정용 마지막 중심(예전과 같음)
  let frameNo = 0;

  function cost(k, it, t) {
    const s = tr[k];
    if (!s) return NEW_COST;
    const age = t - s.t;
    const lead = Math.min(age, 300) / 1000;
    const px = s.x + s.vx * lead, py = s.y + s.vy * lead;
    const size = Math.max(0.05, (s.size + it.c.size) / 2);
    let c = Math.hypot(it.c.x - px, it.c.y - py) / size + SIZE_COST * Math.abs(Math.log(it.c.size / Math.max(0.02, s.size)));
    return c + (Math.min(age, 5000) / 1000) * AGE_COST;
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
  }

  /** dets: [{image, world}], t: 프레임 시각(ms, 없으면 초당 20장으로 셈) → { a, b, overlap } */
  function assign(dets, t = null) {
    if (t == null) t = frameNo * 50;
    frameNo++;
    let items = dets.map((d) => ({ d, c: bodyCenter(d.image), q: quality(d.image) })).filter((x) => x.c);
    // 같은 사람을 두 번 잡았으면 더 잘 보이는 하나만 남긴다(한 사람만 있을 때 뼈대가 두 줄로 겹쳐 "나"가 "상대"로 넘어가던 문제)
    items.sort((p, q) => q.q - p.q);
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

/** i번째 프레임부터 A/B를 서로 바꾼다 (리뷰에서 수동 보정). 두 버퍼를 제자리에서 바꾼다. */
export function swapFrom(a, b, i) {
  const n = Math.min(frameCount(a), frameCount(b));
  if (i >= n) return;
  const start = i * STRIDE, end = n * STRIDE;
  const tmp = a.slice(start, end);
  a.set(b.subarray(start, end), start);
  b.set(tmp, start);
}
