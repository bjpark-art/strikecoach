import { loadSettings } from './store.js';
import * as onboarding from './screens/onboarding.js';
import * as home from './screens/home.js';
import * as setup from './screens/setup.js';
import * as live from './screens/live.js';
import * as report from './screens/report.js';

const routes = { onboarding, home, setup, live, report };
const root = document.getElementById('app');

// 화면 사이에 넘기는 상태. 카메라 소스는 촬영 준비 → 실시간 훈련까지 이어서 쓴다.
const ctx = {
  source: null,
  reportId: null,
  go,
};

let cleanup = null;

function go(name) {
  if (location.hash.slice(1) !== name) location.hash = name;
  else render();
}

function render() {
  let name = location.hash.slice(1) || 'home';
  if (!routes[name]) name = 'home';
  if (!loadSettings() && name !== 'onboarding') name = 'onboarding';
  if (name === 'live' && !ctx.source) name = 'setup';

  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  if (name !== 'setup' && name !== 'live' && ctx.source) {
    ctx.source.stop();
    ctx.source = null;
  }
  root.innerHTML = '';
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  cleanup = routes[name].mount(root, ctx) || null;
}

window.addEventListener('hashchange', render);
render();
