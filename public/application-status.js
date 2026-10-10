/** 本机记住最近一次注册申请，打开登录/申请页时查询审批结果。 */

const KEY = 'ctu_application';

export function readApplication() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!data?.token) return null;
    return { token: String(data.token), username: String(data.username || '') };
  } catch {
    return null;
  }
}

/** @param {{ token: string, username: string }} row */
export function saveApplication(row) {
  localStorage.setItem(KEY, JSON.stringify({ token: row.token, username: row.username }));
}

export function clearApplication() {
  localStorage.removeItem(KEY);
}

/**
 * @param {HTMLElement | null} el
 * @param {{ prefillUsername?: boolean }} [opts]
 */
export async function renderApplicationStatus(el, opts = {}) {
  if (!el) return null;
  const cached = readApplication();
  if (!cached) {
    el.classList.add('hidden');
    el.textContent = '';
    return null;
  }
  try {
    const res = await fetch('/api/auth/application-status', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cached.token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.textContent = '本机保存的申请在服务器上已找不到';
      el.dataset.status = 'unknown';
      el.classList.remove('hidden');
      return null;
    }
    el.textContent = data.message || '申请状态未知';
    el.dataset.status = data.status || 'unknown';
    el.classList.remove('hidden');
    if (opts.prefillUsername && data.username) {
      const input = document.getElementById('username');
      if (input instanceof HTMLInputElement && !input.value) input.value = data.username;
    }
    return data;
  } catch {
    el.textContent = '暂时无法查询审批状态，请稍后刷新';
    el.dataset.status = 'unknown';
    el.classList.remove('hidden');
    return null;
  }
}
