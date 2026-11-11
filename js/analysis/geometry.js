// MediaPipe Pose 33개 랜드마크 중 분석에 쓰는 것들.
// 좌/우는 화면 기준이 아니라 사람 기준(anatomical)이다.
export const LM = {
  nose: 0, mouthL: 9, mouthR: 10,
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28,
};

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });
export const visibility = (p) => (p && p.visibility != null ? p.visibility : 1);

export function allVisible(lms, idx, min = 0.5) {
  return idx.every((i) => lms[i] && visibility(lms[i]) >= min);
}

// 어깨 중점 ~ 엉덩이 중점 거리. 몸 크기 기준 길이로 쓴다.
export function torso(w) {
  return dist(mid(w[LM.lSh], w[LM.rSh]), mid(w[LM.lHip], w[LM.rHip]));
}

// 팔이 얼마나 곧게 펴졌는지(straight: 1에 가까울수록 일직선)와 몸통 대비 뻗은 거리(reach).
export function armMetrics(w, side, T) {
  const s = w[LM[side + 'Sh']], e = w[LM[side + 'El']], r = w[LM[side + 'Wr']];
  const seg = dist(s, e) + dist(e, r);
  const sw = dist(s, r);
  return { straight: seg ? sw / seg : 0, reach: sw / T, wrist: r, shoulder: s };
}
