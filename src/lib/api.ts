const TOKEN_STORAGE_KEY = 'agro_marconato_token';
let memoryToken: string | null = null;

export function getAuthToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      memoryToken = stored;
      return stored;
    }
  } catch {
    // ignore storage errors in restricted iframes
  }
  return null;
}

export function setAuthToken(token: string | null) {
  memoryToken = token || null;
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export class ApiError extends Error {
  status: number;
  details?: any;
  constructor(message: string, status: number, details?: any) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const token = getAuthToken();
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };

  const resp = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401 && !url.startsWith('/api/auth/login') && !url.startsWith('/api/auth/register')) {
      setAuthToken(null);
      window.dispatchEvent(new CustomEvent('agro:session-expired'));
    }
    throw new ApiError(data?.error || `Erro na requisição (${resp.status})`, resp.status, data);
  }
  return data as T;
}
