// MediaPipe Pose Landmarker 공용 인스턴스. 사람 수(numPoses)별로 하나씩 만들어 재사용한다.
const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const cache = new Map();          // numPoses → Promise<PoseLandmarker>
const lastTs = new WeakMap();     // landmarker → 마지막 타임스탬프

export function getLandmarker({ numPoses = 1 } = {}) {
  if (!cache.has(numPoses)) {
    const p = (async () => {
      const vision = await import(`${CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses,
      });
      // GPU(WebGL)를 못 쓰는 PC가 있어서 실패하면 CPU로 다시 만든다.
      try {
        return await make('GPU');
      } catch (e) {
        console.warn('GPU 모드 실패, CPU로 재시도', e);
        return await make('CPU');
      }
    })();
    p.catch(() => cache.delete(numPoses));
    cache.set(numPoses, p);
  }
  return cache.get(numPoses);
}

/** VIDEO 모드는 인스턴스마다 타임스탬프가 계속 증가해야 한다. 감지된 모든 사람을 돌려준다. */
export function detectAll(landmarker, el, ts) {
  ts = Math.max(ts, (lastTs.get(landmarker) || 0) + 1);
  lastTs.set(landmarker, ts);
  const r = landmarker.detectForVideo(el, ts);
  return (r.landmarks || []).map((image, i) => {
    const world = r.worldLandmarks?.[i] || null;
    if (world) world.forEach((p, j) => { if (p.visibility == null) p.visibility = image[j].visibility; });
    return { image, world };
  }).filter((d) => d.world);
}

/** 한 사람만 필요할 때. */
export function detect(landmarker, el, ts) {
  return detectAll(landmarker, el, ts)[0] || { image: null, world: null };
}

/** 새 영상 분석을 시작할 때 쓸 타임스탬프 기준점. */
export function nextTimestampBase(landmarker) {
  return (lastTs.get(landmarker) || 0) + 1000;
}
