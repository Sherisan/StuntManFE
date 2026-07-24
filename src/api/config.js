// Base URL of the Worldiator.Server API.
// Override in dev via a .env file: VITE_API_BASE=http://localhost:5059
// The .NET dev profile listens on http://localhost:5059 (Properties/launchSettings.json).
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5059';

export const HUB_URL = `${API_BASE}/gamehub`;
export const DEV_TOKEN_URL = `${API_BASE}/api/dev-token`;
export const HISTORY_URL = `${API_BASE}/api/game/history`;
