const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler } = require('../server');
const { FakeSocket, FakeIo, createMemoryModel, acknowledge, deferred } = require('./support/fakes');

function objectId(index) {
  return Number(index).toString(16).padStart(24, '0');
}

function user(username, { role = 'user', servers = ['global', 'ABC123'] } = {}) {
  return { username, displayName: username, password: 'hash', role, servers };
}

function room(code, overrides = {}) {
  return {
    code,
    name: code === 'global' ? 'Global Chat' : code,
    owner: 'Owner',
    moderators: [],
    description: '',
    rules: '',
    metadataVersion: 0,
    pinnedMessages: [],
    pinVersion: 0,
    autoMod: {
      blockedKeywords: [], mentionLimit: 8, repeatLimit: 3, repeatWindowSeconds: 30,
      messageLimit: 5, messageWindowSeconds: 5
    },
    ...overrides
  };
}

function message(index, overrides = {}) {
  return {
    _id: objectId(index), serverCode: 'ABC123', username: 'Author', displayName: 'Author',
    authorKey: 'author', text: `message ${index}`, attachment: null, deleted: false,
    timestamp: new Date(1_700_000_000_000 + index), reactions: {},
    ...overrides
  };
}

function restriction(serverCode, username, overrides = {}) {
  return { serverCode, username: username.toLowerCase(), bannedAt: null, timeoutUntil: null, ...overrides };
}

