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
    const payloadEvents = new Set([
      'chat_message', 'edit_message', 'toggle_reaction', 'get_room_details', 'update_room_details',
      'list_pinned_messages', 'set_message_pin', 'get_blocked_message',
      'update_room_notification', 'mark_room_read'
    ]);
    if (payloadEvents.has(event) && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      args[0] = { ...args[0] };
      if (!Object.prototype.hasOwnProperty.call(args[0], 'serverCode')) args[0].serverCode = this.serverCode;
      if (!Object.prototype.hasOwnProperty.call(args[0], 'clientContextId')) args[0].clientContextId = this.clientContextId;
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
  to(room) { return { emit: (event, payload) => this.outbound.push({ target: room, event, payload }) }; }
  disconnect() { this.disconnected = true; }
}

class FakeIo {
  constructor(sockets = []) { this.outbound = []; this.sockets = sockets; }
  to(room) { return { emit: (event, payload) => this.outbound.push({ room, event, payload }) }; }
  emit(event, payload) { this.outbound.push({ room: '*', event, payload }); }
  async fetchSockets() { return this.sockets; }
}

function isSafePathSegment(segment) {
  return segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor';
}

function cloneValue(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  const cloned = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSafePathSegment(key)) Object.defineProperty(cloned, key, {
      value: cloneValue(child), enumerable: true, configurable: true, writable: true
    });
  }
  return cloned;
}

function pathValues(value, path) {
  const segments = Array.isArray(path) ? path : String(path).split('.');
  if (segments.some(segment => !isSafePathSegment(segment))) return [];
  function walk(current, index) {
    if (Array.isArray(current)) return current.flatMap(item => walk(item, index));
    if (index === segments.length) return [current];
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segments[index])) return [];
    return walk(current[segments[index]], index + 1);
  }
  return walk(value, 0);
}

function pathValue(value, path) {
  const segments = String(path).split('.');
  if (segments.some(segment => !isSafePathSegment(segment))) return undefined;
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(target, path, value) {
  const segments = String(path).split('.');
  if (segments.some(segment => !isSafePathSegment(segment))) return;
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = cloneValue(value);
}

function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

function valuesMatch(value, expected) {
  if (Array.isArray(value)) return value.some(item => valuesMatch(item, expected));
  if (expected === null) return value === null || value === undefined;
  if (expected instanceof RegExp) return expected.test(String(value || ''));
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const operators = Object.keys(expected).filter(key => key.startsWith('$'));
    if (operators.length > 0) {
      return operators.every(operator => {
        const operand = expected[operator];
        if (operator === '$exists') return Boolean(operand) === (value !== undefined);
        if (operator === '$ne') return !valuesMatch(value, operand);
        if (operator === '$in') return Array.isArray(operand) && operand.some(candidate => valuesMatch(value, candidate));
        if (operator === '$lt') return comparable(value) < comparable(operand);
        if (operator === '$lte') return comparable(value) <= comparable(operand);
        if (operator === '$gt') return comparable(value) > comparable(operand);
        if (operator === '$gte') return comparable(value) >= comparable(operand);
        if (operator === '$regex') return valuesMatch(value, operand);
        return false;
      });
    }
    if (!value || typeof value !== 'object') return false;
    return Object.entries(expected).every(([key, child]) =>
      isSafePathSegment(key) && valuesMatch(value[key], child));
  }
  return value === expected;
}

function matchesQuery(row, query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return false;
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return Array.isArray(expected) && expected.some(clause => matchesQuery(row, clause));
    if (key === '$and') return Array.isArray(expected) && expected.every(clause => matchesQuery(row, clause));
    if (!isSafePathSegment(key.split('.')[0])) return false;
    const values = pathValues(row, key);
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$exists' in expected) {
      const rest = { ...expected };
      delete rest.$exists;
      const exists = values.length > 0;
      return Boolean(expected.$exists) === exists && (Object.keys(rest).length === 0 || values.some(value => valuesMatch(value, rest)));
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$ne' in expected) {
      if (values.length === 0) return true;
      const rest = { ...expected };
      delete rest.$ne;
      const noneEqual = values.every(value => !valuesMatch(value, expected.$ne));
      return noneEqual && (Object.keys(rest).length === 0 || values.some(value => valuesMatch(value, rest)));
    }
    return values.some(value => valuesMatch(value, expected));
  });
}

