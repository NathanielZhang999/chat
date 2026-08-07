const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, acknowledge } = require('./support/fakes');

function registerMessages(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  createConnectionHandler({
    ioInstance,
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    ...overrides
  })(socket);
  return { socket, ioInstance };
}

function authenticate(socket, { serverCode = 'global', joinedServers = ['global'] } = {}) {
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.serverCode = serverCode;
  socket.joinedServers = joinedServers;
}

test('reaction in an inaccessible message room does not save or emit', async () => {
  let saved = false;
  const message = {
    serverCode: 'ABC123', deleted: false, reactions: {},
    markModified() {}, async save() { saved = true; }
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji: '👍' });
  assert.equal(saved, false);
  assert.deepEqual(ioInstance.outbound, []);
});

test('editing emits to the stored message room rather than current socket room', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
    role: 'user', roomRole: 'user', text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  authenticate(socket, { joinedServers: ['global', 'ABC123'] });
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  assert.equal(ioInstance.outbound.at(-1).room, 'ABC123');
  assert.equal(ioInstance.outbound.at(-1).event, 'message_edited');
});

test('message reply snapshot comes from the stored same-room message', async () => {
  let created;
  const referenced = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'bob',
    displayName: 'Bob', text: 'trusted stored text', deleted: false
  };
  const MessageModel = {
    findById: async () => referenced,
    async create(value) {
      created = value;
      return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
    }
  };
  const { socket } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  await socket.trigger('chat_message', {
    text: 'reply',
    replyTo: { id: referenced._id, displayname: '<img>', text: '<script>' }
  });
  assert.deepEqual(created.replyTo, {
    id: referenced._id,
    displayname: 'Bob',
    text: 'trusted stored text'
  });
});

test('chat messages reject malformed payloads without rejecting the handler or writing', async () => {
  let created = 0;
  const { socket } = registerMessages({
    MessageModel: { async create() { created += 1; } }
  });
  authenticate(socket);

  for (const payload of [null, undefined, 12, 'raw message', [], { text: null }, { text: 12 }]) {
    await assert.doesNotReject(socket.trigger('chat_message', payload));
  }
  assert.equal(created, 0);
});

test('chat messages reject invalid attachments without writing', async () => {
  let created = 0;
  const { socket } = registerMessages({
    MessageModel: { async create() { created += 1; } }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: 'hello', attachment: 'javascript:alert(1)' });
  assert.equal(created, 0);
});

test('chat messages neutralize client ping tokens before resolving mentions', async () => {
  let resolverInput;
  const { socket } = registerMessages({
    resolvePingsFn: async text => { resolverInput = text; return text; },
    MessageModel: {
      async create(value) { return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() }; }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: '{{PING:everyone|everyone}}' });
  assert.equal(resolverInput, '@everyone');
});

test('an invalid reply reference does not prevent creating a message with no reply snapshot', async () => {
  let created;
  const { socket } = registerMessages({
    MessageModel: {
      async findById() { return { serverCode: 'ABC123', deleted: true }; },
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', {
    text: 'still sends',
    replyTo: { id: '507f1f77bcf86cd799439011', displayname: 'forged', text: 'forged' }
  });
  assert.equal(created.replyTo, null);
});

test('invalid reaction values do not look up, save, or emit messages', async () => {
  let lookups = 0;
  let saved = 0;
  const { socket, ioInstance } = registerMessages({
    MessageModel: {
      async findById() {
        lookups += 1;
        return { reactions: {}, markModified() {}, async save() { saved += 1; } };
      }
    }
  });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji: '__proto__😀' });
  assert.equal(lookups, 0);
  assert.equal(saved, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('message-id actions reject malformed ids without rejecting their handlers', async () => {
  let lookups = 0;
  const { socket } = registerMessages({ MessageModel: { async findById() { lookups += 1; } } });
  authenticate(socket);
  const events = [
    ['toggle_reaction', [{ id: 'not-an-id', emoji: '👍' }]],
    ['edit_message', [{ id: 'not-an-id', text: 'after' }]],
    ['delete_message', ['not-an-id']],
    ['get_edit_history', ['not-an-id']],
    ['get_deleted_message', ['not-an-id']]
  ];
  for (const [event, args] of events) {
    await assert.doesNotReject(socket.trigger(event, ...args));
  }
  assert.equal(lookups, 0);
});

test('editing ignores null, undefined, and malformed data without rejecting', async () => {
  let lookups = 0;
  const { socket } = registerMessages({ MessageModel: { async findById() { lookups += 1; } } });
  authenticate(socket);
  for (const data of [null, undefined, [], {}, { id: '507f1f77bcf86cd799439011' }, { text: 'after' }]) {
    await assert.doesNotReject(socket.trigger('edit_message', data));
  }
  assert.equal(lookups, 0);
});

test('editing a message bounds an oversized legacy history to its newest twenty entries', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', deleted: false,
    history: Array.from({ length: 21 }, (_, index) => ({ text: `old-${index}` })),
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { findById: async () => message } });
  authenticate(socket);
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  assert.equal(message.history.length, 20);
  assert.equal(message.history[0].text, 'old-2');
  assert.equal(message.history.at(-1).text, 'before');
});

test('edit history reads return only the newest twenty legacy entries', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    history: Array.from({ length: 21 }, (_, index) => ({ text: `old-${index}` }))
  };
  const { socket } = registerMessages({ MessageModel: { findById: async () => message } });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('get_edit_history', message._id, ack.callback);
  assert.equal(ack.value().history.length, 20);
  assert.equal(ack.value().history[0].text, 'old-1');
  assert.equal(ack.value().history.at(-1).text, 'old-20');
});

test('a sender who left a room cannot edit, read, or delete its old messages', async () => {
  let roomRoleLookups = 0;
  const editable = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice', text: 'before', deleted: false,
    markModified() {}, async save() { throw new Error('must not save'); }
  };
  const deleted = {
    _id: '507f191e810c19729de860ea', serverCode: 'ABC123', username: 'alice', text: 'secret', attachment: null, deleted: true
  };
  const { socket } = registerMessages({
    MessageModel: {
      async findById(id) { return id === editable._id ? editable : deleted; }
    },
    getRoomRoleFn: async () => { roomRoleLookups += 1; return 'user'; }
  });
  authenticate(socket);
  const historyAck = acknowledge();
  const deletedAck = acknowledge();
  await assert.doesNotReject(socket.trigger('edit_message', { id: editable._id, text: 'after' }));
  await assert.doesNotReject(socket.trigger('delete_message', editable._id));
  await socket.trigger('get_edit_history', editable._id, historyAck.callback);
  await socket.trigger('get_deleted_message', deleted._id, deletedAck.callback);
  assert.deepEqual(historyAck.value(), { error: 'Permission denied.' });
  assert.deepEqual(deletedAck.value(), { error: 'Permission denied.' });
  assert.equal(roomRoleLookups, 0);
});

test('typing emits a complete payload only for accessible active rooms and boolean states', async () => {
  const { socket } = registerMessages();
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global'] });
  await socket.trigger('typing', true);
  await socket.trigger('typing', 'true');
  assert.deepEqual(socket.outbound, []);

  socket.joinedServers.push('ABC123');
  await socket.trigger('typing', 'true');
  await socket.trigger('typing', true);
  assert.deepEqual(socket.outbound, [{
    target: 'ABC123',
    event: 'typing',
    payload: { username: 'alice', displayName: 'Alice', isTyping: true }
  }]);
});