function registerSocket(setup, id) {
  const socket = new FakeSocket();
  socket.id = id;
  createConnectionHandler({
    ioInstance: setup.ioInstance,
    UserModel: setup.UserModel,
    ChatServerModel: setup.ChatServerModel,
    MessageModel: setup.MessageModel,
    RoomRestrictionModel: setup.RoomRestrictionModel,
    ModerationAuditModel: setup.ModerationAuditModel,
    RoomMemberStateModel: setup.RoomMemberStateModel,
    UserExperienceStateModel: setup.UserExperienceStateModel,
    onlineUsersMap: setup.onlineUsersMap,
    bcryptImpl: { async compare() { return true; }, async hash(value) { return value; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    logger: setup.logger
  })(socket);
  setup.ioInstance.sockets.push(socket);
  return socket;
}

function authenticate(setup, {
  id, username, role = 'user', serverCode = 'ABC123',
  joinedServers = ['global', 'ABC123'], blockedUsers = [], blockVersion = 0
}) {
  const socket = registerSocket(setup, id);
  Object.assign(socket, {
    username, displayName: username, role, serverCode, joinedServers,
    blockedUserKeys: new Set(blockedUsers), blockVersion, bannedRooms: []
  });
  socket.joinedRooms.add(serverCode);
  setup.onlineUsersMap.set(id, {
    username, displayName: username, role, serverCode, joinedServers,
    blockedUsers: [...blockedUsers], blockVersion, bannedRooms: []
  });
  return socket;
}

function fixture(overrides = {}) {
  const setup = {
    ioInstance: new FakeIo(),
    onlineUsersMap: new Map(),
    logger: overrides.logger || { error() {} },
    UserModel: createMemoryModel(overrides.users || [
      user('Owner'), user('ExactMod'), user('OtherRoomMod', { servers: ['global', 'XYZ789'] }),
      user('Member'), user('Author'), user('Blocker'), user('TimedOutOwner'),
      user('Admin', { role: 'admin', servers: ['global'] }),
      user('BannedMember'), user('BannedAdmin', { role: 'admin', servers: ['global'] })
    ]),
    ChatServerModel: createMemoryModel(overrides.rooms || [
      room('global', { owner: 'System' }),
      room('ABC123', { moderators: ['ExactMod'] }),
      room('XYZ789', { moderators: ['OtherRoomMod'] })
    ]),
    MessageModel: createMemoryModel(overrides.messages || [message(1)]),
    RoomRestrictionModel: createMemoryModel(overrides.restrictions || [
      restriction('ABC123', 'TimedOutOwner', { timeoutUntil: new Date(Date.now() + 60_000) }),
      restriction('ABC123', 'BannedMember', { bannedAt: new Date() }),
      restriction('ABC123', 'BannedAdmin', { bannedAt: new Date() })
    ]),
    ModerationAuditModel: createMemoryModel([]),
    RoomMemberStateModel: createMemoryModel([]),
    UserExperienceStateModel: createMemoryModel(overrides.experienceStates || [])
  };
  return setup;
}

async function setPin(socket, messageId, pinned, serverCode = socket.serverCode, clientContextId = 1) {
  const ack = acknowledge();
  await socket.trigger('set_message_pin', { serverCode, messageId, pinned, clientContextId }, ack.callback);
  return ack.value();
}

async function listPins(socket, serverCode = socket.serverCode) {
  const ack = acknowledge();
  await socket.trigger('list_pinned_messages', { serverCode, clientContextId: 1 }, ack.callback);
  return ack.value();
}

async function deleteMessage(socket, messageId, serverCode = socket.serverCode) {
  const ack = acknowledge();
  await socket.trigger('delete_message', {
    id: messageId, serverCode, clientContextId: 1
  }, ack.callback);
  return ack.value();
}

function pinEvents(setup) {
  return setup.ioInstance.sockets.flatMap(live => live.outbound)
    .filter(item => item.event === 'message_pin_updated');
}

function gateSwitchHistory(setup) {
  const started = deferred();
  const release = deferred();
  const originalFind = setup.MessageModel.find.bind(setup.MessageModel);
  setup.MessageModel.find = query => {
    if (query && query.serverCode === 'XYZ789') {
      const gated = {
        sort() { return gated; },
        limit() { return gated; },
        async lean() {
          started.resolve();
          await release.promise;
          return [];
        }
      };
      return gated;
    }
    return originalFind(query);
  };
  return { started, release };
}

test('transactional pinned deletion marks deleted and pulls pin with one committed pinVersion', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  const session = { id: 'delete-transaction' };
  let transactionCalls = 0;
  let committed = false;
  const sharedConnection = {
    async transaction(operation) {
      transactionCalls += 1;
      const value = await operation(session);
      committed = true;
      return value;
    }
  };
  setup.MessageModel.db = sharedConnection;
  setup.ChatServerModel.db = sharedConnection;
  const roomUpdates = [];
  const updateRoom = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    roomUpdates.push({ query: structuredClone(query), update: structuredClone(update), options });
    return updateRoom(query, update, options);
  };
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const originalEmit = author.emit.bind(author);
  author.emit = (event, payload) => {
    if (event === 'message_deleted') assert.equal(committed, true);
    originalEmit(event, payload);
  };

  const result = await deleteMessage(author, objectId(1));

  assert.equal(transactionCalls, 1);
  assert.deepEqual(setup.MessageModel.saveCalls[0].options, { session });
  assert.equal(roomUpdates.length, 1);
  assert.equal(roomUpdates[0].options.session, session);
  assert.deepEqual(roomUpdates[0].update, {
    $pull: { pinnedMessages: { messageId: objectId(1) } }, $inc: { pinVersion: 1 }
  });
  assert.equal(setup.MessageModel.rows[0].deleted, true);
  assert.deepEqual(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinnedMessages, []);
  assert.equal(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinVersion, 8);
  assert.deepEqual(result, {
    success: true, messageId: objectId(1),
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 8, blockVersion: 0 }
  });
  assert.equal(pinEvents(setup).length, 1);
  assert.equal(author.outbound.filter(item => item.event === 'message_deleted').length, 1);
});

test('standalone Mongo unsupported transaction falls back to compensating pinned deletion once', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  let transactionCalls = 0;
  const standaloneConnection = {
    async transaction() {
      transactionCalls += 1;
      throw Object.assign(
        new Error('Transaction numbers are only allowed on a replica set member or mongos'),
        { name: 'MongoServerError', code: 20, codeName: 'IllegalOperation' }
      );
    }
  };
  setup.MessageModel.db = standaloneConnection;
  setup.ChatServerModel.db = standaloneConnection;
  const author = authenticate(setup, { id: 'standalone-author', username: 'Author' });

  const result = await deleteMessage(author, objectId(1));

  assert.equal(transactionCalls, 1);
  assert.equal(setup.MessageModel.rows[0].deleted, true);
  const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
  assert.deepEqual(storedRoom.pinnedMessages, []);
  assert.equal(storedRoom.pinVersion, 8);
  assert.deepEqual(result, {
    success: true, messageId: objectId(1),
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 8, blockVersion: 0 }
  });
});