function projectValue(value, projection) {
  if (!projection) return value;
  const names = typeof projection === 'string' ? projection.split(/\s+/).filter(Boolean) : Object.keys(projection).filter(key => projection[key]);
  if (names.length === 0) return value;
  if (Array.isArray(value)) return value.map(item => projectValue(item, projection));
  if (!value || typeof value !== 'object') return value;
  const projected = {};
  for (const name of names) {
    const values = pathValues(value, name);
    if (values.length) setPath(projected, name, values[0]);
  }
  if (Object.prototype.hasOwnProperty.call(value, '_id') && !names.includes('-_id')) projected._id = cloneValue(value._id);
  return projected;
}

function queryResult(value) {
  let current = value;
  let projection = null;
  const query = {
    session(session) { query.sessionValue = session; return query; },
    lean: async () => cloneValue(projectValue(current, projection)),
    sort(spec = {}) {
      if (Array.isArray(current)) {
        const entries = Object.entries(spec);
        current = [...current].sort((left, right) => {
          for (const [path, direction] of entries) {
            const a = pathValues(left, path)[0];
            const b = pathValues(right, path)[0];
            if (comparable(a) === comparable(b)) continue;
            if (a === undefined) return -1 * Math.sign(direction || 1);
            if (b === undefined) return Math.sign(direction || 1);
            return (comparable(a) < comparable(b) ? -1 : 1) * Math.sign(direction || 1);
          }
          return 0;
        });
      }
      return query;
    },
    limit(count) { if (Array.isArray(current)) current = current.slice(0, count); return query; },
    skip(count) { if (Array.isArray(current)) current = current.slice(count); return query; },
    select(nextProjection) { projection = nextProjection; return query; },
    then(resolve, reject) { return Promise.resolve(projectValue(current, projection)).then(resolve, reject); }
  };
  return query;
}

function updateArray(row, path, transform) {
  const current = pathValue(row, path);
  setPath(row, path, transform(Array.isArray(current) ? current : []));
}

function applyUpdate(row, update = {}, { isInsert = false } = {}) {
  if (!update || typeof update !== 'object') return;
  const hasOperators = Object.keys(update).some(key => key.startsWith('$'));
  if (!hasOperators) {
    for (const [key, value] of Object.entries(update)) setPath(row, key, value);
    return;
  }
  if (isInsert) for (const [path, value] of Object.entries(update.$setOnInsert || {})) setPath(row, path, value);
  for (const [path, value] of Object.entries(update.$set || {})) setPath(row, path, value);
  for (const [path, value] of Object.entries(update.$inc || {})) {
    const current = pathValues(row, path)[0];
    setPath(row, path, (typeof current === 'number' ? current : 0) + value);
  }
  for (const [path, value] of Object.entries(update.$addToSet || {})) {
    const additions = value && typeof value === 'object' && Array.isArray(value.$each) ? value.$each : [value];
    updateArray(row, path, current => {
      const next = [...current];
      for (const addition of additions) if (!next.some(item => valuesMatch(item, addition) && valuesMatch(addition, item))) next.push(cloneValue(addition));
      return next;
    });
  }
  for (const [path, value] of Object.entries(update.$push || {})) {
    const additions = value && typeof value === 'object' && Array.isArray(value.$each) ? value.$each : [value];
    updateArray(row, path, current => {
      let next = [...current, ...additions.map(cloneValue)];
      if (value && typeof value === 'object' && Number.isInteger(value.$slice)) {
        next = value.$slice >= 0 ? next.slice(0, value.$slice) : next.slice(value.$slice);
      }
      return next;
    });
  }
  for (const [path, expected] of Object.entries(update.$pull || {})) {
    updateArray(row, path, current => current.filter(item => !valuesMatch(item, expected)));
  }
}

