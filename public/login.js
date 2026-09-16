/**
 * 控制台登录页；默认密码登录后由首页强制改密。
 */

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
    location.href = '/';
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
