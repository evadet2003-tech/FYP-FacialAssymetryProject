const API_URL = import.meta.env.VITE_API_URL || 'https://facial-analysis-api-production.up.railway.app/api';

function getToken(): string | null {
  return localStorage.getItem('token');
}

export async function apiRegister(name: string, email: string, username: string, password: string) {
  const res = await fetch(`${API_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, username, password }),
  });
  return res.json();
}

export async function apiLogin(username: string, password: string) {
  const res = await fetch(`${API_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.json();
}

export async function apiSaveSession(imageDataUrl: string, result: unknown) {
  const res = await fetch(`${API_URL}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
    },
    body: JSON.stringify({ imageDataUrl, result }),
  });
  return res.json();
}

export async function apiGetSessions() {
  const res = await fetch(`${API_URL}/sessions`, {
    headers: { 'Authorization': `Bearer ${getToken()}` },
  });
  return res.json();
}

export async function apiDeleteSession(sessionId: string) {
  const res = await fetch(`${API_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${getToken()}` },
  });
  return res.json();
}