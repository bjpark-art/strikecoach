// 카메라 없이 전체 흐름을 돌려볼 수 있는 합성 자세 데이터.
// 9초 루프: 잽 4, 크로스 3, 뒷발 킥 1, 뒷손 가드 하락 1회 (테스트 기대값과 같다).
// 좌표: MediaPipe worldLandmarks와 같은 규약(미터, 엉덩이 중심 원점, y 아래, 사람 기준 좌우, 카메라 쪽이 -z).

const BASE = {
  nose: [0, -0.68, -0.08], mouthL: [0.03, -0.63, -0.08], mouthR: [-0.03, -0.63, -0.08],
  earL: [0.07, -0.68, 0.02], earR: [-0.07, -0.68, 0.02],
  lSh: [0.18, -0.5, 0], rSh: [-0.18, -0.5, 0.05],
  lEl: [0.2, -0.32, -0.12], rEl: [-0.2, -0.32, -0.05],
  lWr: [0.1, -0.58, -0.2], rWr: [-0.08, -0.6, -0.12],
  lHip: [0.1, 0, 0], rHip: [-0.1, 0, 0],
  lKn: [0.13, 0.45, -0.05], rKn: [-0.13, 0.46, 0.05],
  lAn: [0.15, 0.9, 0], rAn: [-0.16, 0.9, 0.1],
};

const POSES = {
  guard: {},
  jab: { lEl: [0.14, -0.5, -0.28], lWr: [0.08, -0.52, -0.56] },
  cross: { rSh: [-0.14, -0.5, -0.05], rEl: [-0.12, -0.5, -0.25], rWr: [-0.05, -0.52, -0.55] },
  drop: { rEl: [-0.22, -0.25, 0], rWr: [-0.2, -0.2, -0.05] },
  kick: { rKn: [-0.3, -0.05, -0.1], rAn: [-0.55, -0.15, -0.2] },
};
POSES.jabDrop = { ...POSES.jab, ...POSES.drop };

const KEYS = [
  [0, 'guard'], [0.5, 'guard'], [0.65, 'jab'], [0.9, 'guard'],
  [1.4, 'guard'], [1.6, 'cross'], [1.9, 'guard'],
  [2.4, 'guard'], [2.55, 'jab'], [2.8, 'guard'], [2.9, 'guard'], [3.05, 'cross'], [3.3, 'guard'],
  [3.8, 'guard'], [4.0, 'jabDrop'], [4.2, 'drop'], [4.9, 'drop'], [5.1, 'guard'],
  [5.6, 'guard'], [6.0, 'kick'], [6.15, 'kick'], [6.5, 'guard'],
  [7.2, 'guard'], [7.35, 'jab'], [7.6, 'guard'],
  [8.0, 'guard'], [8.2, 'cross'], [8.5, 'guard'], [9.0, 'guard'],
];
export const DEMO_LOOP_SEC = 9;

// 33개 인덱스 → 위 관절 이름
const INDEX = [
  'nose', 'nose', 'nose', 'nose', 'nose', 'nose', 'nose', 'earL', 'earR', 'mouthL', 'mouthR',
  'lSh', 'rSh', 'lEl', 'rEl', 'lWr', 'rWr', 'lWr', 'rWr', 'lWr', 'rWr', 'lWr', 'rWr',
  'lHip', 'rHip', 'lKn', 'rKn', 'lAn', 'rAn', 'lAn', 'rAn', 'lAn', 'rAn',
];

const full = (name) => ({ ...BASE, ...POSES[name] });
const smooth = (k) => k * k * (3 - 2 * k);

function mirror(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    const swapped = k[0] === 'l' && k[1] === k[1].toUpperCase() ? 'r' + k.slice(1)
      : k[0] === 'r' && k[1] === k[1].toUpperCase() ? 'l' + k.slice(1)
      : k.endsWith('L') ? k.slice(0, -1) + 'R' : k.endsWith('R') ? k.slice(0, -1) + 'L' : k;
    out[swapped] = [-v[0], v[1], v[2]];
  }
  return out;
}

export function demoFrameAt(sec, stance = 'orthodox') {
  const t = ((sec % DEMO_LOOP_SEC) + DEMO_LOOP_SEC) % DEMO_LOOP_SEC;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1][0] <= t) i++;
  const [t0, a] = KEYS[i];
  const [t1, b] = KEYS[i + 1];
  const k = smooth(Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1))));
  const A = full(a), B = full(b);
  let pose = {};
  for (const key in A) pose[key] = A[key].map((v, j) => v + (B[key][j] - v) * k);
  if (stance === 'southpaw') pose = mirror(pose);

  const bob = 0.01 * Math.sin(sec * 6);
  const world = INDEX.map((name) => {
    const [x, y, z] = pose[name];
    return { x, y: y + bob, z, visibility: 0.99 };
  });
  const image = world.map((p) => ({ x: 0.5 + p.x * 0.38, y: 0.5 + p.y * 0.38, z: p.z, visibility: p.visibility }));
  return { t: sec * 1000, world, image };
}

export function createDemoSource({ stance = 'orthodox' } = {}) {
  let handler = null, raf = 0, running = false, t0 = 0;
  const loop = (now) => {
    if (!running) return;
    if (handler) {
      const f = demoFrameAt((now - t0) / 1000, stance);
      f.t = now;
      handler(f);
    }
    raf = requestAnimationFrame(loop);
  };
  return {
    kind: 'demo',
    video: null,
    aspect: 1,
    listen(fn) {
      handler = fn;
      if (!running) { running = true; t0 = performance.now(); raf = requestAnimationFrame(loop); }
    },
    stop() { running = false; handler = null; cancelAnimationFrame(raf); },
  };
}
