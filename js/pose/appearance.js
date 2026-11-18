// 사람의 생김새(옷 색): 2인 분석에서 장면이 바뀌거나 두 사람이 겹친 뒤에도 "나/상대"를 구분하려고 쓴다.
// 프레임을 작게 줄여 그린 뒤 뼈대의 상체(어깨~엉덩이), 하체(엉덩이~무릎 중간), 정강이(무릎~발목) 색을 평균낸다.
// 영상은 기기 밖으로 나가지 않는다(화면에 그리지도 않는 작은 캔버스).
const W = 256; // 정강이·팔뚝처럼 가는 부분도 몇 픽셀은 되게
let cv = null, ctx = null;

const vis = (p) => p && (p.visibility ?? 1) >= 0.3;
// 살색 판정(RGB 규칙, 조명이 밝은 실내 기준): 붉은 기가 있고 너무 어둡거나 회색이 아님
const isSkin = ([r, g, b]) => r > 90 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 10;
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** video(또는 이미지)의 지금 프레임을 줄여 담고, image 랜드마크 → 생김새 특징을 돌려주는 함수를 만든다. */
export function frameSampler(el) {
  const vw = el.videoWidth || el.width, vh = el.videoHeight || el.height;
  if (!vw || !vh || typeof document === 'undefined') return () => null;
  const H = Math.max(8, Math.round((W * vh) / vw));
  if (!cv) { cv = document.createElement('canvas'); ctx = cv.getContext('2d', { willReadFrequently: true }); }
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  try { ctx.drawImage(el, 0, 0, W, H); } catch (_) { return () => null; }
  const px = ctx.getImageData(0, 0, W, H).data;
  const at = (p) => {
    const x = Math.min(W - 1, Math.max(0, Math.round(p.x * W))), y = Math.min(H - 1, Math.max(0, Math.round(p.y * H)));
    const o = (y * W + x) * 4;
    return [px[o], px[o + 1], px[o + 2]];
  };
  // 네 꼭짓점(위왼·위오·아래오·아래왼) 안쪽을 4×4로 훑어 평균 색
  const quad = (tl, tr, br, bl) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const u = 0.2 + 0.2 * i, v = 0.2 + 0.2 * j;
      const c = at(lerp(lerp(tl, tr, u), lerp(bl, br, u), v));
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    return [r / n / 255, g / n / 255, b / n / 255];
  };
  return (image) => {
    if (!image) return null;
    const ls = image[11], rs = image[12], lh = image[23], rh = image[24];
    if (!vis(ls) || !vis(rs)) return null;
    let top, bottom = null;
    if (vis(lh) && vis(rh)) {
      top = quad(ls, rs, rh, lh);
      const lk = vis(image[25]) ? lerp(lh, image[25], 0.5) : { x: lh.x, y: lh.y + (lh.y - ls.y) * 0.4 };
      const rk = vis(image[26]) ? lerp(rh, image[26], 0.5) : { x: rh.x, y: rh.y + (rh.y - rs.y) * 0.4 };
      bottom = quad(lh, rh, rk, lk);
    } else {
      // 엉덩이가 안 보이면 어깨 너비만큼 아래를 상체로
      const w = Math.hypot(ls.x - rs.x, ls.y - rs.y);
      top = quad(ls, rs, { x: rs.x, y: rs.y + w }, { x: ls.x, y: ls.y + w });
    }
    // 정강이(무릎~발목): 둘 다 검은 옷이어도 정강이 보호대·맨다리·바지 길이로 갈리는 경우가 많다
    const shins = [];
    for (const [k, a] of [[25, 27], [26, 28]]) {
      const kn = image[k], an = image[a];
      if (!vis(kn) || !vis(an)) continue;
      for (const u of [0.25, 0.4, 0.55, 0.7]) shins.push(at(lerp(kn, an, u)));
    }
    const shin = shins.length ? [0, 1, 2].map((c) => shins.reduce((s, x) => s + x[c], 0) / shins.length / 255) : null;
    // 맨살 비율: 정강이(반바지·맨다리 vs 보호대·긴바지), 아래팔(반팔 vs 긴팔), 허벅지(짧은 반바지)
    // 색 평균은 바닥·손이 섞이면 흔들리지만 "살색인 점의 비율"은 바닥(회색)·검은 옷이 섞여도 잘 안 흔들린다
    const skin = (segs) => {
      let n = 0, k = 0;
      for (const [a, b] of segs) {
        if (!vis(image[a]) || !vis(image[b])) continue;
        for (let u = 0.15; u <= 0.86; u += 0.1) { n++; if (isSkin(at(lerp(image[a], image[b], u)))) k++; }
      }
      return n ? k / n : null;
    };
    const skins = [skin([[25, 27], [26, 28]]), skin([[13, 15], [14, 16]]), skin([[23, 25], [24, 26]])];
    return { top, bottom, shin, skin: skins };
  };
}

// 두 생김새의 차이(0이면 같음). 밝기 차이보다 색(비율) 차이를 크게 본다 — 조명이 바뀌어도 덜 흔들리게.
function part(a, b) {
  // 어두운 색은 색 비율이 잡음에 크게 흔들린다(검은 옷·어두운 영상에서 같은 사람이 매 프레임 딴사람으로 보였음)
  // → 분모에 여유(0.3)를 둬서 어두울수록 색 차이를 작게 본다
  const sa = a[0] + a[1] + a[2] + 0.3, sb = b[0] + b[1] + b[2] + 0.3;
  let chroma = 0;
  for (let i = 0; i < 3; i++) chroma += (a[i] / sa - b[i] / sb) ** 2;
  const bright = (sa - sb) / 3; // 0.3은 양쪽에 같이 더해져 상쇄됨
  return Math.sqrt(chroma * 4 + bright * bright);
}
export function appearanceDist(a, b) {
  if (!a || !b) return null;
  const d = [part(a.top, b.top)];
  if (a.bottom && b.bottom) d.push(part(a.bottom, b.bottom));
  if (a.shin && b.shin) d.push(part(a.shin, b.shin));
  if (a.skin && b.skin) for (let i = 0; i < 3; i++) if (a.skin[i] != null && b.skin[i] != null) d.push(Math.abs(a.skin[i] - b.skin[i]) * 0.5);
  return d.reduce((s, x) => s + x, 0) / d.length;
}

/** 생김새 기억을 천천히 갱신(조명 변화 따라가기). */
export function blendAppearance(mem, cur, w = 0.1) {
  if (!cur) return mem;
  if (!mem) return { top: cur.top.slice(), bottom: cur.bottom ? cur.bottom.slice() : null, shin: cur.shin ? cur.shin.slice() : null, skin: cur.skin ? cur.skin.slice() : null };
  const mix = (m, c) => m.map((v, i) => v * (1 - w) + c[i] * w);
  const opt = (k) => (mem[k] && cur[k] ? mix(mem[k], cur[k]) : mem[k] || (cur[k] && cur[k].slice()) || null);
  const sk = (mem.skin || cur.skin) && [0, 1, 2].map((i) => {
    const m = mem.skin?.[i], c = cur.skin?.[i];
    return m == null ? (c ?? null) : c == null ? m : m * (1 - w) + c * w;
  });
  return { top: mix(mem.top, cur.top), bottom: opt('bottom'), shin: opt('shin'), skin: sk || null };
}