test('unclassified transaction failures never replay pinned deletion through compensation', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  const sharedConnection = {
    async transaction() {
      throw Object.assign(new Error('transaction outcome is unknown'), {
        name: 'MongoServerError', code: 91, codeName: 'ShutdownInProgress'
      });
    }
  };
  setup.MessageModel.db = sharedConnection;
  setup.ChatServerModel.db = sharedConnection;
  const author = authenticate(setup, { id: 'uncertain-author', username: 'Author' });

  const result = await deleteMessage(author, objectId(1));

  assert.deepEqual(result, { error: 'Failed to delete message.' });
  assert.equal(setup.MessageModel.rows[0].deleted, false);
  const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
  assert.deepEqual(storedRoom.pinnedMessages, [priorPin]);
  assert.equal(storedRoom.pinVersion, 7);
});

test('fallback deletion pulls and versions the pin before saving the message', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  const order = [];
  const saveStarted = deferred();
  const releaseSave = deferred();
  setup.MessageModel.saveHook = async () => {
    order.push('message_save');
    saveStarted.resolve();
    await releaseSave.promise;
  };
  const updateRoom = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    if (update.$pull) order.push('pin_pull');
    return updateRoom(query, update, options);
  };
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  const pending = deleteMessage(author, objectId(1));
  await saveStarted.promise;
  const orderAtSave = [...order];
  const roomAtSave = structuredClone(setup.ChatServerModel.rows.find(row => row.code === 'ABC123'));
  releaseSave.resolve();
  const result = await pending;

  assert.deepEqual(orderAtSave, ['pin_pull', 'message_save']);
  assert.deepEqual(roomAtSave.pinnedMessages, []);
  assert.equal(roomAtSave.pinVersion, 8);
  assert.equal(result.success, true);
});

test('fallback delete failure restores the exact prior pin and advances pinVersion again', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  setup.MessageModel.saveHook = async () => { throw new Error('delete persistence failed'); };
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  const result = await deleteMessage(author, objectId(1));

  const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
  assert.deepEqual(storedRoom.pinnedMessages, [priorPin]);
  assert.equal(storedRoom.pinVersion, 9);
  assert.equal(setup.MessageModel.rows[0].deleted, false);
  assert.deepEqual(result, { error: 'Failed to delete message.' });
  assert.deepEqual(pinEvents(setup).map(item => item.payload), [{
    messageId: objectId(1), pinned: true,
    pin: { serverCode: 'ABC123', pinCount: 1, pinVersion: 9, blockVersion: 0 }
  }]);
  assert.equal(setup.ioInstance.outbound.some(item => item.event === 'message_deleted'), false);
});

test('restore retry success publishes only the final authoritative pin snapshot', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  setup.MessageModel.saveHook = async () => { throw new Error('delete persistence failed'); };
  const updateRoom = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  let restoreAttempts = 0;
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    if (update.$push) {
      restoreAttempts += 1;
      if (restoreAttempts === 1) return null;
    }
    return updateRoom(query, update, options);
  };
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  const result = await deleteMessage(author, objectId(1));

  assert.deepEqual(result, { error: 'Failed to delete message.' });
  assert.equal(restoreAttempts, 2);
  assert.deepEqual(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinnedMessages, [priorPin]);
  assert.equal(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinVersion, 9);
  assert.deepEqual(pinEvents(setup).map(item => ({
    pinned: item.payload.pinned, pinVersion: item.payload.pin.pinVersion
  })), [{ pinned: true, pinVersion: 9 }]);
});

test('exhausted restore leaves the message safely unpinned emits newer state and logs no content', async () => {
  const secret = 'DELETE_RESTORE_SECRET';
  const attachmentSentinel = 'REVTVE9SRVNFQ1JFVA';
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const logged = [];
  const setup = fixture({
    logger: { error(...args) { logged.push(args); } },
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })],
    messages: [message(1, {
      text: secret, attachment: `data:image/png;base64,${attachmentSentinel}==`
    })]
  });
  setup.MessageModel.saveHook = async () => { throw new Error(`${secret} delete persistence failed`); };
  const updateRoom = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  let restoreAttempts = 0;
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    if (update.$push) {
      restoreAttempts += 1;
      throw new Error(`${secret} restore failed`);
    }
    return updateRoom(query, update, options);
  };
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  const result = await deleteMessage(author, objectId(1));

  const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
  assert.deepEqual(result, { error: 'Failed to delete message.' });
  assert.equal(restoreAttempts, 2);
  assert.equal(setup.MessageModel.rows[0].deleted, false);
  assert.deepEqual(storedRoom.pinnedMessages, []);
  assert.equal(storedRoom.pinVersion, 8);
  assert.deepEqual(pinEvents(setup).map(item => item.payload), [{
    messageId: objectId(1), pinned: false,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 8, blockVersion: 0 }
  }]);
  const serialized = JSON.stringify({ logged, events: [setup.ioInstance.outbound, pinEvents(setup)] });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(attachmentSentinel), false);
});

