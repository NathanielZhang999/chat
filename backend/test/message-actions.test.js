const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutoModTracker, createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, acknowledge, deferred } = require('./support/fakes');

function registerMessages(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  createConnectionHandler({
    ioInstance,
    UserModel: {
      async findOne() {
        return { username: 'alice', role: 'user', servers: ['global', 'ABC123', 'BBB222'] };
      }
    },
    ChatServerModel: { async findOne(query) { return { code: query.code }; } },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    autoModTracker: createAutoModTracker(),
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

test('editing emits only to the active stored message room', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
    role: 'user', roomRole: 'user', text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const MessageModel = { findById: async () => message };
  const { socket, ioInstance } = registerMessages({ MessageModel });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
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

test('chat message is rejected when its active room changes while mention resolution is pending', async () => {
  const resolverStarted = deferred();
  const resolver = deferred();
  let created;
  const { socket, ioInstance } = registerMessages({
    resolvePingsFn: async () => {
      resolverStarted.resolve();
      return resolver.promise;
    },
    MessageModel: {
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123', 'BBB222'] });

  const pending = socket.trigger('chat_message', { text: '@Bob hello' });
  await resolverStarted.promise;
  socket.serverCode = 'BBB222';
  resolver.resolve('hello');
  await pending;

  assert.equal(created, undefined);
  assert.deepEqual(ioInstance.outbound, []);
});

test('chat message emits to its stored room when persistence is pending', async () => {
  const createStarted = deferred();
  const releaseCreate = deferred();
  let created;
  const { socket, ioInstance } = registerMessages({
    MessageModel: {
      async create(value) {
        created = value;
        createStarted.resolve();
        await releaseCreate.promise;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123', 'BBB222'] });

  const pending = socket.trigger('chat_message', { text: 'hello' });
  await createStarted.promise;
  socket.serverCode = 'BBB222';
  releaseCreate.resolve();
  await pending;

  assert.equal(created.serverCode, 'ABC123');
  assert.equal(ioInstance.outbound.at(-1).room, 'ABC123');
});

test('chat message rechecks membership immediately before persistence', async () => {
  const resolverStarted = deferred();
  const resolver = deferred();
  let created = 0;
  const user = { username: 'alice', role: 'user', servers: ['global', 'ABC123'] };
  const { socket, ioInstance } = registerMessages({
    UserModel: { async findOne() { return user; } },
    resolvePingsFn: async () => {
      resolverStarted.resolve();
      return resolver.promise;
    },
    MessageModel: { async create() { created += 1; } }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  const pending = socket.trigger('chat_message', { text: '@Bob hello' });
  await resolverStarted.promise;
  user.servers = ['global'];
  socket.joinedServers = ['global'];
  resolver.resolve('hello');
  await pending;

  assert.equal(created, 0);
  assert.deepEqual(ioInstance.outbound, []);
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
  assert.equal(resolverInput, '{{ PING:everyone|everyone}}');
});

test('client-supplied ping tokens cannot be re-promoted by mention resolution during creation', async () => {
  let created;
  const { socket } = registerMessages({
    resolvePingsFn: async text => text.replace('@everyone', '{{PING:everyone|everyone}}'),
    MessageModel: {
      async create(value) {
        created = value;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket);

  await socket.trigger('chat_message', { text: '{{PING:everyone|everyone}}' });

  assert.ok(created);
  assert.equal(/\{\{PING:/i.test(created.text), false);
});

test('chat messages neutralize brace-bearing ping sentinels before mention resolution', async () => {
  let resolverInput;
  const { socket } = registerMessages({
    resolvePingsFn: async text => { resolverInput = text; return text; },
    MessageModel: {
      async create(value) { return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() }; }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: '{{PING:alice|A{lice}}}' });
  assert.equal(/\{\{PING:/i.test(resolverInput), false);
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

test('room history strips unsafe legacy attachments before acknowledgement', async () => {
  const history = [
    { _id: '507f1f77bcf86cd799439011', serverCode: 'global', attachment: 'javascript:alert(1)' },
    { _id: '507f191e810c19729de860ea', serverCode: 'global', attachment: 'data:image/png;base64,AAAA' }
  ];
  const { socket } = registerMessages({
    MessageModel: {
      find() {
        return {
          sort() { return this; },
          limit() { return this; },
          async lean() { return history; }
        };
      }
    }
  });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('switch_server', 'global', ack.callback);
  assert.equal(ack.value().history[0].attachment, 'data:image/png;base64,AAAA');
  assert.equal(ack.value().history[1].attachment, null);
});

test('deleted-message reads strip unsafe legacy attachments', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'deleted', attachment: 'data:text/html;base64,PHNjcmlwdD4=', deleted: true
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  const ack = acknowledge();
  await socket.trigger('get_deleted_message', message._id, ack.callback);
  assert.deepEqual(ack.value(), { success: true, text: 'deleted', attachment: null });
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

test('stale cached admin and moderator roles cannot delete another user message', async () => {
  for (const staleRole of ['admin', 'mod']) {
    let saved = false;
    const message = {
      _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'bob',
      role: 'user', roomRole: 'user', text: 'protected', history: [], deleted: false,
      markModified() {}, async save() { saved = true; }
    };
    const { socket, ioInstance } = registerMessages({
      MessageModel: { findById: async () => message },
      getRoomRoleFn: async () => staleRole === 'mod' ? 'mod' : 'user'
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    socket.role = staleRole === 'admin' ? 'admin' : 'user';

    await socket.trigger('delete_message', message._id);

    assert.equal(saved, false, staleRole);
    assert.equal(message.deleted, false, staleRole);
    assert.deepEqual(ioInstance.outbound, [], staleRole);
  }
});

test('a persisted room ban blocks an administrator from deleting another user message', async () => {
  let saved = false;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'bob',
    role: 'user', roomRole: 'user', text: 'protected', history: [], deleted: false,
    markModified() {}, async save() { saved = true; }
  };
  const { socket, ioInstance } = registerMessages({
    MessageModel: { findById: async () => message },
    UserModel: {
      async findOne() {
        return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] };
      }
    },
    RoomRestrictionModel: {
      async findOne() { return { bannedAt: new Date(), timeoutUntil: null }; },
      async find() { return []; }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.role = 'admin';

  await socket.trigger('delete_message', message._id);

  assert.equal(saved, false);
  assert.equal(message.deleted, false);
  assert.deepEqual(ioInstance.outbound, []);
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

test('editing neutralizes client ping tokens before resolving mentions', async () => {
  let resolverInput;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async text => { resolverInput = text; return text; }
  });
  authenticate(socket);
  await socket.trigger('edit_message', { id: message._id, text: '{{PING:everyone|everyone}}' });
  assert.equal(resolverInput, '{{ PING:everyone|everyone}}');
});

test('client-supplied ping tokens cannot be re-promoted by mention resolution during editing', async () => {
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async text => text.replace('@everyone', '{{PING:everyone|everyone}}')
  });
  authenticate(socket);

  await socket.trigger('edit_message', { id: message._id, text: '{{PING:everyone|everyone}}' });

  assert.equal(/\{\{PING:/i.test(message.text), false);
});

test('editing neutralizes nested ping sentinels before mention resolution', async () => {
  let resolverInput;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async text => { resolverInput = text; return text; }
  });
  authenticate(socket);
  await socket.trigger('edit_message', {
    id: message._id,
    text: '{{PING:alice|{{PING:bob|Bob}}}}'
  });
  assert.equal(/\{\{PING:/i.test(resolverInput), false);
});

test('chat messages do not persist or emit text expanded beyond two thousand characters', async () => {
  let created = 0;
  const { socket, ioInstance } = registerMessages({
    resolvePingsFn: async () => 'x'.repeat(2001),
    MessageModel: {
      async create(value) {
        created += 1;
        return { ...value, _id: '507f191e810c19729de860ea', timestamp: new Date() };
      }
    }
  });
  authenticate(socket);
  await socket.trigger('chat_message', { text: 'short input' });
  assert.equal(created, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('edits do not persist or emit text expanded beyond two thousand characters', async () => {
  let saved = 0;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    text: 'before', history: [], deleted: false,
    markModified() {}, async save() { saved += 1; }
  };
  const { socket, ioInstance } = registerMessages({
    MessageModel: { findById: async () => message },
    resolvePingsFn: async () => 'x'.repeat(2001)
  });
  authenticate(socket);
  await socket.trigger('edit_message', { id: message._id, text: 'short input' });
  assert.equal(saved, 0);
  assert.equal(message.text, 'before');
  assert.deepEqual(message.history, []);
  assert.deepEqual(ioInstance.outbound, []);
});

test('Blocked edit leaves the saved message and history unchanged without leaking raw text', async () => {
  const blockedText = 'Never Persist ＦＯＲＢＩＤＤＥＮ Edit';
  let saved = 0;
  const audits = [];
  const logged = [];
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', username: 'alice',
    role: 'user', roomRole: 'user', text: 'before', history: [], deleted: false,
    markModified() {}, async save() { saved += 1; }
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel: {
      async findOne() {
        return {
          code: 'global', moderators: [],
          autoMod: {
            blockedKeywords: ['forbidden'], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30
          }
        };
      }
    },
    MessageModel: { async findById() { return message; } },
    ModerationAuditModel: { async create(value) { audits.push(value); return value; } },
    logger: { error(...args) { logged.push(args); } }
  });
  authenticate(socket);

  await socket.trigger('edit_message', { id: message._id, text: blockedText });

  assert.equal(saved, 0);
  assert.equal(message.text, 'before');
  assert.deepEqual(message.history, []);
  assert.deepEqual(ioInstance.outbound, []);
  assert.deepEqual(socket.outbound, [{
    target: 'self', event: 'message_blocked',
    payload: { rule: 'content_policy', serverCode: 'global', clientContextId: 1 }
  }]);
  assert.deepEqual(logged, []);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].metadata.rule, 'blocked_keyword');
  assert.match(audits[0].metadata.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(audits).includes(blockedText), false);
  assert.equal(JSON.stringify(audits).includes('Never Persist'), false);
});

test('reaction handlers reject non-pictographic permitted sequence characters before lookup', async () => {
  let lookups = 0;
  let saved = 0;
  const { socket, ioInstance } = registerMessages({
    MessageModel: {
      async findById() {
        lookups += 1;
        return { serverCode: 'global', reactions: {}, markModified() {}, async save() { saved += 1; } };
      }
    }
  });
  authenticate(socket);
  for (const emoji of ['\uFE0F', '\u200D', '🏻']) {
    await socket.trigger('toggle_reaction', { id: '507f1f77bcf86cd799439011', emoji });
  }
  assert.equal(lookups, 0);
  assert.equal(saved, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('reaction key cardinality allows the twentieth key and rejects the twenty-first', async () => {
  const reactions = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`😀${'️'.repeat(index)}`, ['bob']]));
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false, reactions,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(Object.keys(message.reactions).length, 20);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '🔥' });
  assert.equal(Object.keys(message.reactions).length, 20);
  assert.equal(message.reactions['🔥'], undefined);
});

test('reaction user cardinality allows the two-hundredth user and rejects the next', async () => {
  const users = Array.from({ length: 199 }, (_, index) => `user-${index}`);
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false,
    reactions: { '👍': users }, markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(message.reactions['👍'].length, 200);
  socket.username = 'charlie';
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(message.reactions['👍'].length, 200);
  assert.equal(message.reactions['👍'].includes('charlie'), false);
});

test('per-user reaction cardinality allows twenty distinct reactions and rejects the next', async () => {
  const reactions = Object.fromEntries(Array.from({ length: 19 }, (_, index) => [`😀${'️'.repeat(index)}`, ['alice']]));
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false, reactions,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(Object.values(message.reactions).filter(users => users.includes('alice')).length, 20);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '🔥' });
  assert.equal(message.reactions['🔥'], undefined);
});

test('toggling an existing reaction off remains allowed at every cardinality limit', async () => {
  const reactions = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    index === 0 ? '👍' : `😀${'️'.repeat(index)}`,
    index === 0 ? ['alice', ...Array.from({ length: 199 }, (_, userIndex) => `user-${userIndex}`)] : ['alice']
  ]));
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'global', deleted: false, reactions,
    markModified() {}, async save() {}
  };
  const { socket } = registerMessages({ MessageModel: { async findById() { return message; } } });
  authenticate(socket);
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  assert.equal(message.reactions['👍'].includes('alice'), false);
  assert.equal(message.reactions['👍'].length, 199);
});

test('absent rooms cannot receive new messages or orphaned message mutations', async () => {
  let created = 0;
  let saved = 0;
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
    text: 'before', history: [], deleted: false, reactions: {},
    markModified() {}, async save() { saved += 1; }
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel: { async findOne() { return null; } },
    MessageModel: {
      async findById() { return message; },
      async create() { created += 1; }
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });

  await socket.trigger('chat_message', { text: 'orphan' });
  await socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  await socket.trigger('edit_message', { id: message._id, text: 'after' });
  await socket.trigger('delete_message', message._id);

  assert.equal(created, 0);
  assert.equal(saved, 0);
  assert.deepEqual(ioInstance.outbound, []);
});

test('room deletion cannot overtake an in-flight reaction persistence', async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  const state = { roomExists: true, savedAfterDeletion: false };
  const message = {
    _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', deleted: false, reactions: {},
    markModified() {},
    async save() {
      saveStarted.resolve();
      await releaseSave.promise;
      state.savedAfterDeletion = !state.roomExists;
    }
  };
  const ChatServerModel = {
    async findOne() {
      return state.roomExists ? { code: 'ABC123', owner: 'alice' } : null;
    },
    async deleteOne() { state.roomExists = false; }
  };
  const MessageModel = {
    async findById() { return message; },
    async deleteMany() {}
  };
  const { socket, ioInstance } = registerMessages({
    ChatServerModel,
    MessageModel,
    UserModel: {
      async findOne() { return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] }; },
      async updateMany() {}
    }
  });
  authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
  socket.role = 'admin';
  socket.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket];

  const reactionPending = socket.trigger('toggle_reaction', { id: message._id, emoji: '👍' });
  await saveStarted.promise;
  const deleteAck = acknowledge();
  const deletionPending = socket.trigger('delete_server', 'ABC123', deleteAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseSave.resolve();
  await Promise.all([reactionPending, deletionPending]);

  assert.equal(state.savedAfterDeletion, false);
  const reactionIndex = ioInstance.outbound.findIndex(item => item.event === 'reaction_updated');
  const deletionIndex = ioInstance.outbound.findIndex(item => item.event === 'server_deleted');
  assert.ok(reactionIndex >= 0);
  assert.ok(deletionIndex > reactionIndex);
});

for (const action of [
  {
    name: 'edit',
    event: 'edit_message',
    payload: { id: '507f1f77bcf86cd799439011', text: 'after' },
    emittedEvent: 'message_edited'
  },
  {
    name: 'message deletion',
    event: 'delete_message',
    payload: '507f1f77bcf86cd799439011',
    emittedEvent: 'message_deleted'
  }
]) {
  test(`room deletion cannot overtake an in-flight ${action.name} persistence`, async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const state = { roomExists: true, savedAfterDeletion: false };
    const message = {
      _id: '507f1f77bcf86cd799439011', serverCode: 'ABC123', username: 'alice',
      role: 'admin', roomRole: 'user', text: 'before', history: [], deleted: false,
      reactions: {}, markModified() {},
      async save() {
        saveStarted.resolve();
        await releaseSave.promise;
        state.savedAfterDeletion = !state.roomExists;
      }
    };
    const ChatServerModel = {
      async findOne() {
        return state.roomExists ? { code: 'ABC123', owner: 'alice' } : null;
      },
      async deleteOne() { state.roomExists = false; }
    };
    const MessageModel = {
      async findById() { return message; },
      async deleteMany() {}
    };
    const { socket, ioInstance } = registerMessages({
      ChatServerModel,
      MessageModel,
      UserModel: {
        async findOne() { return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] }; },
        async updateMany() {}
      },
      getRoomRoleFn: async () => 'user'
    });
    authenticate(socket, { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] });
    socket.role = 'admin';
    socket.joinedRooms.add('ABC123');
    ioInstance.sockets = [socket];

    const actionPending = socket.trigger(action.event, action.payload);
    await saveStarted.promise;
    const deleteAck = acknowledge();
    const deletionPending = socket.trigger('delete_server', 'ABC123', deleteAck.callback);
    await new Promise(resolve => setImmediate(resolve));
    releaseSave.resolve();
    await Promise.all([actionPending, deletionPending]);

    assert.equal(state.savedAfterDeletion, false);
    const actionIndex = ioInstance.outbound.findIndex(item => item.event === action.emittedEvent);
    const deletionIndex = ioInstance.outbound.findIndex(item => item.event === 'server_deleted');
    assert.ok(actionIndex >= 0);
    assert.ok(deletionIndex > actionIndex);
  });
}
