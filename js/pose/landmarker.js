// MediaPipe Pose Landmarker 공용 인스턴스. 사람 수(numPoses)별로 하나씩 만들어 재사용한다.
const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const modelUrl = (size) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${size}/float16/1/pose_landmarker_${size}.task`;

// 추적 기준(minTrackingConfidence). 아래 설명 참고. 검증 도구가 다른 값으로 시험할 수 있게 인자로도 받는다.
export const TRACKING_CONF = 0.65;

const cache = new Map();          // `${numPoses}:${model}` → Promise<PoseLandmarker>
const lastTs = new WeakMap();     // landmarker → 마지막 타임스탬프
const modeOf = new WeakMap();     // landmarker → 'VIDEO' | 'IMAGE'

/** model: 'lite'(앱 기본, 가장 빠름) | 'full' | 'heavy'(가장 정확, 느림) */
export function getLandmarker({ numPoses = 1, model = 'lite', mode = 'VIDEO', tracking = TRACKING_CONF } = {}) {
  const key = `${numPoses}:${model}:${mode}:${tracking}`;
  const MODEL = modelUrl(model);
  if (!cache.has(key)) {
    const p = (async () => {
      const vision = await import(`${CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: mode, // VIDEO: 프레임 사이 추적·스무딩 / IMAGE: 프레임마다 독립 (검증 실험용)
        numPoses,
        // 기본값(0.5)이면 첫 프레임에서 잘못 잡은 자세를 몇 초씩 계속 따라간다(실제 영상: 첫 분석에서 4.6초 동안
        // 발목을 허리 높이로 잡아 없는 킥 13개). 높이면 추적이 불확실할 때 사람을 다시 찾아 바로잡는다. 속도 차이 없음.
        // 0.65 vs 0.8(2026-11-17 검증): 1인은 결과가 같고, 2인(스파링)은 0.8이면 두 사람이 자주 뒤바뀌어 인식이 줄었다
        // (미트 영상 64% → 39%). 0.65는 2인에서 0.5와 비슷하고 1인의 없는 킥 문제도 고친다.
        minTrackingConfidence: tracking,
      });
      // GPU(WebGL)를 못 쓰는 PC가 있어서 실패하면 CPU로 다시 만든다.
      try {
        return await make('GPU');
      } catch (e) {
        console.warn('GPU 모드 실패, CPU로 재시도', e);
        return await make('CPU');
      }
    })();
    p.then((lm) => modeOf.set(lm, mode), () => {});
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

/** VIDEO 모드는 인스턴스마다 타임스탬프가 계속 증가해야 한다. 감지된 모든 사람을 돌려준다. */
export function detectAll(landmarker, el, ts) {
  ts = Math.max(ts, (lastTs.get(landmarker) || 0) + 1);
  lastTs.set(landmarker, ts);
  const r = modeOf.get(landmarker) === 'IMAGE' ? landmarker.detect(el) : landmarker.detectForVideo(el, ts);
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
