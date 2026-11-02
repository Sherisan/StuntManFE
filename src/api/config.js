// Base URL of the GameEngineAPI (Worldiator.Server) in ./GameEngineAPI.
// It listens on http://localhost:5003 ("Urls" in its appsettings.json).
// Override via a .env file: VITE_API_BASE=http://host:port
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:5003';

export const HUB_URL = `${API_BASE}/gamehub`;
export const DEV_TOKEN_URL = `${API_BASE}/api/dev-token`;
export const HISTORY_URL = `${API_BASE}/api/game/history`;
