// 영상 분석 결과(프레임별 랜드마크)를 Float32Array 하나에 담는 형식.
// 영상 자체는 저장하지 않고 이 데이터만 저장해서, 리뷰 때 뼈대를 다시 그리고 분석을 다시 돌린다.
// 프레임 = [t(ms), 관절마다 (이미지 x, 이미지 y, 월드 x, 월드 y, 월드 z, 가시성)]

export const PACK_JOINTS = [0, 9, 10, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const PER_JOINT = 6;
export const STRIDE = 1 + PACK_JOINTS.length * PER_JOINT;

export function createPacker(capacity = 256) {
  let buf = new Float32Array(Math.max(1, capacity) * STRIDE);
  let n = 0;
  return {
    push({ t, image, world }) {
      if ((n + 1) * STRIDE > buf.length) {
        const next = new Float32Array(buf.length * 2);
        next.set(buf);
        buf = next;
      }
      const o = n * STRIDE;
      buf[o] = t;
      if (image && world) {
        PACK_JOINTS.forEach((idx, k) => {
          const p = image[idx], w = world[idx], b = o + 1 + k * PER_JOINT;
          buf[b] = p.x; buf[b + 1] = p.y;
          buf[b + 2] = w.x; buf[b + 3] = w.y; buf[b + 4] = w.z;
          buf[b + 5] = p.visibility ?? 1;
        });
      } else {
        buf.fill(0, o + 1, o + STRIDE); // 사람 없음 = 가시성 0
      }
      n++;
    },
    get count() { return n; },
    finish() { return buf.slice(0, n * STRIDE); },
  };
}

export const frameCount = (buf) => Math.floor(buf.length / STRIDE);
export const frameTime = (buf, i) => buf[i * STRIDE];

export function unpackFrame(buf, i) {
  const o = i * STRIDE;
  const image = new Array(33).fill(null);
  const world = new Array(33).fill(null);
  let any = false;
  PACK_JOINTS.forEach((idx, k) => {
    const b = o + 1 + k * PER_JOINT;
    const visibility = buf[b + 5];
    if (visibility > 0) any = true;
    image[idx] = { x: buf[b], y: buf[b + 1], visibility };
    world[idx] = { x: buf[b + 2], y: buf[b + 3], z: buf[b + 4], visibility };
  });
  return { t: buf[o], image: any ? image : null, world: any ? world : null };
}

/** tMs 시점에 보여줄 프레임 번호 (그 시점 이전의 마지막 프레임). */
export function findFrame(buf, tMs) {
  let lo = 0, hi = frameCount(buf) - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frameTime(buf, mid) <= tMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}
