// 업로드한 영상에서 자세를 추출한다. 영상은 기기 밖으로 나가지 않는다.
// 두 가지 방식:
//  - 재생 방식(기본): 영상을 재생하면서 디코딩된 프레임을 받아 분석(requestVideoFrameCallback).
//    한 프레임씩 이동(seek)하는 것보다 훨씬 빠르다(대략 영상 길이만큼). 분석이 못 따라가면 재생 속도를 낮춘다.
//  - 이동 방식(예비): 정해진 시각으로 한 프레임씩 이동. 재생 방식을 못 쓰는 브라우저에서만.
import { getLandmarker, detectAll, nextTimestampBase } from './landmarker.js';
import { createPacker } from './frames.js';
import { createTracker } from '../sparring/tracker.js';

export class VideoError extends Error {}

const FORMAT_MSG = '이 영상을 열지 못했어요. iPhone이라면 설정 > 카메라 > 포맷에서 "높은 호환성"으로 찍거나, MP4(H.264)로 저장해 주세요.';

function once(el, ev, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); el.removeEventListener(ev, done); resolve(); }
    el.addEventListener(ev, done);
  });
}

/**
 * 영상 파일을 열어 길이·비율을 확인한다. iPhone Safari는 화면에 없는 영상의 데이터를
 * 재생 전까지 받지 않아서, 메타데이터만 기다린 뒤 한 번 재생했다 멈춰 디코딩을 시작시킨다.
 * 다 쓰면 releaseVideo()로 정리한다.
 */
export async function loadVideo(file, video = null) {
  const url = URL.createObjectURL(file);
  const own = !video;
  if (own) {
    video = document.createElement('video');
    // 화면에 아주 작게 붙여 둔다(화면 밖·숨긴 영상은 브라우저가 디코딩을 멈추기도 한다).
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(video);
  }
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.src = url;
  const meta = { video, url, own };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new VideoError(FORMAT_MSG)), 20000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new VideoError(FORMAT_MSG)); };
    });
    // 디코딩 시작(iPhone Safari). 소리 없는 영상이라 사용자 조작 없이도 재생할 수 있다.
    if (video.readyState < 2) {
      try { await video.play(); } catch (_) {}
      video.pause();
      if (video.readyState < 2) await once(video, 'loadeddata', 5000);
    }
    if (!isFinite(video.duration)) {
      // 일부 webm은 길이를 모른다 → 끝으로 한 번 이동해서 길이를 알아낸다.
      video.currentTime = 1e7;
      await once(video, 'seeked', 3000);
      video.currentTime = 0;
      await once(video, 'seeked', 3000);
    }
    if (!video.videoWidth || !isFinite(video.duration) || video.duration <= 0) throw new VideoError(FORMAT_MSG);
  } catch (e) {
    releaseVideo(meta);
    throw e;
  }
  return { ...meta, duration: video.duration, aspect: video.videoWidth / video.videoHeight };
}

