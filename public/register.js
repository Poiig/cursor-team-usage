/**
 * 公开注册申请页。成功后把回执存在本机，再次打开可看到是否通过。
 */

import { renderApplicationStatus, saveApplication } from './application-status.js';

const form = document.getElementById('registerForm');
const errEl = document.getElementById('registerError');
const statusEl = document.getElementById('applicationStatus');
const btn = document.getElementById('btnRegister');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl?.classList.add('hidden');
  const username = String(document.getElementById('username')?.value || '').trim();
  const password = String(document.getElementById('password')?.value || '');
  const password2 = String(document.getElementById('password2')?.value || '');
  if (password !== password2) {
    if (errEl) {
      errEl.textContent = '两次输入的密码不一致';
      errEl.classList.remove('hidden');
    }
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '提交中…';
  }
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '注册失败');
    if (data.token) saveApplication({ token: data.token, username: data.user?.username || username });
    await renderApplicationStatus(statusEl);
    form?.reset();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '提交申请';
    }
  }
});

renderApplicationStatus(statusEl);