test('conflicting same-id restore state is removed before publishing authoritative unpinned state', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const conflictingPin = { messageId: objectId(1), pinnedAt: new Date(20), pinnedBy: 'Owner' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  setup.MessageModel.saveHook = async () => {
    saveStarted.resolve();
    await releaseSave.promise;
    throw new Error('delete persistence failed');
  };
  const author = authenticate(setup, { id: 'author', username: 'Author' });

  const deletionPending = deleteMessage(author, objectId(1));
  await saveStarted.promise;
  const writerRoom = await setup.ChatServerModel.findOneAndUpdate(
    {
      code: 'ABC123', pinVersion: 8,
      'pinnedMessages.messageId': { $ne: objectId(1) }
    },
    { $push: { pinnedMessages: conflictingPin }, $inc: { pinVersion: 1 } },
    { new: true }
  );
  assert.equal(writerRoom.pinVersion, 9);
  assert.deepEqual(writerRoom.pinnedMessages, [conflictingPin]);
  releaseSave.resolve();
  const result = await deletionPending;

  const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
  assert.deepEqual(result, { error: 'Failed to delete message.' });
  assert.equal(setup.MessageModel.rows[0].deleted, false);
  assert.deepEqual(storedRoom.pinnedMessages, []);
  assert.equal(storedRoom.pinVersion, 10);
  assert.deepEqual(pinEvents(setup).map(item => item.payload), [{
    messageId: objectId(1), pinned: false,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 10, blockVersion: 0 }
  }]);
});

test('pin and delete races serialize under one room lock with no dangling live pin', async () => {
  const priorPin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [priorPin], pinVersion: 7
    })]
  });
  const saveStarted = deferred();
  const releaseSave = deferred();
  setup.MessageModel.saveHook = async () => {
    saveStarted.resolve();
    await releaseSave.promise;
  };
  const author = authenticate(setup, { id: 'author', username: 'Author' });
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  const deletionPending = author.trigger('delete_message', objectId(1));
  await saveStarted.promise;
  let pinSettled = false;
  const pinPending = setPin(mod, objectId(1), true).finally(() => { pinSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const pinSettledWhileDeleting = pinSettled;
  releaseSave.resolve();
  const [, pinResult] = await Promise.all([deletionPending, pinPending]);

  assert.equal(pinSettledWhileDeleting, false);
  assert.deepEqual(pinResult, { error: 'Permission denied.' });
  assert.equal(setup.MessageModel.rows[0].deleted, true);
  assert.deepEqual(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinnedMessages, []);
  assert.equal(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinVersion, 8);
});

test('private pin policy allows owner exact moderator and global admin only', async () => {
  const setup = fixture({ messages: [message(1), message(2), message(3)] });
  const owner = authenticate(setup, { id: 'owner', username: 'Owner' });
  const exactMod = authenticate(setup, { id: 'exact', username: 'ExactMod' });
  const admin = authenticate(setup, {
    id: 'admin', username: 'Admin', role: 'admin', joinedServers: ['global']
  });
  const member = authenticate(setup, { id: 'member', username: 'Member' });
  const otherMod = authenticate(setup, {
    id: 'other', username: 'OtherRoomMod', serverCode: 'XYZ789', joinedServers: ['global', 'XYZ789']
  });

  assert.equal((await setPin(owner, objectId(1), true)).success, true);
  assert.equal((await setPin(exactMod, objectId(2), true)).success, true);
  assert.equal((await setPin(admin, objectId(3), true, 'ABC123')).success, true);
  assert.deepEqual(await setPin(member, objectId(1), false), { error: 'Permission denied.' });
  assert.deepEqual(await setPin(otherMod, objectId(1), false, 'ABC123'), { error: 'Permission denied.' });
});