export function releaseVideo({ video, url, own }) {
  try { video.pause(); } catch (_) {}
  video.onloadedmetadata = video.onerror = null;
  video.removeAttribute('src');
  video.load();
  if (own) video.remove();
  URL.revokeObjectURL(url);
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

/** 재생 방식을 쓸 수 있는지. */
export const canPlaybackExtract = () => typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/**
 * people: 1이면 { frames }, 2면 { a, b, overlap } (두 사람을 추적해 따로 저장).
 * ranges: [[시작초, 끝초], ...] 이 구간만 분석(라운드 사이 휴식·준비운동 빼기). 비면 영상 전체.
 * videoEl: 분석하는 동안 재생할 화면 속 <video>(보이는 곳에 있어야 브라우저가 멈추지 않는다). 없으면 숨은 영상을 만든다.
 * mode: 'auto' | 'playback' | 'seek'
 */
export async function analyzeVideo(file, { fps = 20, people = 1, ranges = null, onProgress, signal, videoEl = null, mode = 'auto' } = {}) {
  const meta = await loadVideo(file, videoEl);
  const { video, duration, aspect } = meta;
  try {
    const landmarker = await getLandmarker({ numPoses: people });
    const pa = createPacker(Math.ceil(duration * fps) + 1), pb = people === 2 ? createPacker(Math.ceil(duration * fps) + 1) : null;
    const overlap = [];
    const tracker = people === 2 ? createTracker() : null;
    const base = nextTimestampBase(landmarker);
    const segs = ranges?.length ? ranges.map(([a, b]) => [Math.max(0, a), Math.min(duration, b)]) : [[0, duration]];
    const total = segs.reduce((s, [a, b]) => s + (b - a), 0) || 1;
    let doneSec = 0;

    const take = (t) => {
      const dets = detectAll(landmarker, video, base + t * 1000);
      if (people === 2) {
        const r = tracker.assign(dets);
        pa.push({ t: t * 1000, image: r.a?.image, world: r.a?.world });
        pb.push({ t: t * 1000, image: r.b?.image, world: r.b?.world });
        overlap.push(r.overlap ? 1 : 0);
      } else {
        pa.push({ t: t * 1000, image: dets[0]?.image, world: dets[0]?.world });
      }
    };
    const aborted = () => { if (signal?.aborted) throw new DOMException('분석을 취소했어요', 'AbortError'); };

    let usePlayback = mode === 'playback' || (mode === 'auto' && canPlaybackExtract());
    const used = new Set(); // 실제로 쓴 방식(진단용)
    for (const [a, b] of segs) {
      let from = a;
      if (usePlayback) {
        const r = await playSegment(video, a, b, fps, take, signal, (t) => onProgress?.(Math.min(1, (doneSec + t - a) / total)));
        if (r.kept) used.add('playback');
        if (r.stalledAt != null) { usePlayback = false; from = r.stalledAt + 1 / fps; } // 재생이 멈추면 나머지는 이동 방식으로
        else { doneSec += b - a; continue; }
      }
      const times = frameTimes(duration, fps, [[from, b]]);
      if (times.length) used.add('seek');
      for (let i = 0; i < times.length; i++) {
        aborted();
        const t = times[i];
        if (Math.abs(video.currentTime - t) > 1e-4) {
          video.currentTime = t;
          await once(video, 'seeked', 2000);
        }
        take(t);
        if (i % 5 === 0) onProgress?.(Math.min(1, (doneSec + t - a) / total));
        if (i % 15 === 0) await new Promise((r) => setTimeout(r, 0)); // 화면 갱신 틈
      }
      doneSec += b - a;
    }
    aborted();
    onProgress?.(1);
    const common = { fps, duration, aspect, method: [...used].join('+') };
    return people === 2
      ? { ...common, a: pa.finish(), b: pb.finish(), overlap: Uint8Array.from(overlap) }
      : { ...common, frames: pa.finish() };
  } finally {
    releaseVideo(meta);
  }
}

/**
 * [a, b] 구간을 재생하며 프레임마다 take(영상 속 시각 초)를 부른다. 평균 초당 fps장이 되도록 프레임을 고른다
 * (30fps 영상이면 3장 중 2장).
 * 분석이 재생을 못 따라가 프레임을 많이 놓치면 재생 속도를 낮춘다.
 * 재생이 3초 넘게 멈추면 { stalledAt: 마지막으로 분석한 시각 }을 돌려준다.
 */
function playSegment(video, a, b, fps, take, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const step = 1 / fps;
    let last = -Infinity, next = a, kept = 0, total = 0, startT = null, lastCb = performance.now(), finished = false;
    let rate = 1;
    const finish = (res, err) => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      video.pause();
      if (err) reject(err); else resolve(res);
    };
    const onFrame = (now, m) => {
      if (finished) return;
      lastCb = performance.now();
      if (signal?.aborted) return finish(null, new DOMException('분석을 취소했어요', 'AbortError'));
      const t = m.mediaTime;
      if (t > b + 1e-3) return finish({ kept: total });
      // 다음 목표 시각(next)에 반 프레임(약 17ms) 안으로 다가온 프레임을 쓴다
      if (t >= a - 1e-3 && t + 0.017 >= next && t > last) {
        try { take(t); } catch (e) { return finish(null, e); }
        last = t; kept++; total++;
        next += step;
        if (next < t) next = t + step; // 재생을 못 따라가 많이 건너뛰었으면 목표를 다시 맞춘다
        if (startT == null) startT = t;
        onProgress(t);
        // 2초 이상 지났는데 기대한 프레임의 75%도 못 받았으면 재생을 늦춘다
        const span = t - startT;
        if (span > 2 && kept < span * fps * 0.75 && rate > 0.25) {
          rate = Math.max(0.25, rate * 0.7);
          video.playbackRate = rate;
          startT = t; kept = 1;
        }
      }
      video.requestVideoFrameCallback(onFrame);
    };
    const watch = setInterval(() => {
      if (finished) return;
      if (video.ended || (video.currentTime >= b - 1e-3 && video.paused)) return finish({ kept: total });
      if (performance.now() - lastCb > 3000) {
        if (video.paused) video.play().catch(() => {});
        if (performance.now() - lastCb > 6000) finish({ kept: total, stalledAt: Number.isFinite(last) ? last : a - step });
      }
    }, 500);
    video.addEventListener('ended', () => finish({ kept: total }), { once: true });
    (async () => {
      video.pause();
      video.playbackRate = rate;
      if (Math.abs(video.currentTime - a) > 1e-3) { video.currentTime = a; await once(video, 'seeked', 3000); }
      video.requestVideoFrameCallback(onFrame);
      try { await video.play(); } catch (e) { finish({ stalledAt: a - step }); }
    })();
  });
}
