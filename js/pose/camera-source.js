// 전면 카메라 + MediaPipe Pose Landmarker(온디바이스, 브라우저 WASM/GPU).
import { getLandmarker, detect } from './landmarker.js';

export class CameraError extends Error {}

function cameraMessage(name) {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '카메라 권한이 막혀 있어요. 주소창 왼쪽 자물쇠 아이콘에서 카메라를 "허용"으로 바꾼 뒤 다시 시도해 주세요. (Windows 설정 > 개인 정보 > 카메라에서 브라우저 접근도 켜져 있어야 해요)';
    case 'NotReadableError':
    case 'AbortError':
      return '다른 앱(Zoom, Teams, 카메라 앱 등)이 카메라를 쓰고 있어요. 그 앱을 닫고 다시 시도해 주세요.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '연결된 카메라를 찾지 못했어요. 웹캠이 꽂혀 있는지 확인해 주세요.';
    default:
      return `카메라를 시작하지 못했어요 (${name || '알 수 없는 오류'}).`;
  }
}

/** 연결된 카메라 목록. 권한을 한 번 받은 뒤에야 이름(label)이 채워진다. */
export async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `카메라 ${i + 1}` }));
  } catch (_) {
    return [];
  }
}

export async function createCameraSource({ deviceId = null } = {}) {
  if (location.protocol === 'file:') {
    throw new CameraError('파일을 직접 열면 동작하지 않아요. 서버를 켜고 http://localhost:5173 으로 열어주세요.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('이 주소에서는 카메라를 쓸 수 없어요. http://localhost:5173 (PC) 또는 https 주소로 열어주세요.');
  }
  let stream;
  try {
    const constraints = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (first) {
    // 일부 PC 웹캠은 facingMode/해상도 조건을 못 맞춘다 → 조건 없이 한 번 더.
    const retryable = first && (first.name === 'OverconstrainedError' || first.name === 'NotFoundError' || first.name === 'NotReadableError' || first.name === 'AbortError');
    try {
      if (!retryable) throw first;
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e) {
      console.warn('getUserMedia 실패', first, e);
      throw new CameraError(`${cameraMessage(e && e.name)} [${(e && e.name) || 'Error'}]`);
    }
  }

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play();

  let landmarker;
  try {
    landmarker = await getLandmarker();
  } catch (e) {
    console.error('자세 인식 모델 로드 실패', e);
    stream.getTracks().forEach((tr) => tr.stop());
    throw new CameraError(`카메라는 켜졌지만 자세 인식 모델을 불러오지 못했어요. 인터넷 연결을 확인해 주세요. (${(e && (e.message || e.name)) || '알 수 없는 오류'})`);
  }

  let handler = null, running = false, raf = 0, lastVideoTime = -1;
  const loop = () => {
    if (!running) return;
    if (handler && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      const { image, world } = detect(landmarker, video, now);
      handler({ t: now, image, world });
    }
    raf = requestAnimationFrame(loop);
  };

  const track = stream.getVideoTracks()[0];
  return {
    kind: 'camera',
    video,
    deviceId: track?.getSettings?.().deviceId || deviceId,
    label: track?.label || '',
    get aspect() { return video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9; },
    listen(fn) {
      handler = fn;
      if (!running) { running = true; loop(); }
    },
    stop() {
      running = false;
      handler = null;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((tr) => tr.stop());
    },
  };
}