test('Global pins allow global admins only and timeouts deny every pin mutation', async () => {
  const globalMessage = message(10, { serverCode: 'global' });
  const setup = fixture({
    messages: [globalMessage, message(11)],
    restrictions: [restriction('global', 'Admin', { timeoutUntil: new Date(Date.now() + 60_000) })]
  });
  const admin = authenticate(setup, { id: 'admin', username: 'Admin', role: 'admin', serverCode: 'global' });
  const owner = authenticate(setup, { id: 'owner', username: 'Owner', serverCode: 'global' });
  const timedOwner = authenticate(setup, { id: 'timeout', username: 'TimedOutOwner' });

  assert.deepEqual(await setPin(admin, globalMessage._id, true, 'global'), { error: 'Permission denied.' });
  setup.RoomRestrictionModel.rows.length = 0;
  assert.equal((await setPin(admin, globalMessage._id, true, 'global')).success, true);
  assert.deepEqual(await setPin(owner, globalMessage._id, false, 'global'), { error: 'Permission denied.' });
  setup.RoomRestrictionModel.rows.push(restriction('ABC123', 'TimedOutOwner', {
    timeoutUntil: new Date(Date.now() + 60_000)
  }));
  assert.deepEqual(await setPin(timedOwner, objectId(11), true), { error: 'Permission denied.' });
});

test('pins require a live exact-room message and enforce a hard limit of twenty', async () => {
  const existingPins = Array.from({ length: 19 }, (_, index) => ({
    messageId: objectId(index + 1), pinnedAt: new Date(index + 1), pinnedBy: 'ExactMod'
  }));
  const messages = Array.from({ length: 21 }, (_, index) => message(index + 1));
  const wrongRoom = message(50, { serverCode: 'XYZ789', text: 'wrong-room secret' });
  const deleted = message(51, { deleted: true });
  const setup = fixture({
    rooms: [room('global', { owner: 'System' }), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: existingPins, pinVersion: 19
    }), room('XYZ789')],
    messages: [...messages, wrongRoom, deleted]
  });
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  const twentieth = await setPin(mod, objectId(20), true);
  assert.deepEqual(twentieth.pin, { serverCode: 'ABC123', pinCount: 20, pinVersion: 20, blockVersion: 0 });
  assert.deepEqual(await setPin(mod, objectId(21), true), { error: 'Pin limit reached.' });
  const before = structuredClone(setup.ChatServerModel.rows.find(row => row.code === 'ABC123'));
  const auditCount = setup.ModerationAuditModel.rows.length;
  const eventCount = setup.ioInstance.sockets.flatMap(live => live.outbound)
    .filter(item => item.event === 'message_pin_updated').length;
  assert.deepEqual(await setPin(mod, wrongRoom._id, true), { error: 'Permission denied.' });
  assert.deepEqual(await setPin(mod, deleted._id, true), { error: 'Permission denied.' });
  assert.deepEqual(setup.ChatServerModel.rows.find(row => row.code === 'ABC123'), before);
  assert.equal(setup.ModerationAuditModel.rows.length, auditCount);
  assert.equal(setup.ioInstance.sockets.flatMap(live => live.outbound)
    .filter(item => item.event === 'message_pin_updated').length, eventCount);
});

test('duplicate pin and unpin requests are idempotent without version churn', async () => {
  const setup = fixture();
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  const firstPin = await setPin(mod, objectId(1), true);
  const duplicatePin = await setPin(mod, objectId(1), true);
  assert.deepEqual(duplicatePin.pin, firstPin.pin);
  const firstUnpin = await setPin(mod, objectId(1), false);
  const duplicateUnpin = await setPin(mod, objectId(1), false);
  assert.deepEqual(duplicateUnpin.pin, firstUnpin.pin);
  assert.equal(firstPin.pin.pinVersion, 1);
  assert.equal(firstUnpin.pin.pinVersion, 2);
  assert.equal(setup.ModerationAuditModel.rows.length, 2);
});

