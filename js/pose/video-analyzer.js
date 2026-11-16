// 업로드한 영상을 프레임 단위로 넘기며(seek) 자세를 추출한다. 영상은 기기 밖으로 나가지 않는다.
import { getLandmarker, detectAll, nextTimestampBase } from './landmarker.js';
import { createPacker } from './frames.js';
import { createTracker } from '../sparring/tracker.js';

export class VideoError extends Error {}

const FORMAT_MSG = '이 영상 형식은 브라우저에서 열 수 없어요. iPhone이라면 설정 > 카메라 > 포맷에서 "높은 호환성"으로 찍거나, MP4(H.264)로 저장해 주세요.';

function once(el, ev, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); el.removeEventListener(ev, done); resolve(); }
    el.addEventListener(ev, done);
  });
}

export async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new VideoError(FORMAT_MSG)), 15000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new VideoError(FORMAT_MSG)); };
    });
    if (!isFinite(video.duration)) {
      // 일부 webm은 길이를 모른다 → 끝으로 한 번 이동해서 길이를 알아낸다.
      video.currentTime = 1e7;
      await once(video, 'seeked', 3000);
      video.currentTime = 0;
      await once(video, 'seeked', 3000);
    }
    if (!video.videoWidth || !isFinite(video.duration) || video.duration <= 0) throw new VideoError(FORMAT_MSG);
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { video, url, duration: video.duration, aspect: video.videoWidth / video.videoHeight };
}

/** 분석할 프레임 시각(초) 목록. ranges가 비면 영상 전체. 프레임 시각은 영상 속 시각 그대로 둔다. */
export function frameTimes(duration, fps, ranges = null) {
  const all = Math.floor(duration * fps) + 1;
  const out = [];
  for (let i = 0; i < all; i++) {
    const t = Math.min(i / fps, Math.max(0, duration - 0.001));
    if (!ranges?.length || ranges.some(([a, b]) => t >= a && t <= b)) out.push(t);
  }
  return out;
}

/**
 * people: 1이면 { frames }, 2면 { a, b, overlap } (두 사람을 추적해 따로 저장).
 * ranges: [[시작초, 끝초], ...] 이 구간만 분석(라운드 사이 휴식·준비운동 빼기). 비면 영상 전체.
 */
export async function analyzeVideo(file, { fps = 20, people = 1, ranges = null, onProgress, signal } = {}) {
  const { video, url, duration, aspect } = await loadVideo(file);
  try {
    const landmarker = await getLandmarker({ numPoses: people });
    const times = frameTimes(duration, fps, ranges);
    const n = times.length;
    const pa = createPacker(n), pb = people === 2 ? createPacker(n) : null;
    const overlap = people === 2 ? new Uint8Array(n) : null;
    const tracker = people === 2 ? createTracker() : null;
    const base = nextTimestampBase(landmarker);
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException('분석을 취소했어요', 'AbortError');
      const t = times[i];
      if (Math.abs(video.currentTime - t) > 1e-4) {
        video.currentTime = t;
        await once(video, 'seeked', 2000);
      }
      const dets = detectAll(landmarker, video, base + t * 1000);
      if (people === 2) {
        const r = tracker.assign(dets);
        pa.push({ t: t * 1000, image: r.a?.image, world: r.a?.world });
        pb.push({ t: t * 1000, image: r.b?.image, world: r.b?.world });
        overlap[i] = r.overlap;
      } else {
        pa.push({ t: t * 1000, image: dets[0]?.image, world: dets[0]?.world });
      }
      if (i % 5 === 0) onProgress?.(i / n);
      if (i % 15 === 0) await new Promise((r) => setTimeout(r, 0)); // 화면 갱신 틈
    }
    onProgress?.(1);
    const common = { fps, duration, aspect };
    return people === 2 ? { ...common, a: pa.finish(), b: pb.finish(), overlap } : { ...common, frames: pa.finish() };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
