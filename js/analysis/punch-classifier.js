// 펀치 동작 분류(스트레이트 / 훅 / 어퍼컷 / 펀치 아님)와 2D 타격 구간 감지.
// 모델은 tools/validate/train_mp.py 가 BoxingVI 영상의 MediaPipe 좌표로 학습해 만든 그래디언트 부스팅 트리.
// 특징 계산은 tools/punch-classifier/train2.py 의 feats() 와 똑같아야 한다 (tests/punch-fixture.js 로 확인).
import DEFAULT_MODEL from './punch-model.js';

let MODEL = DEFAULT_MODEL;
/** 검증 도구에서 영상별로 다른 모델을 끼워 넣을 때만 쓴다. 인자 없이 부르면 기본 모델로 돌아간다. */
export function setModel(m) { MODEL = m || DEFAULT_MODEL; }

// COCO 17 관절 번호 → MediaPipe 33 관절 번호 (얼굴 일부는 쓰지 않음)
const MP_OF_COCO = { 0: 0, 5: 11, 6: 12, 7: 13, 8: 14, 9: 15, 10: 16, 11: 23, 12: 24 };
const ARM = { l: [5, 7, 9], r: [6, 8, 10] };
const NPT = 8;

/** MediaPipe image 랜드마크 배열 → COCO 순서 [x, y] (안 보이면 null) */
export function cocoFrame(image, minVis = 0.4) {
  const out = new Array(17).fill(null);
  if (!image) return out;
  for (const [c, m] of Object.entries(MP_OF_COCO)) {
    const p = image[m];
    if (p && (p.visibility ?? 1) >= minVis) out[c] = [p.x, p.y];
  }
  return out;
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const norm = (x, y) => Math.hypot(x, y);

function resample(pts, n = NPT) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : (k * (pts.length - 1)) / (n - 1);
    const i0 = Math.floor(t), i1 = Math.min(i0 + 1, pts.length - 1), w = t - i0;
    out.push([pts[i0][0] * (1 - w) + pts[i1][0] * w, pts[i0][1] * (1 - w) + pts[i1][1] * w]);
  }
  return out;
}

/**
 * clip: 프레임 배열, 각 프레임은 COCO 순서 17개 [x, y] | null.
 * @returns {{ features: number[], side: 'l'|'r' } | null}
 */
export function punchFeatures(clip) {
  const c = clip.filter((f) => [5, 6, 7, 8, 9, 10].every((j) => f[j]));
  if (c.length < 3) return null;
  const shMid = c.map((f) => [(f[5][0] + f[6][0]) / 2, (f[5][1] + f[6][1]) / 2]);
  const hipLens = [];
  c.forEach((f, i) => { if (f[11] && f[12]) hipLens.push(norm(shMid[i][0] - (f[11][0] + f[12][0]) / 2, shMid[i][1] - (f[11][1] + f[12][1]) / 2)); });
  const T = hipLens.length >= 2 ? median(hipLens) : median(c.map((f) => norm(f[5][0] - f[6][0], f[5][1] - f[6][1]))) * 1.4;
  if (!T || T < 1e-4) return null;
  const noseDx = c.filter((f) => f[0]).map((f, i) => f[0][0] - shMid[c.indexOf(f)][0]);
  const face = (noseDx.length ? Math.sign(median(noseDx)) : 0) || 1;

  const per = {};
  for (const side of ['l', 'r']) {
    const [si, ei, wi] = ARM[side];
    const W = c.map((f) => [((f[wi][0] - f[si][0]) / T) * face, (f[wi][1] - f[si][1]) / T]);
    const E = c.map((f) => [((f[ei][0] - f[si][0]) / T) * face, (f[ei][1] - f[si][1]) / T]);
    let disp = 0, sp = 0;
    W.forEach((w, i) => {
      disp = Math.max(disp, norm(w[0] - W[0][0], w[1] - W[0][1]));
      if (i) sp = Math.max(sp, norm(w[0] - W[i - 1][0], w[1] - W[i - 1][1]));
    });
    per[side] = { score: disp + sp, W, E };
  }
  const order = ['l', 'r'].sort((a, b) => per[b].score - per[a].score); // 같으면 l 먼저 (파이썬 sorted와 같음)
  const out = [];
  for (const s of order) {
    const { W, E } = per[s];
    const Wr = resample(W), Er = resample(E);
    for (const p of Wr) out.push(p[0] - Wr[0][0], p[1] - Wr[0][1]);
    for (const p of Wr) out.push(p[0], p[1]);
    Er.forEach((p, i) => out.push(p[0] - Wr[i][0], p[1] - Wr[i][1]));
    const reach = W.map((p) => norm(p[0], p[1]));
    let k = 0;
    reach.forEach((r, i) => { if (r > reach[k]) k = i; });
    out.push(reach[k], reach[k] - reach[0], W[k][0], W[k][1], E[k][0], E[k][1]);
  }
  out.push(per[order[0]].score / (per[order[1]].score + 1e-3), c.length / 25);
  const swx = c.map((f) => ((f[6][0] - f[5][0]) * face) / T);
  out.push(swx[0], Math.max(...swx) - Math.min(...swx), swx[swx.length - 1] - swx[0]);
  return { features: out, side: order[0] };
}