test('pin array and pinVersion change in the same compare-and-set room update', async () => {
  const setup = fixture({ messages: [message(1), message(2)] });
  const calls = [];
  const original = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  let loseFirstRace = true;
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    calls.push({ query: structuredClone(query), update: structuredClone(update) });
    if (loseFirstRace) {
      loseFirstRace = false;
      const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
      storedRoom.pinnedMessages.push({
        messageId: objectId(2), pinnedAt: new Date(2), pinnedBy: 'Owner'
      });
      storedRoom.pinVersion = 1;
      return null;
    }
    return original(query, update, options);
  };
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  const result = await setPin(mod, objectId(1), true);
  assert.equal(result.success, true);
  assert.equal(result.pin.pinVersion, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].query.$or, [{ pinVersion: 0 }, { pinVersion: { $exists: false } }]);
  assert.equal(calls[1].query.pinVersion, 1);
  assert.equal(Object.hasOwn(calls[1].query, '$or'), false);
  assert.deepEqual(calls.map(call => call.update.$inc), [{ pinVersion: 1 }, { pinVersion: 1 }]);
  assert.deepEqual(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinnedMessages
    .map(pin => String(pin.messageId)), [objectId(2), objectId(1)]);
  assert.equal(setup.ModerationAuditModel.rows.length, 1);
  assert.equal(mod.outbound.filter(item => item.event === 'message_pin_updated').length, 1);
});

test('pin compare-and-set loss is idempotent when the winner applied the desired state', async () => {
  const setup = fixture();
  const original = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  let attempts = 0;
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    attempts += 1;
    if (attempts === 1) {
      const storedRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
      storedRoom.pinnedMessages.push({
        messageId: objectId(1), pinnedAt: new Date(1), pinnedBy: 'Owner'
      });
      storedRoom.pinVersion = 1;
      return null;
    }
    return original(query, update, options);
  };
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  const result = await setPin(mod, objectId(1), true);

  assert.deepEqual(result.pin, {
    serverCode: 'ABC123', pinCount: 1, pinVersion: 1, blockVersion: 0
  });
  assert.equal(attempts, 1);
  assert.equal(setup.ModerationAuditModel.rows.length, 0);
  assert.equal(mod.outbound.some(item => item.event === 'message_pin_updated'), false);
});

test('queued pin list cannot read the old room after a switch wins the account lock', async () => {
  const pin = { messageId: objectId(1), pinnedAt: new Date(1), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', {
      moderators: ['ExactMod'], pinnedMessages: [pin], pinVersion: 1
    }), room('XYZ789')]
  });
  setup.UserModel.rows.find(row => row.username === 'ExactMod').servers.push('XYZ789');
  const mod = authenticate(setup, {
    id: 'mod', username: 'ExactMod', joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const gate = gateSwitchHistory(setup);
  const switchAck = acknowledge();
  const switchPending = mod.trigger('switch_server', 'XYZ789', switchAck.callback);
  await gate.started.promise;
  const listPending = listPins(mod, 'ABC123');
  gate.release.resolve();

  const [, listResult] = await Promise.all([switchPending, listPending]);

  assert.equal(switchAck.value().serverCode, 'XYZ789');
  assert.deepEqual(listResult, { error: 'Permission denied.' });
});

test('queued pin mutation cannot change the old room after a switch wins the account lock', async () => {
  const setup = fixture();
  setup.UserModel.rows.find(row => row.username === 'ExactMod').servers.push('XYZ789');
  const mod = authenticate(setup, {
    id: 'mod', username: 'ExactMod', joinedServers: ['global', 'ABC123', 'XYZ789']
  });
  const gate = gateSwitchHistory(setup);
  const switchAck = acknowledge();
  const switchPending = mod.trigger('switch_server', 'XYZ789', switchAck.callback);
  await gate.started.promise;
  const mutationPending = setPin(mod, objectId(1), true, 'ABC123');
  gate.release.resolve();

  const [, mutationResult] = await Promise.all([switchPending, mutationPending]);

  assert.equal(switchAck.value().serverCode, 'XYZ789');
  assert.deepEqual(mutationResult, { error: 'Permission denied.' });
  const oldRoom = setup.ChatServerModel.rows.find(row => row.code === 'ABC123');
  assert.deepEqual(oldRoom.pinnedMessages, []);
  assert.equal(oldRoom.pinVersion, 0);
  assert.deepEqual(setup.ModerationAuditModel.rows, []);
  assert.equal(setup.ioInstance.sockets.flatMap(live => live.outbound)
    .some(item => item.event === 'message_pin_updated'), false);
});

