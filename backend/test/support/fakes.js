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

function comparableValue(value) {
  return value instanceof Date ? value.getTime() : value;
}

function valuesMatch(value, expected) {
  if (expected === null) return value === null || value === undefined;
  if (expected instanceof RegExp) return expected.test(String(value || ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected) return expected.$in.some(candidate => valuesMatch(value, candidate));
    if ('$lt' in expected) return comparableValue(value) < comparableValue(expected.$lt);
    if ('$gt' in expected) return comparableValue(value) > comparableValue(expected.$gt);
    if ('$regex' in expected) return valuesMatch(value, expected.$regex);
  }
  if (value instanceof Date && expected instanceof Date) return value.getTime() === expected.getTime();
  return value === expected;
}

function matchesQuery(row, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$and') return Array.isArray(expected) && expected.every(clause => matchesQuery(row, clause));
    if (key === '$or') return Array.isArray(expected) && expected.some(clause => matchesQuery(row, clause));
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return Object.prototype.hasOwnProperty.call(row, key) === expected.$exists;
    }
    return valuesMatch(row[key], expected);
  });
}

function createMemoryModel(initialRows = []) {
  const rows = initialRows.map(row => ({ ...row }));

  function documentFor(row) {
    if (!row) return null;
    const document = { ...row };
    Object.defineProperties(document, {
      markModified: { value: () => {}, enumerable: false },
      save: {
        value: async () => {
          const index = rows.indexOf(row);
          if (index >= 0) Object.assign(row, document);
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

  function findResult(matchedRows) {
    let sortSpec = null;
    let maximum = null;
    let offset = 0;

    function materialize() {
      let values = [...matchedRows];
      if (sortSpec) {
        values.sort((left, right) => {
          for (const [key, direction] of Object.entries(sortSpec)) {
            const leftValue = comparableValue(left[key]);
            const rightValue = comparableValue(right[key]);
            if (leftValue === rightValue) continue;
            return (leftValue < rightValue ? -1 : 1) * direction;
          }
          return 0;
        });
      }
      if (offset > 0) values = values.slice(offset);
      if (maximum !== null) values = values.slice(0, maximum);
      return values.map(documentFor);
    }

    return {
      lean: async () => materialize(),
      sort(value) { sortSpec = value; return this; },
      limit(value) { maximum = value; return this; },
      skip(value) { offset = value; return this; },
      select() { return this; },
      then(resolve, reject) { return Promise.resolve(materialize()).then(resolve, reject); }
    };
  }

  return {
    rows,
    find(query = {}) { return findResult(rows.filter(row => matchesQuery(row, query))); },
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
