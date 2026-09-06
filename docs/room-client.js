(() => {
  'use strict';
  const PROTOCOL = 1;
  // Only the configured server can own a room. A lost connection never elects
  // a browser host or resumes local simulation of the shared world.
  class EncoreRoom extends EventTarget {
    constructor(config, player) {
      super();
      this.config = config || {}; this.player = player;
      this.connected = false; this.authoritative = Boolean(this.config.serverUrl);
      this.statusReason = this.authoritative ? 'not-connected' : 'offline';
      this.admission = this.authoritative ? 'pending' : 'offline';
      this.members = new Map(); this.socket = null; this.stopped = false;
      this.seq = 0; this.tick = -1; this.epoch = null; this.retry = 0; this.lastSnapshotAt = 0;
      this.storageKey = `encore-resume:${this.config.serverUrl}:${this.config.roomId || 'royal'}:${player.id}`;
      try { this.resumeToken = sessionStorage.getItem(this.storageKey); } catch { this.resumeToken = null; }
    }
    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    clearMembers(reason, count = null) {
      this.connected = false;
      this.statusReason = reason;
      this.admission = reason === 'room_full' || reason === 'server_full' ? 'rejected-full' : (reason === 'offline' ? 'offline' : 'not-connected');
      for (const id of this.members.keys()) if (id !== this.player.id) this.emit('leave', { id });
      this.members.clear();
      // A rejected/disconnected client has no authoritative presence list.
      // Keep occupancy unknown instead of turning the cleared local map into
      // a false zero. A server-provided count is safe to retain for a full
      // response, but only when it is an actual bounded integer.
      const verifiedCount = Number.isSafeInteger(count) && count >= 0 && count <= 8 ? count : null;
      this.emit('presence', { count: verifiedCount, connected: false, full: reason === 'room_full', verified: verifiedCount !== null });
      this.emit('status', { connected: false, reason, count: verifiedCount, verified: verifiedCount !== null });
    }
    setInputSource(source) { this.inputSource = source; }
    async connect() {
      if (this.stopped || this.socket) return false;
      if (!this.authoritative) { this.clearMembers('offline'); return false; }
      let url;
      try {
        url = new URL(this.config.serverUrl);
        const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
        if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))) throw Error('Secure server URL required');
      } catch { this.clearMembers('invalid_server'); return false; }
      if (!this.pump) this.pump = setInterval(() => {
        const controls = this.inputSource?.();
        if (this.connected && controls) this.publishInput(controls);
        if (this.connected && performance.now() - this.lastSnapshotAt > 2000) {
          this.clearMembers('reconnecting'); this.socket?.close(4009, 'snapshot_timeout');
        }
      }, 1000 / 30);
      this.statusReason = 'connecting'; this.admission = 'pending';
      this.emit('status', { connected: false, reason: 'connecting' });
      const socket = new WebSocket(url.href); this.socket = socket;
      let terminal = false;
      this.connectTimeout = setTimeout(() => socket.close(4009, 'connect_timeout'), 6000);
      socket.addEventListener('open', () => {
        if (this.stopped || this.socket !== socket) return;
        socket.send(JSON.stringify({ type: 'join', protocol: PROTOCOL, room: this.config.roomId || 'royal', resumeToken: this.resumeToken, profile: this.player }));
      });
      socket.addEventListener('message', event => {
        if (this.stopped || this.socket !== socket) return;
        let msg; try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'rejected') {
          terminal = true; this.clearMembers(msg.reason, msg.count);
          if (msg.reason === 'room_full' || msg.reason === 'server_full') this.emit('full', { reason: msg.reason, count: msg.count });
          return;
        }
        if (msg.type === 'welcome') {
          if (msg.protocol !== PROTOCOL) { terminal = true; socket.close(); this.clearMembers('version_mismatch'); return; }
          this.player.id = msg.id; this.resumeToken = msg.resumeToken;
          try { sessionStorage.setItem(this.storageKey, this.resumeToken); } catch {}
          this.epoch = msg.epoch; this.tick = -1; this.seq = 0;
          this.statusReason = 'welcomed'; this.admission = 'pending';
          this.emit('welcome', msg); return;
        }
        if (msg.type !== 'snapshot' || msg.protocol !== PROTOCOL || msg.epoch !== this.epoch || !Number.isSafeInteger(msg.tick) || msg.tick <= this.tick || !Array.isArray(msg.players)) return;
        if (!msg.players.some(p => p.id === this.player.id)) return;
        clearTimeout(this.connectTimeout);
        this.tick = msg.tick; this.lastSnapshotAt = performance.now(); this.retry = 0;
        const wasConnected = this.connected; this.connected = true;
        const next = new Map(msg.players.map(p => [p.id, p]));
        for (const [id, member] of next) if (id !== this.player.id && !this.members.has(id)) this.emit('join', member);
        for (const id of this.members.keys()) if (id !== this.player.id && !next.has(id)) this.emit('leave', { id });
        this.members = next; this.statusReason = 'live'; this.admission = 'accepted'; this.emit('snapshot', msg);
        this.emit('presence', { count: next.size, connected: true, full: false });
        if (!wasConnected) this.emit('status', { connected: true, reason: 'live' });
      });
      socket.addEventListener('error', () => {});
      socket.addEventListener('close', event => {
        if (this.socket !== socket) return;
        clearTimeout(this.connectTimeout); this.socket = null;
        if (this.stopped) return;
        if (event.code === 4001) { terminal = true; this.clearMembers('session_replaced'); }
        if (terminal) { clearInterval(this.pump); this.pump = null; return; }
        this.clearMembers('reconnecting');
        const delay = Math.min(5000, 300 * 2 ** Math.min(this.retry++, 4));
        this.retryTimer = setTimeout(() => this.connect(), delay);
      });
      return true;
    }
    publishInput(input) {
      if (!this.connected || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 8192) return;
      this.socket.send(JSON.stringify({ type: 'input', seq: this.seq++, input }));
    }
    track() {
      if (this.connected && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'profile', profile: this.player }));
    }
    // Legacy callers cannot publish authoritative state or outcomes.
    publishState() {}
    send() {}
    async leave() {
      this.stopped = true;
      clearInterval(this.pump); clearTimeout(this.retryTimer); clearTimeout(this.connectTimeout); this.pump = null;
      const socket = this.socket; this.socket = null; this.clearMembers('left');
      try { sessionStorage.removeItem(this.storageKey); } catch {}
      this.resumeToken = null;
      if (!socket || socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 800);
        socket.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, { once: true });
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }));
        socket.close(1000, 'left');
      });
    }
  }
  window.EncoreRoom = EncoreRoom;
})();
