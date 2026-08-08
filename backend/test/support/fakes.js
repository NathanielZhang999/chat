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
  const rows = initialRows.map(row => ({ ...row }));

  function documentFor(row) {
    if (!row) return null;
    const document = { ...row };
    document.markModified = () => {};
    document.save = async () => {
      const index = rows.indexOf(row);
      if (index >= 0) Object.assign(row, document);
      return document;
    };
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
      const row = { ...value };
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
      Object.assign(row, update.$set || update);
      return documentFor(row);
    },
    async updateOne(query, update) {
      const row = rows.find(candidate => matchesQuery(candidate, query));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, update.$set || update);
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
