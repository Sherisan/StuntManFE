import * as signalR from '@microsoft/signalr';
import { HUB_URL, DEV_TOKEN_URL, HISTORY_URL } from './config.js';

// Thin client over the Worldiator SignalR hub.
//
// Under the chosen integration (keep the prediction game, source RNG + balance
// from the server) this client does NOT place server-side bets. It:
//   • authenticates with a dev-token JWT and opens the hub,
//   • reads the player's server balance (ConnectedAs),
//   • consumes the provably-fair crash-multiplier stream (RoundCrashed) and
//     keeps the latest outcome so each local launch can use a real server RNG
//     value instead of local crypto.
//
// A REST history fetch seeds an initial multiplier so the very first bet does
// not have to wait for a live round to crash.

export class GameServer {
  constructor() {
    this.conn = null;
    this.token = null;
    this.status = 'offline';        // 'offline' | 'connecting' | 'live'
    this.balance = null;            // server-reported balance, or null if unknown
    this.latestOutcome = null;      // { multiplier, roundId, serverSeed, serverSeedHash, clientSeed, nonce }
    this.onStatus = null;
    this.onBalance = null;
    this.onOutcome = null;
  }

  _setStatus(s) { this.status = s; this.onStatus?.(s); }

  async _fetchToken() {
    if (this.token) return this.token;
    const res = await fetch(DEV_TOKEN_URL, { method: 'GET' });
    if (!res.ok) throw new Error(`dev-token ${res.status}`);
    const { token } = await res.json();
    this.token = token;
    return token;
  }

  // Best-effort: seed an initial crash multiplier from REST history so the first
  // launch is instant. Full fairness fields arrive later via the live stream.
  async _seedFromHistory() {
    try {
      const res = await fetch(`${HISTORY_URL}?count=1`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      });
      if (!res.ok) return;
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length) {
        const r = rows[0];
        this._applyOutcome({
          multiplier: Number(r.crashMultiplier),
          roundId: r.roundId,
          serverSeed: null,
          serverSeedHash: null,
          clientSeed: null,
          nonce: null,
        });
      }
    } catch { /* non-fatal */ }
  }

  _applyOutcome(o) {
    if (!o || !Number.isFinite(o.multiplier)) return;
    this.latestOutcome = o;
    this.onOutcome?.(o);
  }

  async connect() {
    this._setStatus('connecting');
    try {
      await this._fetchToken();

      const conn = new signalR.HubConnectionBuilder()
        .withUrl(HUB_URL, { accessTokenFactory: () => this.token })
        .withAutomaticReconnect([0, 1000, 2000, 5000, 10000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

      conn.on('ConnectedAs', (info) => {
        if (info && typeof info.balance === 'number') {
          this.balance = info.balance;
          this.onBalance?.(info.balance);
        }
      });

      conn.on('RoundCrashed', (dto) => {
        this._applyOutcome({
          multiplier: Number(dto.crashMultiplier),
          roundId: dto.roundId,
          serverSeed: dto.serverSeed ?? null,
          serverSeedHash: dto.serverSeedHash ?? null,
          clientSeed: dto.clientSeed ?? null,
          nonce: dto.nonce ?? null,
        });
      });

      // Broadcast events this integration doesn't consume. Registering no-op
      // handlers keeps SignalR from logging a warning on every message (the
      // server emits MultiplierUpdated ~10×/sec during the flying phase).
      conn.on('MultiplierUpdated', () => {});
      conn.on('RoundStarted', () => {});
      conn.on('BetAdded', () => {});
      conn.on('BetCashedOut', () => {});

      conn.onreconnecting(() => this._setStatus('connecting'));
      conn.onreconnected(() => this._setStatus('live'));
      conn.onclose(() => this._setStatus('offline'));

      this.conn = conn;
      await conn.start();
      this._setStatus('live');
      await this._seedFromHistory();
      return true;
    } catch (err) {
      console.warn('[GameServer] connect failed — running with offline RNG:', err?.message || err);
      this._setStatus('offline');
      return false;
    }
  }

  // Returns the crash multiplier to drive the next launch, or null if the server
  // has never supplied one (caller then falls back to local RNG). This is a
  // one-shot take, not a peek: without clearing latestOutcome here, a player
  // who bets faster than the server's own round cadence would silently get
  // the same stale roundId/multiplier replayed across multiple flights —
  // undermining the "provably fair" display (same round shown twice) even
  // though nothing about the bet itself was wrong. Once taken, the next call
  // falls back to local RNG until a fresh RoundCrashed arrives.
  takeOutcome() {
    const o = this.latestOutcome;
    this.latestOutcome = null;
    return o;
  }

  async disconnect() {
    try { await this.conn?.stop(); } catch { /* ignore */ }
    this.conn = null;
  }
}
