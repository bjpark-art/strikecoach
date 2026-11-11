// MediaPipe Pose Landmarker 공용 인스턴스 (카메라·영상 분석이 함께 쓴다).
const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

let promise = null;
let lastTs = 0;

export function getLandmarker() {
  if (!promise) {
    promise = (async () => {
      const vision = await import(`${CDN}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const make = (delegate) => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
      // GPU(WebGL)를 못 쓰는 PC가 있어서 실패하면 CPU로 다시 만든다.
      try {
        return await make('GPU');
      } catch (e) {
        console.warn('GPU 모드 실패, CPU로 재시도', e);
        return await make('CPU');
      }
    })();
    promise.catch(() => { promise = null; });
  }
  return promise;
}

/** VIDEO 모드는 타임스탬프가 계속 증가해야 하므로, 카메라·영상 어느 쪽에서 불러도 단조 증가를 보장한다. */
export function detect(landmarker, el, ts) {
  ts = Math.max(ts, lastTs + 1);
  lastTs = ts;
  const r = landmarker.detectForVideo(el, ts);
  const image = r.landmarks?.[0] || null;
  const world = r.worldLandmarks?.[0] || null;
  if (image && world) world.forEach((p, i) => { if (p.visibility == null) p.visibility = image[i].visibility; });
  return { image, world };
}

/** 새 영상 분석을 시작할 때 쓸 타임스탬프 기준점. */
export function nextTimestampBase() {
  return lastTs + 1000;
}
