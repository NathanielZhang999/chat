class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.joinedRooms = new Set();
    this.leftRooms = [];
    this.outbound = [];
    this.handshake = { headers: {}, address: '127.0.0.1' };
    this.id = 'socket-1';
    this.clientContextId = 1;
  }
  on(event, handler) { this.handlers.set(event, handler); }
  async trigger(event, ...args) {
    if (['chat_message', 'edit_message', 'toggle_reaction'].includes(event) &&
        args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      args[0] = { ...args[0] };
      if (!Object.prototype.hasOwnProperty.call(args[0], 'serverCode')) args[0].serverCode = this.serverCode;
      if (!Object.prototype.hasOwnProperty.call(args[0], 'clientContextId')) {
        args[0].clientContextId = this.clientContextId;
      }
    } else if (event === 'delete_message' && (typeof args[0] === 'string' || args[0] === null)) {
      args[0] = { id: args[0], serverCode: this.serverCode, clientContextId: this.clientContextId };
    } else if (event === 'typing' && (typeof args[0] !== 'object' || args[0] === null)) {
      args[0] = { isTyping: args[0], serverCode: this.serverCode, clientContextId: this.clientContextId };
    }
    return this.handlers.get(event)(...args);
  }
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
    skip() { return this; },
    select() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
  };
}

function valuesMatch(value, expected) {
  if (expected === null) return value === null || value === undefined;
  if (expected instanceof RegExp) return expected.test(String(value || ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected) return expected.$in.some(candidate => valuesMatch(value, candidate));
    if ('$lt' in expected) return value < expected.$lt;
    if ('$gt' in expected) return value > expected.$gt;
    if ('$regex' in expected) return valuesMatch(value, expected.$regex);
    if ('$exists' in expected) return expected.$exists ? value !== undefined : value === undefined;
  }
  return value === expected;
}

function matchesQuery(row, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return Array.isArray(expected) && expected.some(clause => matchesQuery(row, clause));
    return valuesMatch(row[key], expected);
  });
}

function createMemoryModel(initialRows = []) {
  const clone = value => value && typeof value === 'object'
    ? (value instanceof Date ? new Date(value) :
      value instanceof RegExp ? new RegExp(value) :
      (Array.isArray(value) ? value.map(clone) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))))
    : value;
  const rows = initialRows.map(clone);

  function documentFor(row) {
    if (!row) return null;
    const document = clone(row);
    Object.defineProperties(document, {
      markModified: { value: () => {}, enumerable: false },
      save: {
        value: async () => {
          const index = rows.indexOf(row);
          if (index >= 0) Object.assign(row, clone(document));
          return document;
        },
        enumerable: false
      }
    });
    return document;
  }

  function result(value) {
    return queryResult(value);
  }

  return {
    rows,
    find(query = {}) { return result(rows.filter(row => matchesQuery(row, query)).map(documentFor)); },
    findOne(query = {}) { return result(documentFor(rows.find(row => matchesQuery(row, query)))); },
    findById(id) { return result(documentFor(rows.find(row => String(row._id) === String(id)))); },
    async create(value) {
      const row = clone(value);
      rows.push(row);
      return documentFor(row);
    },
    async findOneAndUpdate(query, update, options = {}) {
      let row = rows.find(candidate => matchesQuery(candidate, query));
      if (!row && options.upsert) {
        row = { ...query };
        rows.push(row);
      }
      if (!row) return null;
      if (update.$set) Object.assign(row, clone(update.$set));
      else if (!Object.keys(update).some(key => key.startsWith('$'))) Object.assign(row, clone(update));
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
      return documentFor(row);
    },
    async updateOne(query, update) {
      const row = rows.find(candidate => matchesQuery(candidate, query));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(row, update.$set);
      else if (!Object.keys(update).some(key => key.startsWith('$'))) Object.assign(row, update);
      for (const [key, value] of Object.entries(update.$pull || {})) {
        row[key] = (Array.isArray(row[key]) ? row[key] : [])
          .filter(candidate => candidate !== value);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async countDocuments(query = {}) { return rows.filter(row => matchesQuery(row, query)).length; }
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

module.exports = { FakeSocket, FakeIo, queryResult, acknowledge, deferred, createMemoryModel };
