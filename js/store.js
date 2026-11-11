// 기기에만 저장 (PRD 9절: 영상·기록은 기본적으로 기기 저장). 영상 자체는 저장하지 않는다.
const SETTINGS_KEY = 'strikecoach.settings';
const SESSIONS_KEY = 'strikecoach.sessions';

export const DEFAULT_SETTINGS = {
  name: '',
  level: 'beginner',      // beginner | intermediate
  style: 'kickboxing',    // kickboxing | muaythai
  stance: 'orthodox',     // orthodox | southpaw
  rounds: 3,
  roundSec: 180,
  restSec: 30,
  cueFreq: 'normal',      // low | normal | high
  voice: true,
  cameraId: null,         // 마지막으로 고른 카메라 장치
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (_) {
    return fallback;
  }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 저장 불가 환경 */ }
}

export function loadSettings() {
  const s = read(SETTINGS_KEY, null);
  return s ? { ...DEFAULT_SETTINGS, ...s } : null;
}
export function saveSettings(s) { write(SETTINGS_KEY, s); }

export function listSessions() { return read(SESSIONS_KEY, []); }
export function getSession(id) { return listSessions().find((s) => s.id === id) || null; }
export function saveSession(session) {
  const all = listSessions().filter((s) => s.id !== session.id);
  all.unshift(session);
  write(SESSIONS_KEY, all.slice(0, 200));
}