function querySeed(query) {
  const seed = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (key.startsWith('$') || (value && typeof value === 'object' && !Array.isArray(value))) continue;
    setPath(seed, key, value);
  }
  return seed;
}

function createMemoryModel(initialRows = []) {
  const rows = initialRows.map(cloneValue);
  const saveCalls = [];
  let nextId = rows.length + 1;
  let model;

  function documentFor(row) {
    if (!row) return null;
    const document = cloneValue(row);
    Object.defineProperties(document, {
      markModified: { value: () => {}, enumerable: false },
      save: {
        value: async options => {
          const call = { document, options: cloneValue(options) };
          saveCalls.push(call);
          if (typeof model.saveHook === 'function') await model.saveHook(call);
          const index = rows.indexOf(row);
          if (index >= 0) {
            for (const key of Object.keys(row)) delete row[key];
            Object.assign(row, cloneValue(document));
          }
          return document;
        }, enumerable: false
      }
    });
    return document;
  }

  function documentsFor(collection) { return collection.map(documentFor); }
  function updateResult(query, update, { multi = false, upsert = false, new: returnNew = true } = {}) {
    const matches = rows.filter(row => matchesQuery(row, query));
    if (matches.length === 0 && upsert) {
      const row = querySeed(query);
      if (row._id === undefined) row._id = String(nextId++).padStart(24, '0');
      applyUpdate(row, update, { isInsert: true });
      rows.push(row);
      if (multi) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: row._id };
      return returnNew ? documentFor(row) : null;
    }
    const selected = multi ? matches : matches.slice(0, 1);
    if (multi) {
      for (const row of selected) applyUpdate(row, update);
      return { matchedCount: selected.length, modifiedCount: selected.length };
    }
    const row = selected[0];
    if (!row) return null;
    const before = cloneValue(row);
    applyUpdate(row, update);
    return documentFor(returnNew ? row : before);
  }

  function updateCounts(query, update, { multi = false, upsert = false } = {}) {
    const matched = rows.filter(row => matchesQuery(row, query));
    if (matched.length === 0 && upsert) {
      const row = querySeed(query);
      if (row._id === undefined) row._id = String(nextId++).padStart(24, '0');
      applyUpdate(row, update, { isInsert: true });
      rows.push(row);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: row._id };
    }
    const selected = multi ? matched : matched.slice(0, 1);
    for (const row of selected) applyUpdate(row, update);
    return { matchedCount: selected.length, modifiedCount: selected.length };
  }

  model = {
    rows,
    saveCalls,
    saveHook: null,
    db: { transaction: async operation => operation({ id: 'memory-transaction' }) },
    find(query = {}) { return queryResult(documentsFor(rows.filter(row => matchesQuery(row, query)))); },
    findOne(query = {}) { return queryResult(documentFor(rows.find(row => matchesQuery(row, query)))); },
    findById(id) { return queryResult(documentFor(rows.find(row => String(row._id) === String(id)))); },
    create(value) {
      const row = cloneValue(value || {});
      if (row._id === undefined) row._id = String(nextId++).padStart(24, '0');
      rows.push(row);
      return Promise.resolve(documentFor(row));
    },
    findOneAndUpdate(query, update, options = {}) {
      return queryResult(updateResult(query, update, { upsert: Boolean(options.upsert), new: options.new !== false }));
    },
    updateOne(query, update, options = {}) {
      return queryResult(updateCounts(query, update, { upsert: Boolean(options.upsert) }));
    },
    updateMany(query, update) { return queryResult(updateCounts(query, update, { multi: true })); },
    deleteOne(query) {
      const index = rows.findIndex(row => matchesQuery(row, query));
      if (index < 0) return queryResult({ deletedCount: 0 });
      rows.splice(index, 1);
      return queryResult({ deletedCount: 1 });
    },
    deleteMany(query = {}) {
      let deletedCount = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matchesQuery(rows[index], query)) { rows.splice(index, 1); deletedCount += 1; }
      }
      return queryResult({ deletedCount });
    },
    countDocuments(query = {}) { return Promise.resolve(rows.filter(row => matchesQuery(row, query)).length); }
  };
  return model;
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
