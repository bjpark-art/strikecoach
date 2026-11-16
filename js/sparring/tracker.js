// 2인 영상에서 프레임마다 감지된 사람들을 A/B 두 사람으로 이어 붙인다 (화면 좌표 기준).
import { STRIDE, frameCount } from '../pose/frames.js';

const NEW_TRACK_DIST = 0.25;   // 화면 폭 대비. 이보다 멀면 다른 사람으로 본다
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

export function createTracker() {
  const prev = { a: null, b: null };

  /** dets: [{image, world}] → { a, b, overlap } */
  function assign(dets) {
    const items = dets.map((d) => ({ d, c: bodyCenter(d.image) })).filter((x) => x.c).slice(0, 2);
    let a = null, b = null;

    if (items.length === 2) {
      const [p, q] = items;
      if (!prev.a && !prev.b) {
        [a, b] = p.c.x <= q.c.x ? [p, q] : [q, p]; // 처음엔 왼쪽 사람을 A로
      } else {
        const cost = (t, x) => (prev[t] ? d2(prev[t], x.c) : NEW_TRACK_DIST);
        const keep = cost('a', p) + cost('b', q);
        const swap = cost('a', q) + cost('b', p);
        [a, b] = keep <= swap ? [p, q] : [q, p];
      }
    } else if (items.length === 1) {
      const x = items[0];
      const da = prev.a ? d2(prev.a, x.c) : Infinity;
      const db = prev.b ? d2(prev.b, x.c) : Infinity;
      if (da === Infinity && db === Infinity) a = x;
      else if (da <= db) { if (da < NEW_TRACK_DIST || prev.b) a = x; else b = x; }
      else { if (db < NEW_TRACK_DIST || prev.a) b = x; else a = x; }
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

    if (a) prev.a = a.c;
    if (b) prev.b = b.c;
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
