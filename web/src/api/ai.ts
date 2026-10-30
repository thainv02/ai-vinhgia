/** Gọi API quản trị AI local: tự mở phiên (cookie HttpOnly + CSRF) và thử lại một lần khi phiên hết hạn. */
let adminSession: Promise<{ csrf: string }> | null = null;
let sessionUntil = 0;
export async function aiRequest<T>(url: string, method = 'GET', body?: unknown, retrySession = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    if (!adminSession || Date.now() >= sessionUntil) {
      sessionUntil = Date.now() + 45 * 60000;
      adminSession = fetch('/api/ai/session').then(async (session) => {
        if (!session.ok) throw new Error('Không mở được phiên quản trị');
        return session.json() as Promise<{ csrf: string }>;
      }).catch((error) => { adminSession = null; throw error; });
    }
    headers['X-AI-CSRF'] = (await adminSession).csrf;
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await r.json();
  if (!r.ok && result.error?.code === 'AI_ADMIN_REQUIRED' && retrySession) {
    adminSession = null; return aiRequest<T>(url, method, body, false);
  }
  if (!r.ok) throw new Error(result.error?.message ?? 'Yêu cầu thất bại');
  return result;
}