/** 트리 앙상블 실행 → 클래스별 확률 */
export function classifyFeatures(x) {
  const K = MODEL.nClasses;
  const raw = MODEL.baseline.slice();
  MODEL.trees.forEach((nodes, t) => {
    let n = nodes[0];
    while (!n[4]) {
      const v = x[n[0]];
      const left = Number.isNaN(v) ? n[6] === 1 : v <= n[1];
      n = nodes[left ? n[2] : n[3]];
    }
    raw[t % K] += n[5];
  });
  const m = Math.max(...raw);
  const e = raw.map((r) => Math.exp(r - m));
  const sum = e.reduce((a, b) => a + b, 0);
  const probs = e.map((v) => v / sum);
  let best = 0;
  probs.forEach((p, i) => { if (p > probs[best]) best = i; });
  return { label: MODEL.classes[best], prob: probs[best], probs };
}

// ---------- 2D 타격 구간 감지 (훅·어퍼컷처럼 곧게 펴지지 않는 펀치용) ----------
// 기준값은 BoxingVI 펀치들의 분포에서 정함: 최고 손목 속도 하위 10% ≈ 4.3 몸통/초, 손목 이동 하위 10% ≈ 0.22 몸통
// createStrikeDetector(tune)로 덮어쓸 수 있다(검증 도구용).
export const STRIKE_TUNE = {
  speedOn: 2.0,    // 이 속도(몸통 길이/초)를 넘으면 구간 시작
  speedOff: 1.2,
  peakMin: 4.0,
  travelMin: 0.2,
};
const MAX_SEG_MS = 800;
const HISTORY = 40;

/**
 * 프레임을 넣으면 손목이 빠르게 움직인 구간이 끝날 때마다 { side, start, end, label, prob, probs } 를 돌려준다.
 */
export function createStrikeDetector(tune = {}) {
  // 감지 기준값은 모델을 학습할 때 쓴 값(MODEL.detect)을 따라야 학습 때와 같은 구간이 잡힌다.
  const { speedOn: SPEED_ON, speedOff: SPEED_OFF, peakMin: PEAK_MIN, travelMin: TRAVEL_MIN } = { ...STRIKE_TUNE, ...(MODEL.detect || {}), ...tune };
  const keepFeatures = !!tune.keepFeatures; // 학습 데이터 만들 때만
  const hist = [];                       // { t, f: cocoFrame }
  const seg = { l: null, r: null };      // 진행 중인 구간
  const prev = { l: null, r: null };     // 직전 프레임 손목(몸통 길이 단위, 어깨 기준)

  function torsoLen(f) {
    if (!f[5] || !f[6]) return 0;
    const sx = (f[5][0] + f[6][0]) / 2, sy = (f[5][1] + f[6][1]) / 2;
    if (f[11] && f[12]) return norm(sx - (f[11][0] + f[12][0]) / 2, sy - (f[11][1] + f[12][1]) / 2);
    return norm(f[5][0] - f[6][0], f[5][1] - f[6][1]) * 1.4;
  }

  function finish(side, endIdx) {
    const s = seg[side];
    seg[side] = null;
    if (!s || s.peak < PEAK_MIN || s.travel < TRAVEL_MIN) return null;
    // 손을 내리는 동작(가드 하락)은 타격이 아니다
    if (s.drop > 0.25 && s.rise < 0.05) return null;
    const from = Math.max(0, s.startIdx - 1);
    const clip = hist.slice(from, endIdx + 1).slice(-25).map((h) => h.f);
    const pf = punchFeatures(clip);
    if (!pf) return null;
    const c = classifyFeatures(pf.features);
    const r = { side, start: hist[from].t, end: hist[endIdx].t, ...c };
    if (keepFeatures) { r.features = pf.features; r.peak = s.peak; r.travel = s.travel; }
    return r;
  }

  function update(t, image) {
    const f = cocoFrame(image);
    hist.push({ t, f });
    if (hist.length > HISTORY) {
      hist.shift();
      for (const s of ['l', 'r']) if (seg[s]) seg[s].startIdx--;
    }
    const idx = hist.length - 1;
    const T = torsoLen(f);
    const out = [];
    for (const side of ['l', 'r']) {
      const [si, , wi] = ARM[side];
      if (!T || !f[si] || !f[wi]) { prev[side] = null; if (seg[side]) { const r = finish(side, idx - 1); if (r) out.push(r); } continue; }
      const w = [(f[wi][0] - f[si][0]) / T, (f[wi][1] - f[si][1]) / T];
      const p = prev[side];
      prev[side] = { w, t };
      if (!p || t <= p.t) continue;
      const speed = norm(w[0] - p.w[0], w[1] - p.w[1]) / ((t - p.t) / 1000);
      const s = seg[side];
      if (!s) {
        if (speed > SPEED_ON) seg[side] = { startIdx: idx - 1, startT: p.t, w0: p.w, peak: speed, travel: norm(w[0] - p.w[0], w[1] - p.w[1]), rise: Math.max(0, p.w[1] - w[1]), drop: w[1] - p.w[1], slow: 0 };
        continue;
      }
      s.peak = Math.max(s.peak, speed);
      s.travel = Math.max(s.travel, norm(w[0] - s.w0[0], w[1] - s.w0[1]));
      s.rise = Math.max(s.rise, s.w0[1] - w[1]);
      s.drop = w[1] - s.w0[1];
      s.slow = speed < SPEED_OFF ? s.slow + 1 : 0;
      if (s.slow >= 2 || t - s.startT > MAX_SEG_MS || s.startIdx < 0) {
        const r = finish(side, idx);
        if (r) out.push(r);
      }
    }
    return out;
  }

  return { update };
}