test('legacy missing pinVersion compares as zero and first pin mutation persists one', async () => {
  const setup = fixture();
  delete setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinVersion;
  const queries = [];
  const original = setup.ChatServerModel.findOneAndUpdate.bind(setup.ChatServerModel);
  setup.ChatServerModel.findOneAndUpdate = (query, update, options) => {
    queries.push(structuredClone(query));
    return original(query, update, options);
  };
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  const result = await setPin(mod, objectId(1), true);
  assert.equal(result.pin.pinVersion, 1);
  assert.deepEqual(queries[0].$or, [{ pinVersion: 0 }, { pinVersion: { $exists: false } }]);
  assert.equal(setup.ChatServerModel.rows.find(row => row.code === 'ABC123').pinVersion, 1);
});

test('pin lists reload current edited message content and omit deleted or missing targets', async () => {
  const pins = [1, 2, 3].map(index => ({
    messageId: objectId(index), pinnedAt: new Date(10 + index), pinnedBy: 'ExactMod'
  }));
  const attachment = 'data:image/png;base64,AA==';
  const setup = fixture({
    rooms: [room('global'), room('ABC123', { moderators: ['ExactMod'], pinnedMessages: pins, pinVersion: 7 })],
    messages: [
      message(1, { text: 'before edit', attachment }),
      message(2, { deleted: true, text: 'deleted secret' })
    ]
  });
  const member = authenticate(setup, { id: 'member', username: 'Member' });

  const first = await listPins(member);
  assert.deepEqual(first, {
    success: true, serverCode: 'ABC123',
    pins: [{
      messageId: objectId(1), authorKey: 'author', username: 'Author', displayName: 'Author',
      text: 'before edit', attachmentSummary: 'Image Attachment',
      messageTimestamp: setup.MessageModel.rows[0].timestamp,
      pinnedAt: pins[0].pinnedAt, pinnedBy: 'ExactMod'
    }],
    pinCount: 1, pinVersion: 7, blockVersion: 0
  });
  setup.MessageModel.rows[0].text = 'after edit';
  const second = await listPins(member);
  assert.equal(second.pins[0].text, 'after edit');
  assert.equal(second.pinVersion, 7);
  assert.deepEqual(Object.keys(second.pins[0]).sort(), [
    'attachmentSummary', 'authorKey', 'displayName', 'messageId', 'messageTimestamp',
    'pinnedAt', 'pinnedBy', 'text', 'username'
  ]);
  assert.equal(JSON.stringify(second).includes('data:image'), false);
});

test('pin summaries and counts omit authors blocked by each recipient not the pinning moderator', async () => {
  const pin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', { moderators: ['ExactMod'], pinnedMessages: [pin], pinVersion: 4 })],
    experienceStates: [{
      usernameKey: 'blocker',
      blockedUsers: [{ usernameKey: 'author', username: 'Author', createdAt: new Date() }],
      blockVersion: 9
    }]
  });
  const blocker = authenticate(setup, {
    id: 'blocker', username: 'Blocker', blockedUsers: ['author'], blockVersion: 9
  });
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  assert.equal((await listPins(blocker)).pinCount, 0);
  assert.equal((await listPins(mod)).pinCount, 1);
  const loginSocket = registerSocket(setup, 'blocker-login');
  const loginAck = acknowledge();
  await loginSocket.trigger('login', { username: 'Blocker', password: '123456' }, loginAck.callback);
  assert.deepEqual(loginAck.value().servers.find(summary => summary.code === 'ABC123').pin, {
    serverCode: 'ABC123', pinCount: 0, pinVersion: 4, blockVersion: 9
  });
  const switchAck = acknowledge();
  await blocker.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(switchAck.value().pin, {
    serverCode: 'ABC123', pinCount: 0, pinVersion: 4, blockVersion: 9
  });
  assert.equal(Object.hasOwn(switchAck.value(), 'pins'), false);
});

