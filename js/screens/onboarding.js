import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../store.js';
import { icon, esc, bindChips, pressedValue } from '../ui/icons.js';

const chip = (v, label, cur) => `<button class="chip" data-v="${v}" aria-pressed="${v === cur}">${label}</button>`;

export function mount(root, ctx) {
  const existing = loadSettings();
  const s = existing || { ...DEFAULT_SETTINGS };

  root.innerHTML = `
  <section class="screen">
    ${existing ? `<div class="head"><button class="icon-btn" data-back aria-label="뒤로">${icon('back')}</button><h1>내 정보</h1></div>` : ''}
    <div class="body">
      ${existing ? '' : `<div><div class="eyebrow">시작하기</div><p class="hero-title">피드백을 내 수준에<br>맞출게요</p></div>`}
      <div class="field">
        <h2><label for="nameInput">이름</label></h2>
        <input id="nameInput" class="text-input" maxlength="20" placeholder="예: 지훈" value="${esc(s.name)}">
      </div>
      <div class="field">
        <h2>운동 경력</h2>
        <div class="chips" data-single id="level">
          ${chip('beginner', '1년 미만', s.level)}${chip('intermediate', '1년 이상', s.level)}
        </div>
        <span class="small muted">1년 미만이면 가드 판정을 조금 너그럽게 해요.</span>
      </div>
      <div class="field">
        <h2>스타일</h2>
        <div class="chips" data-single id="style">
          ${chip('kickboxing', '킥복싱', s.style)}${chip('muaythai', '무에타이', s.style)}
        </div>
      </div>
      <div class="field">
        <h2>스탠스</h2>
        <div class="chips" data-single id="stance">
          ${chip('orthodox', '오소독스 (왼발 앞)', s.stance)}${chip('southpaw', '사우스포 (오른발 앞)', s.stance)}
        </div>
        <span class="small muted">앞손 잽과 뒷손 크로스를 구분하는 데 써요.</span>
      </div>
      <div class="card stack">
        <div class="row">${icon('cam', 'color:var(--accent-ink)')}<span class="grow small">카메라 영상은 이 기기 안에서만 분석하고 저장하지 않아요. 기록(숫자)만 이 브라우저에 남아요.</span></div>
      </div>
      <div style="flex:1"></div>
      <button class="btn btn-primary" id="save">${existing ? '저장' : '시작하기'}</button>
    </div>
  </section>`;

  bindChips(root);
  root.querySelector('[data-back]')?.addEventListener('click', () => ctx.go('home'));
  root.querySelector('#save').addEventListener('click', () => {
    saveSettings({
      ...s,
      name: root.querySelector('#nameInput').value.trim(),
      level: pressedValue(root.querySelector('#level')),
      style: pressedValue(root.querySelector('#style')),
      stance: pressedValue(root.querySelector('#stance')),
    });
    ctx.go('home');
  });
}
