// Shared bounded CDP transport; no DOM or network response overrides.
export class Cdp {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener("message", ({ data }) => {
      const value = JSON.parse(data);
      if (value.id) { const call = this.pending.get(value.id); if (!call) return; this.pending.delete(value.id); clearTimeout(call.timer);
        if (value.error) call.reject(new Error(`${call.method}: ${JSON.stringify(value.error)}`)); else call.resolve(value.result); }
      else for (const callback of this.listeners.get(`${value.sessionId || ""}:${value.method}`) || []) callback(value.params);
    });
    socket.addEventListener("close", () => { for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error(`CDP closed: ${call.method}`)); } this.pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((yes, no) => {
      const timer = setTimeout(() => { socket.close(); no(new Error("CDP WebSocket connection timeout")); }, 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); yes(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); no(new Error("CDP WebSocket handshake failed")); }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP command timeout: ${method}`)); }, 15000);
      this.pending.set(id, { method, resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
  }
  on(session, event, callback) { const key = `${session}:${event}`; const values = this.listeners.get(key) || []; values.push(callback); this.listeners.set(key, values); }
  close() { this.socket.close(); }
}