test('recipient pin counts change after block without changing room pinVersion', async () => {
  const pin = { messageId: objectId(1), pinnedAt: new Date(10), pinnedBy: 'ExactMod' };
  const setup = fixture({
    rooms: [room('global'), room('ABC123', { pinnedMessages: [pin], pinVersion: 11 }), room('XYZ789')]
  });
  const blocker = authenticate(setup, { id: 'blocker', username: 'Blocker' });
  const before = setup.ChatServerModel.rows.find(candidate => candidate.code === 'ABC123').pinVersion;
  const ack = acknowledge();

  await blocker.trigger('set_user_block', { username: 'Author', blocked: true }, ack.callback);

  assert.equal(ack.value().success, true);
  assert.equal(setup.ChatServerModel.rows.find(candidate => candidate.code === 'ABC123').pinVersion, before);
  const refresh = blocker.outbound.filter(item => item.event === 'message_pin_updated')
    .find(item => item.payload.pin?.serverCode === 'ABC123');
  assert.deepEqual(refresh.payload.pin, {
    serverCode: 'ABC123', pinCount: 0, pinVersion: 11, blockVersion: 1
  });
});

test('pin events are fresh-access checked recipient-aware and monotonically versioned', async () => {
  const setup = fixture();
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });
  const memberOtherSession = authenticate(setup, {
    id: 'member-other', username: 'Member', serverCode: 'global'
  });
  const blocked = authenticate(setup, {
    id: 'blocked', username: 'Blocker', blockedUsers: ['author'], blockVersion: 3
  });
  const inspectingAdmin = authenticate(setup, {
    id: 'inspecting-admin', username: 'Admin', role: 'admin', joinedServers: ['global']
  });
  const ghostAdmin = authenticate(setup, {
    id: 'ghost-admin', username: 'BannedAdmin', role: 'admin', serverCode: 'global', joinedServers: ['global']
  });
  setup.RoomRestrictionModel.rows.splice(
    setup.RoomRestrictionModel.rows.findIndex(row => row.username === 'bannedadmin'), 1
  );

  assert.equal((await setPin(mod, objectId(1), true)).pin.pinVersion, 1);
  setup.RoomRestrictionModel.rows.push(restriction('ABC123', 'Member', { bannedAt: new Date() }));
  assert.equal((await setPin(mod, objectId(1), false)).pin.pinVersion, 2);

  const memberEvents = memberOtherSession.outbound.filter(item => item.event === 'message_pin_updated');
  assert.equal(memberEvents.length, 0);
  assert.deepEqual(inspectingAdmin.outbound.filter(item => item.event === 'message_pin_updated')
    .map(item => item.payload.pin.pinVersion), [1, 2]);
  const blockedEvents = blocked.outbound.filter(item => item.event === 'message_pin_updated');
  assert.deepEqual(blockedEvents.map(item => item.payload), [
    { pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 1, blockVersion: 3 } },
    { pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 2, blockVersion: 3 } }
  ]);
  assert.equal(JSON.stringify(blockedEvents).includes(objectId(1)), false);
  assert.equal(JSON.stringify(blockedEvents).includes('Author'), false);
  assert.equal(ghostAdmin.outbound.some(item => item.event === 'message_pin_updated'), false);
  assert.equal(JSON.stringify(inspectingAdmin.outbound).includes('message 1'), false);
  assert.equal(JSON.stringify(inspectingAdmin.outbound).includes('pins'), false);
});

test('pin audits include safe IDs and actors but never message or attachment content', async () => {
  const secret = 'NEVER_AUDIT_PIN_CONTENT';
  const setup = fixture({ messages: [message(1, {
    text: secret, attachment: 'data:image/png;base64,UElOU0VDUkVU'
  })] });
  const mod = authenticate(setup, { id: 'mod', username: 'ExactMod' });

  await setPin(mod, objectId(1), true);
  await setPin(mod, objectId(1), false);
  assert.deepEqual(setup.ModerationAuditModel.rows.map(row => ({
    action: row.action, serverCode: row.serverCode, actorUsername: row.actorUsername,
    actorRole: row.actorRole, actorRoomRole: row.actorRoomRole, messageId: row.messageId
  })), [
    { action: 'pin_message', serverCode: 'ABC123', actorUsername: 'ExactMod', actorRole: 'user', actorRoomRole: 'mod', messageId: objectId(1) },
    { action: 'unpin_message', serverCode: 'ABC123', actorUsername: 'ExactMod', actorRole: 'user', actorRoomRole: 'mod', messageId: objectId(1) }
  ]);
  const serialized = JSON.stringify(setup.ModerationAuditModel.rows);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('UElOU0VDUkVU'), false);
});
