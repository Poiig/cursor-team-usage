/**
 * 控制台登录页。本机若有注册申请，打开页面即显示审批结果。
 */

import { clearApplication, readApplication, renderApplicationStatus } from './application-status.js';

const form = document.getElementById('loginForm');
const errEl = document.getElementById('loginError');
const btn = document.getElementById('btnLogin');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl?.classList.add('hidden');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '登录中…';
  }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username')?.value,
        password: document.getElementById('password')?.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');
    // 首页启动时根据 /api/auth/me 再确认，此处仅作提示标记。
    if (data.mustChangePassword) {
      sessionStorage.setItem('ctu_force_password', '1');
    } else {
      sessionStorage.removeItem('ctu_force_password');
    }
    const cached = readApplication();
    if (cached && cached.username === data.username) clearApplication();
    // 回到登录前的页面；只接受站内路径，防开放跳转
    const next = new URLSearchParams(location.search).get('next') || '/';
    const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    location.href = `${safe}${location.hash}`;
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  }
});

renderApplicationStatus(document.getElementById('applicationStatus'), { prefillUsername: true });
