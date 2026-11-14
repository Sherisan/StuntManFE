// GameEngineAPI client for Bike It.
//
// The game server decides every round: POST api/play takes the stake, draws
// the crash point with its provably fair RNG (EasyRNG, 4% house edge) and pays
// any win into the player's wallet. This module only talks to it.
//
// Session: the lobby launches the game as /?token=<jwt> (the token names the
// game, so the server knows this is "bike-it"). In local dev, with no token in
// the URL, a demo token is fetched from the API's /api/dev-token.

export const GAME_ID = 'bike-it';
const API_BASE = (import.meta.env.VITE_GAME_API_URL || 'http://localhost:5003').replace(/\/$/, '');
const TOKEN_KEY = 'bikeit_session_token';

let token = null;

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Can't reach the game server.", 'OFFLINE', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw new ApiError('Your session has expired. Reopen the game from the lobby.', 'UNAUTHORIZED', 401);
    throw new ApiError(data?.error || data?.message || `Game server error (${res.status}).`, data?.code || 'ERROR', res.status);
  }
  return data;
}

// Picks up the launch token (and drops it from the address bar so it isn't
// shared by copying the URL), falling back to a dev token locally.
export async function connect() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    token = fromUrl;
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    params.delete('token');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
  } else {
    token = sessionStorage.getItem(TOKEN_KEY);
  }
  if (!token && import.meta.env.DEV) await fetchDevToken();
  if (!token) throw new ApiError('No game session. Open Bike It from the lobby.', 'NO_SESSION', 401);
  try {
    return await getInfo();
  } catch (e) {
    // A saved dev token can outlive its 4 hours: get a fresh one.
    if (e.status !== 401 || !import.meta.env.DEV) throw e;
    await fetchDevToken();
    return getInfo();
  }
}

async function fetchDevToken() {
  const dev = await request(`/api/dev-token?gameId=${GAME_ID}`, { auth: false });
  token = dev.token;
  sessionStorage.setItem(TOKEN_KEY, token);
}

// Game limits, max target multiplier and the current seed hash.
export const getInfo = () => request('/api/play/info');

export const getBalance = () => request('/api/wallet/balance');

// One round: { roundId, stake, win, multiplier, crashPoint, balance, proof, winPending }.
export const play = (stake, target) => request('/api/play', { method: 'POST', body: { stake, target } });
