const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

let colors = null;
function palette() {
  if (!colors) {
    const cs = getComputedStyle(document.documentElement);
    colors = {
      bone: cs.getPropertyValue('--cam-ink').trim() || '#E9ECF1',
      joint: cs.getPropertyValue('--accent').trim() || '#EE4B3B',
      warn: cs.getPropertyValue('--warn').trim() || '#B86A00',
      warnSoft: cs.getPropertyValue('--warn-soft').trim() || '#FCF0DA',
    };
  }
  return colors;
}

/** image 랜드마크(0~1)를 aspect 비율 영상이 contain으로 놓인 캔버스 위에 그린다. */
export function drawSkeleton(canvas, image, { aspect = 1, hot = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!image) return;

  const dw = Math.min(w, h * aspect), dh = dw / aspect;
  const ox = (w - dw) / 2, oy = (h - dh) / 2;
  const P = (i) => [ox + image[i].x * dw, oy + image[i].y * dh];
  const ok = (i) => image[i] && (image[i].visibility ?? 1) >= 0.4;
  const c = palette();
  const unit = Math.max(3, dh * 0.012);

  ctx.lineCap = 'round';
  ctx.strokeStyle = c.bone;
  ctx.lineWidth = unit;
  for (const [a, b] of BONES) {
    if (!ok(a) || !ok(b)) continue;
    const [x1, y1] = P(a), [x2, y2] = P(b);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  if (ok(0) && ok(11) && ok(12)) {
    const [nx, ny] = P(0);
    const [ax, ay] = P(11), [bx, by] = P(12);
    const r = Math.max(unit * 3, Math.hypot(ax - bx, ay - by) * 0.32);
    ctx.beginPath(); ctx.arc(nx, ny, r, 0, Math.PI * 2); ctx.stroke();
  }
  for (const j of JOINTS) {
    if (!ok(j)) continue;
    const [x, y] = P(j);
    if (j === hot) {
      ctx.fillStyle = c.warnSoft; ctx.strokeStyle = c.joint; ctx.lineWidth = unit;
      ctx.beginPath(); ctx.arc(x, y, unit * 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = c.bone;
    } else {
      ctx.fillStyle = c.joint;
      ctx.beginPath(); ctx.arc(x, y, unit * 1.1, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/** 전신이 화면 안에 들어왔는지 확인 (촬영 준비 화면용). */
export function framingStatus(image) {
  if (!image) return { ok: false, msg: '사람을 찾는 중이에요' };
  const need = [0, 11, 12, 23, 24, 27, 28];
  const inside = (i) => image[i] && (image[i].visibility ?? 1) >= 0.5 && image[i].x > 0.02 && image[i].x < 0.98 && image[i].y > 0.02 && image[i].y < 0.98;
  if (!inside(27) || !inside(28)) return { ok: false, msg: '발이 안 보여요. 조금 뒤로 가세요' };
  if (!inside(0)) return { ok: false, msg: '머리가 잘렸어요. 폰을 조금 낮추거나 뒤로' };
  if (!need.every(inside)) return { ok: false, msg: '몸 전체가 화면 안에 들어오게 서주세요' };
  return { ok: true, msg: '전신이 잘 보여요' };
}
