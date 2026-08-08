class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.joinedRooms = new Set();
    this.leftRooms = [];
    this.outbound = [];
    this.handshake = { headers: {}, address: '127.0.0.1' };
    this.id = 'socket-1';
  }
  on(event, handler) { this.handlers.set(event, handler); }
  async trigger(event, ...args) { return this.handlers.get(event)(...args); }
  join(room) { this.joinedRooms.add(room); }
  leave(room) { this.joinedRooms.delete(room); this.leftRooms.push(room); }
  emit(event, payload) { this.outbound.push({ target: 'self', event, payload }); }
  to(room) {
    return { emit: (event, payload) => this.outbound.push({ target: room, event, payload }) };
  }
  disconnect() { this.disconnected = true; }
}

class FakeIo {
  constructor() { this.outbound = []; this.sockets = []; }
  to(room) { return { emit: (event, payload) => this.outbound.push({ room, event, payload }) }; }
  emit(event, payload) { this.outbound.push({ room: '*', event, payload }); }
  async fetchSockets() { return this.sockets; }
}

function queryResult(value) {
  return {
    lean: async () => value,
    sort() { return this; },
    limit() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

function acknowledge() {
  let value;
  return { callback(result) { value = result; }, value() { return value; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

module.exports = { FakeSocket, FakeIo, queryResult, acknowledge, deferred };
