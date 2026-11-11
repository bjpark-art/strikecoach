// 실시간 음성 큐 규칙 (PRD 7절): 한 번에 하나, 같은 큐는 최소 10초 간격, 문제 + 해결책.
const MIN_GAP = { low: 5000, normal: 2500, high: 1500 };

export const CUE_TEXT = {
  guardDrop_rear: { title: '가드 올려!', detail: '뒷손이 턱에서 떨어졌어요', kind: 'warn' },
  guardDrop_lead: { title: '앞손 회수!', detail: '잽을 뻗은 뒤 앞손을 바로 턱으로', kind: 'warn' },
  praise: { title: '좋아요, 그 리듬 유지', detail: '가드가 잘 유지되고 있어요', kind: 'good' },
  lost: { title: '몸 전체가 보이게 서주세요', detail: '자세를 찾지 못하고 있어요', kind: 'warn' },
};

export function createCueEngine({ freq = 'normal' } = {}) {
  const gap = MIN_GAP[freq] ?? MIN_GAP.normal;
  let lastAny = -1e9;
  const lastByKey = {};
  let punchesSincePraise = 0;
  let lastDrop = -1e9;

  function trySay(key, t, cooldown) {
    if (t - lastAny < gap) return null;
    if (t - (lastByKey[key] ?? -1e9) < cooldown) return null;
    lastAny = t;
    lastByKey[key] = t;
    return { key, t, ...CUE_TEXT[key] };
  }

  return {
    onEvents(events, t) {
      let cue = null;
      for (const e of events) {
        if (e.type === 'guardDrop') {
          lastDrop = t;
          cue = cue || trySay('guardDrop_' + e.hand, t, 10000);
        } else if (e.type === 'punch') {
          punchesSincePraise++;
        }
      }
      if (!cue && punchesSincePraise >= 20 && t - lastDrop > 15000) {
        cue = trySay('praise', t, 20000);
        if (cue) punchesSincePraise = 0;
      }
      return cue;
    },
    onLost(t) {
      return trySay('lost', t, 8000);
    },
  };
}

export function speak(text) {
  try {
    const ss = window.speechSynthesis;
    if (!ss) return;
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.1;
    ss.speak(u);
  } catch (_) { /* 음성 미지원 브라우저는 화면 카드만 보여준다 */ }
}
