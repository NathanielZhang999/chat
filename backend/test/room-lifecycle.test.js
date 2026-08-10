const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createConnectionHandler, seedSystem, withAccountTransitionLock,
  UserSchema, MessageSchema, resolvePings
} = require('../server');
const { FakeSocket, FakeIo, queryResult, acknowledge, deferred } = require('./support/fakes');

function register(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const defaultUserModel = {
    async findOne() {
      return {
        username: socket.username || 'alice',
        role: socket.role || 'user',
        servers: Array.isArray(socket.joinedServers) && socket.joinedServers.length > 0
          ? [...socket.joinedServers] : ['global']
      };
    }
  };
  createConnectionHandler({
    ioInstance,
    ChatServerModel: {
      async find(query = {}) {
        const codes = query.code && Array.isArray(query.code.$in) ? query.code.$in : ['global'];
        return codes.map(code => ({ code, moderators: [] }));
      },
      async findOne() { return null; }
    },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    onlineUsersMap: new Map(),
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    ...overrides,
    UserModel: { ...defaultUserModel, ...(overrides.UserModel || {}) }
  })(socket);
  return { socket, ioInstance };
}

function registerSharedSocket(overrides, id) {
  const socket = new FakeSocket();
  socket.id = id;
  const defaultUserModel = {
    async findOne() {
      return {
        username: socket.username || 'alice',
        role: socket.role || 'user',
        servers: Array.isArray(socket.joinedServers) && socket.joinedServers.length > 0
          ? [...socket.joinedServers] : ['global']
      };
    }
  };
  createConnectionHandler({
    ChatServerModel: {
      async find(query = {}) {
        const codes = query.code && Array.isArray(query.code.$in) ? query.code.$in : ['global'];
        return codes.map(code => ({ code, moderators: [] }));
      },
      async findOne() { return null; }
    },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    ...overrides,
    UserModel: { ...defaultUserModel, ...(overrides.UserModel || {}) }
  })(socket);
  return socket;
}

function createRecordingHistoryModel(rows, calls) {
  const matches = (row, query) => Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(clause => matches(row, clause));
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return Object.prototype.hasOwnProperty.call(row, key) === expected.$exists;
    }
    if (expected === null) return row[key] === null || row[key] === undefined;
    return row[key] === expected;
  });

  return {
    find(query) {
      calls.push({ method: 'find', value: query });
      let selected = rows.filter(row => matches(row, query)).map(row => ({ ...row }));
      return {
        sort(value) {
          calls.push({ method: 'sort', value });
          const direction = value.timestamp;
          selected.sort((left, right) => direction * (Date.parse(left.timestamp) - Date.parse(right.timestamp)));
          return this;
        },
        limit(value) {
          calls.push({ method: 'limit', value });
          selected = selected.slice(0, value);
          return this;
        },
        async lean() {
          calls.push({ method: 'lean' });
          return selected;
        }
      };
    }
  };
}

async function switchWithRecordedHistory(targetCode, rows) {
  const calls = [];
  const ChatServerModel = {
    findOne: query => queryResult({ code: query.code, moderators: [] })
  };
  const MessageModel = createRecordingHistoryModel(rows, calls);
  const { socket } = register({ ChatServerModel, MessageModel });
  Object.assign(socket, {
    username: 'alice', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'ABC123']
  });
  socket.joinedRooms.add('OLD123');
  const ack = acknowledge();

  await socket.trigger('switch_server', targetCode, ack.callback);

  return { acknowledgement: ack.value(), calls };
}

test('account transition locks serialize one normalized account and release after failure', async () => {
  const firstGate = deferred();
  const events = [];

  const first = withAccountTransitionLock('Alice', async () => {
    events.push('alice:first:start');
    await firstGate.promise;
    events.push('alice:first:end');
  });
  const second = withAccountTransitionLock('alice', async () => {
    events.push('alice:second');
  });
  const bob = withAccountTransitionLock('bob', async () => {
    events.push('bob');
  });

  await bob;
  assert.deepEqual(events, ['alice:first:start', 'bob']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['alice:first:start', 'bob', 'alice:first:end', 'alice:second']);

  await assert.rejects(withAccountTransitionLock('alice', async () => { throw new Error('expected'); }));
  await assert.doesNotReject(withAccountTransitionLock('ALICE', async () => {}));
});

test('room membership and private history schemas declare query-matching indexes once', () => {
  const userIndexes = UserSchema.indexes().filter(([keys]) => keys.servers === 1);
  const messageIndexes = MessageSchema.indexes().filter(([keys]) =>
    keys.serverCode === 1 && keys.timestamp === -1 && keys._id === -1
  );
  assert.equal(userIndexes.length, 1);
  assert.equal(messageIndexes.length, 1);
  assert.deepEqual(userIndexes[0][0], { servers: 1 });
  assert.deepEqual(messageIndexes[0][0], { serverCode: 1, timestamp: -1, _id: -1 });
});

test('mention resolution uses the exact membership projection and a lean query', async () => {
  const calls = [];
  const UserModel = {
    find(query, projection) {
      calls.push({ query, projection });
      return {
        async lean() {
          calls.push({ lean: true });
          return [
            { username: 'alice', displayName: 'Alice Smith' },
            { username: 'ali', displayName: 'Ali' }
          ];
        }
      };
    }
  };
  const result = await resolvePings(
    'Hi @ALICE SMITH and @ali', 'ABC123', 'user', 'user', 'bob', UserModel
  );
  assert.deepEqual(calls, [
    { query: { servers: 'ABC123' }, projection: 'username displayName' },
    { lean: true }
  ]);
  assert.equal(result, 'Hi {{PING:alice|Alice Smith}} and {{PING:ali|Ali}}');
});

test('login rejects replacing an authenticated socket identity', async () => {
  const { socket } = register();
  socket.username = 'alice';
  const ack = acknowledge();
  await socket.trigger('login', { username: 'bob', password: '123456' }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Already authenticated.' });
  assert.equal(socket.username, 'alice');
});

test('a late login server query failure leaves socket, rooms, presence, and broadcasts unchanged', async () => {
  const onlineUsersMap = new Map();
  const broadcasts = [];
  const { socket } = register({
    UserModel: {
      async findOne() {
        return { username: 'alice', displayName: 'Alice', password: 'hash', role: 'user', servers: ['global'] };
      }
    },
    ChatServerModel: { async find() { throw new Error('database unavailable'); } },
    bcryptImpl: { async compare() { return true; } },
    onlineUsersMap,
    broadcastOnlineUsersFn: async code => broadcasts.push(code),
    logger: { error() {} }
  });
  const ack = acknowledge();
  await socket.trigger('login', { username: 'alice', password: '123456' }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Login failed.' });
  assert.equal(socket.username, undefined);
  assert.equal(socket.serverCode, null);
  assert.deepEqual(socket.joinedServers, []);
  assert.equal(socket.joinedRooms.has('global'), false);
  assert.equal(onlineUsersMap.size, 0);
  assert.deepEqual(broadcasts, []);
});

test('login cannot publish membership removed by a concurrent leave', async () => {
  const compareStarted = deferred();
  const releaseCompare = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global', 'ABC123']
  };
  const staleLoginSnapshot = { ...persisted, servers: [...persisted.servers] };
  let regexReads = 0;
  let compareCalls = 0;

  function readUser(source = persisted) {
    const document = { ...source, servers: [...source.servers] };
    document.save = async () => {
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.username && typeof query.username === 'object') {
        regexReads += 1;
        return readUser(regexReads === 1 ? staleLoginSnapshot : persisted);
      }
      return readUser();
    }
  };
  const bcryptImpl = {
    async compare() {
      compareCalls += 1;
      if (compareCalls === 1) {
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return true;
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    bcryptImpl,
    ChatServerModel: { async find() { return []; }, async updateOne() {} }
  };
  const loginSocket = registerSharedSocket(shared, 'socket-login');
  const liveSocket = registerSharedSocket(shared, 'socket-live');
  Object.assign(liveSocket, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  liveSocket.joinedRooms.add('ABC123');
  onlineUsersMap.set(liveSocket.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123']
  });
  ioInstance.sockets = [loginSocket, liveSocket];

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: '123456'
  }, loginAck.callback);
  await compareStarted.promise;

  const leaveAck = acknowledge();
  await liveSocket.trigger('leave_server', 'ABC123', leaveAck.callback);
  assert.deepEqual(leaveAck.value(), { success: true });

  releaseCompare.resolve();
  await loginPending;

  assert.deepEqual(loginAck.value().joinedServers, ['global']);
  for (const live of [loginSocket, liveSocket]) {
    assert.deepEqual(live.joinedServers, ['global']);
    assert.equal(live.joinedRooms.has('ABC123'), false);
    assert.deepEqual(onlineUsersMap.get(live.id).joinedServers, ['global']);
  }
  assert.deepEqual(onlineUsersMap.get('map-only').joinedServers, ['global']);
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');
});

test('login cannot retain ghost access after concurrent global-admin demotion', async () => {
  const compareStarted = deferred();
  const releaseCompare = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Alice', password: 'hash', role: 'admin',
    color: '', avatarUrl: '', servers: ['global']
  };
  const staleLoginSnapshot = { ...persisted, servers: [...persisted.servers] };
  let regexReads = 0;
  let compareCalls = 0;

  function readUser(source = persisted) {
    const document = { ...source, servers: [...source.servers] };
    document.save = async () => {
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.username && typeof query.username === 'object') {
        regexReads += 1;
        return readUser(regexReads === 1 ? staleLoginSnapshot : persisted);
      }
      return readUser();
    }
  };
  const bcryptImpl = {
    async compare() {
      compareCalls += 1;
      if (compareCalls === 1) {
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return true;
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    bcryptImpl,
    ChatServerModel: {
      async find() { return []; },
      async findOne() { return { code: 'ABC123', moderators: [] }; }
    },
    MessageModel: { find: () => queryResult([]) }
  };
  const loginSocket = registerSharedSocket(shared, 'socket-login');
  const liveSocket = registerSharedSocket(shared, 'socket-live');
  Object.assign(liveSocket, {
    username: 'Alice', displayName: 'Alice', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global']
  });
  liveSocket.joinedRooms.add('ABC123');
  onlineUsersMap.set(liveSocket.id, {
    username: 'Alice', displayName: 'Alice', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'ABC123',
    joinedServers: ['global']
  });
  ioInstance.sockets = [loginSocket, liveSocket];

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: '123456'
  }, loginAck.callback);
  await compareStarted.promise;

  const roleAck = acknowledge();
  await liveSocket.trigger('manage_role', {
    targetUser: 'Alice', action: 'demote_global_admin'
  }, roleAck.callback);
  assert.deepEqual(roleAck.value(), { success: true });

  releaseCompare.resolve();
  await loginPending;

  assert.equal(loginAck.value().role, 'user');
  for (const live of [loginSocket, liveSocket]) {
    assert.equal(live.role, 'user');
    assert.equal(onlineUsersMap.get(live.id).role, 'user');
    assert.equal(live.joinedRooms.has('ABC123'), false);
  }
  assert.equal(onlineUsersMap.get('map-only').role, 'user');
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');

  const switchAck = acknowledge();
  await loginSocket.trigger('switch_server', 'ABC123', switchAck.callback);
  assert.deepEqual(switchAck.value(), { error: 'Permission denied.' });
  assert.equal(loginSocket.joinedRooms.has('ABC123'), false);
});

test('login overlapping profile update publishes the final profile', async () => {
  const compareStarted = deferred();
  const releaseCompare = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Old Alice', password: 'hash', role: 'user',
    color: '#111111', avatarUrl: 'https://example.test/old.png', servers: ['global']
  };
  const staleLoginSnapshot = { ...persisted, servers: [...persisted.servers] };
  let regexReads = 0;
  let compareCalls = 0;

  function readUser(source = persisted) {
    const document = { ...source, servers: [...source.servers] };
    document.save = async () => {
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.displayName && typeof query.displayName === 'object') return null;
      if (query.username && typeof query.username === 'object') {
        regexReads += 1;
        return readUser(regexReads === 1 ? staleLoginSnapshot : persisted);
      }
      return readUser();
    }
  };
  const bcryptImpl = {
    async compare() {
      compareCalls += 1;
      if (compareCalls === 1) {
        compareStarted.resolve();
        await releaseCompare.promise;
      }
      return true;
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    bcryptImpl,
    ChatServerModel: { async find() { return []; } },
    MessageModel: { async updateMany() {} }
  };
  const loginSocket = registerSharedSocket(shared, 'socket-login');
  const liveSocket = registerSharedSocket(shared, 'socket-live');
  Object.assign(liveSocket, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set(liveSocket.id, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [loginSocket, liveSocket];

  const loginAck = acknowledge();
  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: '123456'
  }, loginAck.callback);
  await compareStarted.promise;

  const profileAck = acknowledge();
  await liveSocket.trigger('update_profile', {
    displayName: 'New Alice', color: '#aabbcc', avatarUrl: 'https://example.test/new.png'
  }, profileAck.callback);
  assert.deepEqual(profileAck.value(), {
    success: true,
    displayName: 'New Alice',
    color: '#aabbcc',
    avatarUrl: 'https://example.test/new.png'
  });

  releaseCompare.resolve();
  await loginPending;

  const expectedProfile = {
    displayName: 'New Alice', color: '#aabbcc', avatarUrl: 'https://example.test/new.png'
  };
  assert.deepEqual({
    displayName: loginAck.value().displayName,
    color: loginAck.value().color,
    avatarUrl: loginAck.value().avatarUrl
  }, expectedProfile);
  for (const live of [loginSocket, liveSocket]) {
    assert.deepEqual({
      displayName: live.displayName, color: live.color, avatarUrl: live.avatarUrl
    }, expectedProfile);
    const session = onlineUsersMap.get(live.id);
    assert.deepEqual({
      displayName: session.displayName, color: session.color, avatarUrl: session.avatarUrl
    }, expectedProfile);
  }
  const mapOnly = onlineUsersMap.get('map-only');
  assert.deepEqual({
    displayName: mapOnly.displayName, color: mapOnly.color, avatarUrl: mapOnly.avatarUrl
  }, expectedProfile);
});

test('profile update reconciles a session that becomes live during the write', async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Old Alice', password: 'hash', role: 'user',
    color: '#111111', avatarUrl: 'https://example.test/old.png', servers: ['global']
  };

  function readUser() {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      saveStarted.resolve();
      await releaseSave.promise;
      Object.assign(persisted, document, { servers: [...document.servers] });
    };
    return document;
  }

  const UserModel = {
    async findOne(query) {
      if (query.displayName && typeof query.displayName === 'object') return null;
      return readUser();
    }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    MessageModel: { async updateMany() {} }
  };
  const updater = registerSharedSocket(shared, 'socket-updater');
  const arriving = registerSharedSocket(shared, 'socket-arriving');
  Object.assign(updater, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set(updater.id, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set('map-only', {
    username: 'alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [updater];

  let acknowledgement;
  let profilesAtAcknowledgement;
  const pending = updater.trigger('update_profile', {
    displayName: 'New Alice', color: '#aabbcc', avatarUrl: 'https://example.test/new.png'
  }, value => {
    acknowledgement = value;
    profilesAtAcknowledgement = [updater, arriving].map(live => ({
      displayName: live.displayName,
      color: live.color,
      avatarUrl: live.avatarUrl,
      session: { ...onlineUsersMap.get(live.id) }
    }));
    profilesAtAcknowledgement.push({ session: { ...onlineUsersMap.get('map-only') } });
  });
  await saveStarted.promise;

  Object.assign(arriving, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  onlineUsersMap.set(arriving.id, {
    username: 'Alice', displayName: 'Old Alice', role: 'user', color: '#111111',
    avatarUrl: 'https://example.test/old.png', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [updater, arriving];
  releaseSave.resolve();
  await pending;

  assert.deepEqual(acknowledgement, {
    success: true,
    displayName: 'New Alice',
    color: '#aabbcc',
    avatarUrl: 'https://example.test/new.png'
  });
  for (const snapshot of profilesAtAcknowledgement) {
    const liveProfile = snapshot.displayName === undefined ? snapshot.session : snapshot;
    assert.equal(liveProfile.displayName, 'New Alice');
    assert.equal(liveProfile.color, '#aabbcc');
    assert.equal(liveProfile.avatarUrl, 'https://example.test/new.png');
    assert.equal(snapshot.session.displayName, 'New Alice');
    assert.equal(snapshot.session.color, '#aabbcc');
    assert.equal(snapshot.session.avatarUrl, 'https://example.test/new.png');
  }
});

test('unauthorized room switch leaves current membership unchanged', async () => {
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123' }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({ ChatServerModel, MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.equal(socket.serverCode, 'global');
  assert.equal(socket.leftRooms.length, 0);
});

test('authorized room switch leaves old room only after access succeeds', async () => {
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({ ChatServerModel, MessageModel });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');
  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);
  assert.equal(socket.serverCode, 'ABC123');
  assert.deepEqual(socket.leftRooms, ['global']);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.deepEqual(ack.value(), {
    history: [], roomRole: 'user',
    restriction: { banned: false, timedOut: false, timeoutUntil: null }
  });
});

test('room switch history failure preserves transport, socket, and presence state', async () => {
  const onlineUsersMap = new Map([['socket-1', {
    username: 'alice', serverCode: 'OLD123', joinedServers: ['global', 'OLD123', 'ABC123']
  }]]);
  const broadcasts = [];
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        async lean() { throw new Error('history unavailable'); }
      };
    }
  };
  const { socket } = register({
    ChatServerModel,
    MessageModel,
    onlineUsersMap,
    broadcastOnlineUsersFn: code => broadcasts.push(code),
    logger: { error() {} }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'OLD123', 'ABC123'];
  socket.serverCode = 'OLD123';
  socket.joinedRooms.add('OLD123');

  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Failed to switch server.' });
  assert.equal(socket.serverCode, 'OLD123');
  assert.deepEqual(socket.leftRooms, []);
  assert.equal(socket.joinedRooms.has('OLD123'), true);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'OLD123');
  assert.deepEqual(broadcasts, []);
});

for (const scenario of [
  { stage: 'leave', failure: 'synchronous throw' },
  { stage: 'leave', failure: 'rejected promise' },
  { stage: 'join', failure: 'synchronous throw' },
  { stage: 'join', failure: 'rejected promise' }
]) {
  test(`room switch fails closed when ${scenario.stage} has a ${scenario.failure}`, async () => {
    const events = [];
    const broadcasts = [];
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', serverCode: 'OLD123', joinedServers: ['global', 'OLD123', 'ABC123']
    }]]);
    const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
    const MessageModel = { find: () => queryResult([]) };
    const { socket } = register({
      ChatServerModel,
      MessageModel,
      onlineUsersMap,
      broadcastOnlineUsersFn: code => broadcasts.push(code),
      logger: { error() {} }
    });
    socket.username = 'alice';
    socket.role = 'user';
    socket.joinedServers = ['global', 'OLD123', 'ABC123'];
    socket.serverCode = 'OLD123';
    socket.joinedRooms.add('OLD123');

    const originalLeave = socket.leave.bind(socket);
    const originalJoin = socket.join.bind(socket);
    let failed = false;
    socket.leave = roomCode => {
      events.push(`leave:${roomCode}`);
      originalLeave(roomCode);
      if (!failed && scenario.stage === 'leave' && roomCode === 'OLD123') {
        failed = true;
        if (scenario.failure === 'synchronous throw') throw new Error('leave failed');
        return Promise.reject(new Error('leave failed'));
      }
    };
    socket.join = roomCode => {
      events.push(`join:${roomCode}`);
      originalJoin(roomCode);
      if (!failed && scenario.stage === 'join' && roomCode === 'ABC123') {
        failed = true;
        if (scenario.failure === 'synchronous throw') throw new Error('join failed');
        return Promise.reject(new Error('join failed'));
      }
    };
    socket.disconnect = force => {
      events.push(`disconnect:${force}`);
      socket.joinedRooms.clear();
      socket.disconnected = force;
      return socket.handlers.get('disconnect')();
    };

    const ack = acknowledge();
    await socket.trigger('switch_server', 'ABC123', ack.callback);

    assert.deepEqual(ack.value(), { error: 'Failed to switch server.' });
    assert.equal(socket.disconnected, true);
    assert.equal(socket.serverCode, null);
    assert.equal(onlineUsersMap.has(socket.id), false);
    assert.deepEqual([...socket.joinedRooms], []);
    assert.deepEqual(socket.joinedServers, []);
    assert.deepEqual(broadcasts, []);
    assert.deepEqual(events, scenario.stage === 'leave'
      ? ['leave:OLD123', 'leave:ABC123', 'leave:OLD123', 'disconnect:true']
      : ['leave:OLD123', 'join:ABC123', 'leave:ABC123', 'leave:OLD123', 'disconnect:true']);
  });
}

for (const failure of ['synchronous throw', 'rejected promise']) {
  test(`failed target join clears authorization and transport when disconnect has a ${failure}`, async () => {
    const events = [];
    const broadcasts = [];
    let userLookups = 0;
    let userCreates = 0;
    let passwordComparisons = 0;
    let passwordHashes = 0;
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'OLD123',
      joinedServers: ['global', 'OLD123', 'ABC123']
    }]]);
    const room = { code: 'ABC123', owner: 'owner', moderators: [] };
    const readUser = () => ({
      username: 'alice', displayName: 'Alice', password: 'hash', role: 'admin',
      color: '', avatarUrl: '', servers: ['global'], async save() {}
    });
    const { socket } = register({
      onlineUsersMap,
      UserModel: {
        async findOne(query) {
          userLookups += 1;
          if (query.username && typeof query.username === 'object') {
            return query.username.$regex.test('alice') ? readUser() : null;
          }
          if (query.displayName) return null;
          return query.username === 'alice' ? readUser() : null;
        },
        async create() { userCreates += 1; }
      },
      bcryptImpl: {
        async compare() { passwordComparisons += 1; return true; },
        async hash() { passwordHashes += 1; return 'hash'; }
      },
      ChatServerModel: {
        async findOne() { return room; },
        async find() { return []; }
      },
      MessageModel: { find: () => queryResult([]) },
      broadcastOnlineUsersFn: code => broadcasts.push(code),
      logger: { error() {} }
    });
    Object.assign(socket, {
      username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'OLD123',
      joinedServers: ['global', 'OLD123', 'ABC123']
    });
    socket.joinedRooms.add('OLD123');

    socket.leave = roomCode => {
      events.push(`leave:${roomCode}`);
      FakeSocket.prototype.leave.call(socket, roomCode);
    };
    socket.join = roomCode => {
      events.push(`join:${roomCode}`);
      FakeSocket.prototype.join.call(socket, roomCode);
      if (roomCode === 'ABC123') return Promise.reject(new Error('target join failed'));
    };
    socket.disconnect = force => {
      events.push(`disconnect:${force}`);
      if (failure === 'synchronous throw') throw new Error('disconnect failed');
      return Promise.reject(new Error('disconnect failed'));
    };

    const switchAck = acknowledge();
    await socket.trigger('switch_server', 'ABC123', switchAck.callback);

    assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
    assert.equal(socket.username, null);
    assert.equal(socket.displayName, null);
    assert.equal(socket.role, null);
    assert.deepEqual(socket.joinedServers, []);
    assert.equal(socket.serverCode, null);
    assert.equal(onlineUsersMap.has(socket.id), false);
    assert.deepEqual([...socket.joinedRooms], []);
    const userLookupsAfterSwitch = userLookups;

    const authenticatedAck = acknowledge();
    await socket.trigger('join_server', 'ABC123', authenticatedAck.callback);
    assert.deepEqual(authenticatedAck.value(), { error: 'Not authenticated.' });

    const loginAck = acknowledge();
    await socket.trigger('login', {
      username: 'alice', password: '123456'
    }, loginAck.callback);
    const registerAck = acknowledge();
    await socket.trigger('register', {
      username: 'bob', displayName: 'Bob', password: '123456'
    }, registerAck.callback);
    assert.deepEqual(loginAck.value(), { error: 'Connection unavailable.' });
    assert.deepEqual(registerAck.value(), { error: 'Connection unavailable.' });
    assert.equal(userLookups, userLookupsAfterSwitch);
    assert.equal(userCreates, 0);
    assert.equal(passwordComparisons, 0);
    assert.equal(passwordHashes, 0);
    assert.equal(socket.username, null);
    assert.deepEqual(socket.joinedServers, []);
    assert.equal(onlineUsersMap.has(socket.id), false);

    socket.handlers.get('disconnect')();

    assert.deepEqual(broadcasts, []);
    assert.deepEqual(events, [
      'leave:OLD123', 'join:ABC123', 'leave:ABC123', 'leave:OLD123', 'disconnect:true'
    ]);
  });
}

test('failed target join cannot restore source access revoked by a concurrent leave', async () => {
  const targetJoinStarted = deferred();
  const releaseTargetJoin = deferred();
  const persisted = {
    username: 'alice', servers: ['global', 'OLD123', 'NEW123']
  };
  const readUser = () => {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      persisted.servers = [...document.servers];
    };
    return document;
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return readUser(); } },
    ChatServerModel: {
      async findOne({ code }) { return { code, owner: 'owner', moderators: [] }; },
      async updateOne() {}
    },
    MessageModel: { find: () => queryResult([]) },
    logger: { error() {} }
  };
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  Object.assign(switcher, {
    username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  switcher.joinedRooms.add('OLD123');
  const revoker = registerSharedSocket(shared, 'socket-revoker');
  Object.assign(revoker, {
    username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'global',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  revoker.joinedRooms.add('global');
  for (const live of [switcher, revoker]) {
    onlineUsersMap.set(live.id, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: live.serverCode,
      joinedServers: ['global', 'OLD123', 'NEW123']
    });
  }
  ioInstance.sockets = [switcher, revoker];

  let targetAttempted = false;
  switcher.join = async roomCode => {
    FakeSocket.prototype.join.call(switcher, roomCode);
    if (roomCode === 'NEW123' && !targetAttempted) {
      targetAttempted = true;
      targetJoinStarted.resolve();
      await releaseTargetJoin.promise;
      throw new Error('target join failed');
    }
  };
  switcher.disconnect = force => {
    switcher.joinedRooms.clear();
    switcher.disconnected = force;
    return switcher.handlers.get('disconnect')();
  };

  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'NEW123', switchAck.callback);
  await targetJoinStarted.promise;

  const leaveAck = acknowledge();
  const leavePending = revoker.trigger('leave_server', 'OLD123', leaveAck.callback);
  await Promise.resolve();
  releaseTargetJoin.resolve();
  await Promise.all([switchPending, leavePending]);
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(persisted.servers, ['global', 'NEW123']);

  assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
  assert.equal(switcher.disconnected, true);
  assert.equal(switcher.serverCode, null);
  assert.equal(onlineUsersMap.has(switcher.id), false);
  assert.equal(switcher.joinedRooms.has('OLD123'), false);
});

test('failed target join cannot restore source access revoked by a concurrent demotion', async () => {
  const targetJoinStarted = deferred();
  const releaseTargetJoin = deferred();
  const targetUser = {
    username: 'bob', displayName: 'Bob', role: 'admin', servers: ['global'],
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return targetUser; } },
    ChatServerModel: {
      async findOne({ code }) { return { code, owner: 'owner', moderators: [] }; }
    },
    MessageModel: { find: () => queryResult([]) },
    logger: { error() {} }
  };
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  Object.assign(switcher, {
    username: 'bob', displayName: 'Bob', role: 'admin', serverCode: 'OLD123',
    joinedServers: ['global']
  });
  switcher.joinedRooms.add('OLD123');
  const administrator = registerSharedSocket(shared, 'socket-admin');
  Object.assign(administrator, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  administrator.joinedRooms.add('global');
  onlineUsersMap.set(switcher.id, {
    username: 'bob', displayName: 'Bob', role: 'admin', serverCode: 'OLD123',
    joinedServers: ['global']
  });
  onlineUsersMap.set(administrator.id, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  ioInstance.sockets = [switcher, administrator];

  let targetAttempted = false;
  switcher.join = async roomCode => {
    FakeSocket.prototype.join.call(switcher, roomCode);
    if (roomCode === 'NEW123' && !targetAttempted) {
      targetAttempted = true;
      targetJoinStarted.resolve();
      await releaseTargetJoin.promise;
      throw new Error('target join failed');
    }
  };
  switcher.disconnect = force => {
    switcher.joinedRooms.clear();
    switcher.disconnected = force;
    return switcher.handlers.get('disconnect')();
  };

  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'NEW123', switchAck.callback);
  await targetJoinStarted.promise;

  const roleAck = acknowledge();
  const rolePending = administrator.trigger('manage_role', {
    targetUser: 'bob', action: 'demote_global_admin'
  }, roleAck.callback);
  await Promise.resolve();
  releaseTargetJoin.resolve();
  await Promise.all([switchPending, rolePending]);
  assert.deepEqual(roleAck.value(), { success: true });
  assert.equal(targetUser.role, 'user');

  assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
  assert.equal(switcher.disconnected, true);
  assert.equal(switcher.serverCode, null);
  assert.equal(onlineUsersMap.has(switcher.id), false);
  assert.equal(switcher.joinedRooms.has('OLD123'), false);
});

test('failed target join cannot restore a concurrently deleted source room', async () => {
  const targetJoinStarted = deferred();
  const releaseTargetJoin = deferred();
  const rooms = new Map([
    ['OLD123', { code: 'OLD123', owner: 'alice', moderators: [] }],
    ['NEW123', { code: 'NEW123', owner: 'owner', moderators: [] }]
  ]);
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    ChatServerModel: {
      async findOne({ code }) { return rooms.get(code) || null; },
      async deleteOne({ code }) { rooms.delete(code); }
    },
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher && matcher.test('alice')) {
          return { username: 'alice', role: 'admin', servers: ['global'] };
        }
        return { username: 'bob', role: 'user', servers: ['global', 'OLD123', 'NEW123'] };
      },
      async updateMany() {}
    },
    MessageModel: {
      find: () => queryResult([]),
      async deleteMany() {}
    },
    logger: { error() {} }
  };
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  Object.assign(switcher, {
    username: 'bob', displayName: 'Bob', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  switcher.joinedRooms.add('OLD123');
  const deleter = registerSharedSocket(shared, 'socket-deleter');
  Object.assign(deleter, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  deleter.joinedRooms.add('global');
  onlineUsersMap.set(switcher.id, {
    username: 'bob', displayName: 'Bob', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'NEW123']
  });
  onlineUsersMap.set(deleter.id, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global']
  });
  ioInstance.sockets = [switcher, deleter];

  let targetAttempted = false;
  switcher.join = async roomCode => {
    FakeSocket.prototype.join.call(switcher, roomCode);
    if (roomCode === 'NEW123' && !targetAttempted) {
      targetAttempted = true;
      targetJoinStarted.resolve();
      await releaseTargetJoin.promise;
      throw new Error('target join failed');
    }
  };
  switcher.disconnect = force => {
    switcher.joinedRooms.clear();
    switcher.disconnected = force;
    return switcher.handlers.get('disconnect')();
  };

  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'NEW123', switchAck.callback);
  await targetJoinStarted.promise;

  const deleteAck = acknowledge();
  const deletePending = deleter.trigger('delete_server', 'OLD123', deleteAck.callback);
  await Promise.resolve();
  releaseTargetJoin.resolve();
  await Promise.all([switchPending, deletePending]);
  assert.deepEqual(deleteAck.value(), { success: true });
  assert.equal(rooms.has('OLD123'), false);

  assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' });
  assert.equal(switcher.disconnected, true);
  assert.equal(switcher.serverCode, null);
  assert.equal(onlineUsersMap.has(switcher.id), false);
  assert.equal(switcher.joinedRooms.has('OLD123'), false);
});

test('room switching acknowledges first and publishes only affected private presence', async () => {
  const scenarios = [
    { oldCode: 'OLD123', targetCode: 'ABC123', expected: ['OLD123', 'ABC123'] },
    { oldCode: 'global', targetCode: 'ABC123', expected: ['ABC123'] },
    { oldCode: 'OLD123', targetCode: 'global', expected: ['OLD123'] },
    { oldCode: 'ABC123', targetCode: 'ABC123', expected: ['ABC123'] },
    { oldCode: 'global', targetCode: 'global', expected: [] }
  ];

  for (const scenario of scenarios) {
    const events = [];
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', serverCode: scenario.oldCode,
      joinedServers: ['global', 'OLD123', 'ABC123']
    }]]);
    const ChatServerModel = {
      findOne: query => queryResult({ code: query.code, moderators: [] })
    };
    const MessageModel = { find: () => queryResult([]) };
    const { socket } = register({
      ChatServerModel, MessageModel, onlineUsersMap,
      broadcastOnlineUsersFn: code => events.push(`broadcast:${code}`)
    });
    Object.assign(socket, {
      username: 'alice', role: 'user', serverCode: scenario.oldCode,
      joinedServers: ['global', 'OLD123', 'ABC123']
    });
    socket.joinedRooms.add(scenario.oldCode);

    await socket.trigger('switch_server', scenario.targetCode, () => events.push('ack'));
    assert.deepEqual(events, ['ack', ...scenario.expected.map(code => `broadcast:${code}`)]);
  }
});

test('private room switch uses the exact bounded lean history query and returns chronological rows', async () => {
  const { acknowledgement, calls } = await switchWithRecordedHistory('ABC123', [
    { _id: 'private-new', username: 'alice', serverCode: 'ABC123', timestamp: '2026-01-03T00:00:00.000Z' },
    { _id: 'other-room', username: 'alice', serverCode: 'BBB222', timestamp: '2026-01-04T00:00:00.000Z' },
    { _id: 'private-old', username: 'alice', serverCode: 'ABC123', timestamp: '2026-01-01T00:00:00.000Z' }
  ]);

  assert.deepEqual(calls, [
    { method: 'find', value: { serverCode: 'ABC123' } },
    { method: 'sort', value: { timestamp: -1 } },
    { method: 'limit', value: 100 },
    { method: 'lean' }
  ]);
  assert.deepEqual(
    acknowledgement.history.map(row => [row._id, row.timestamp]),
    [
      ['private-old', '2026-01-01T00:00:00.000Z'],
      ['private-new', '2026-01-03T00:00:00.000Z']
    ]
  );
});

test('Global room switch preserves the exact legacy predicate including missing and null rows', async () => {
  const { acknowledgement, calls } = await switchWithRecordedHistory('global', [
    { _id: 'global-explicit', username: 'alice', serverCode: 'global', timestamp: '2026-01-04T00:00:00.000Z' },
    { _id: 'global-missing', username: 'alice', timestamp: '2026-01-02T00:00:00.000Z' },
    { _id: 'private-row', username: 'alice', serverCode: 'ABC123', timestamp: '2026-01-05T00:00:00.000Z' },
    { _id: 'global-null', username: 'alice', serverCode: null, timestamp: '2026-01-03T00:00:00.000Z' }
  ]);

  assert.deepEqual(calls, [
    {
      method: 'find',
      value: {
        $or: [
          { serverCode: 'global' },
          { serverCode: { $exists: false } },
          { serverCode: null }
        ]
      }
    },
    { method: 'sort', value: { timestamp: -1 } },
    { method: 'limit', value: 100 },
    { method: 'lean' }
  ]);
  assert.deepEqual(
    acknowledgement.history.map(row => [
      row._id,
      Object.prototype.hasOwnProperty.call(row, 'serverCode') ? row.serverCode : '<missing>'
    ]),
    [
      ['global-missing', '<missing>'],
      ['global-null', null],
      ['global-explicit', 'global']
    ]
  );
});

test('room switch finishes role lookup before history lookup begins', async () => {
  const events = [];
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = {
    find() {
      events.push('history:find');
      return {
        sort() { return this; },
        limit() { return this; },
        async lean() {
          events.push('history:lean');
          return [];
        }
      };
    }
  };
  const { socket } = register({
    ChatServerModel,
    MessageModel,
    async getRoomRoleFn() {
      events.push('role:start');
      await Promise.resolve();
      events.push('role:end');
      return 'user';
    }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'ABC123'];
  socket.serverCode = 'global';
  socket.joinedRooms.add('global');

  const ack = acknowledge();
  await socket.trigger('switch_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), {
    history: [], roomRole: 'user',
    restriction: { banned: false, timedOut: false, timeoutUntil: null }
  });
  assert.deepEqual(events, [
    'role:start', 'role:end', 'history:find', 'history:lean'
  ]);
});

test('leaving the active room removes transport and moderator access then moves to global', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const pulled = [];
  const UserModel = { findOne: async () => user };
  const ChatServerModel = { async updateOne(filter, update) { pulled.push({ filter, update }); } };
  const { socket } = register({ UserModel, ChatServerModel });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = user.servers;
  socket.joinedRooms.add('ABC123');
  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);
  assert.deepEqual(user.servers, ['global']);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(socket.serverCode, 'global');
  assert.deepEqual(pulled, [{
    filter: { code: 'ABC123' },
    update: { $pull: { moderators: 'alice' } }
  }]);
  assert.deepEqual(ack.value(), { success: true });
});

test('leaving a room revokes membership and transport access from every live session', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }],
    ['socket-2', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]
  ]);
  const ioInstance = new FakeIo();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne() {} }
  });
  socket.username = 'alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');

  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  for (const liveSocket of [socket, second]) {
    assert.deepEqual(liveSocket.joinedServers, ['global']);
    assert.equal(liveSocket.serverCode, 'global');
    assert.equal(liveSocket.joinedRooms.has('ABC123'), false);
    assert.equal(liveSocket.joinedRooms.has('global'), true);
    assert.deepEqual(liveSocket.outbound.at(-1), {
      target: 'self',
      event: 'room_access_updated',
      payload: { username: 'alice', joinedServers: ['global'], serverCode: 'global', bannedRooms: [] }
    });
  }
  assert.deepEqual(onlineUsersMap.get('socket-1').joinedServers, ['global']);
  assert.deepEqual(onlineUsersMap.get('socket-2').joinedServers, ['global']);
});

test('moderator cleanup failure cannot preserve transport access after leaving', async () => {
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }],
    ['socket-2', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]
  ]);
  const ioInstance = new FakeIo();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne() { throw new Error('cleanup unavailable'); } },
    logger: { error() {} }
  });
  socket.username = 'alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Failed to leave.' });
  for (const liveSocket of [socket, second]) {
    assert.deepEqual(liveSocket.joinedServers, ['global']);
    assert.equal(liveSocket.serverCode, 'global');
    assert.equal(liveSocket.joinedRooms.has('ABC123'), false);
  }
});

test('leaving updates every session membership before awaiting transport eviction', async () => {
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const user = { servers: ['global', 'ABC123'], async save() {} };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }],
    ['socket-2', { username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]
  ]);
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne() {} }
  });
  socket.username = 'alice';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  socket.leave = async room => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(socket, room);
  };
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  const pending = socket.trigger('leave_server', 'ABC123', ack.callback);
  await firstLeaveStarted.promise;
  assert.deepEqual(second.joinedServers, ['global']);
  assert.deepEqual(onlineUsersMap.get(second.id).joinedServers, ['global']);
  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(ack.value(), { success: true });
});

test('leaving an active ghost-access room moves a global admin to global without database cleanup', async () => {
  const user = { servers: ['global'], async save() { throw new Error('must not save'); } };
  const pulled = [];
  const onlineUsersMap = new Map([['socket-1', { serverCode: 'ABC123', joinedServers: ['global'] }]]);
  const { socket } = register({
    UserModel: { async findOne() { return user; } },
    ChatServerModel: { async updateOne(...args) { pulled.push(args); } },
    onlineUsersMap
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global'];
  socket.joinedRooms.add('ABC123');
  const ack = acknowledge();
  await socket.trigger('leave_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.deepEqual(user.servers, ['global']);
  assert.deepEqual(pulled, []);
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(socket.serverCode, 'global');
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'global');
});

test('deleting an active room keeps the socket and mapped session in global', async () => {
  const onlineUsersMap = new Map([['socket-1', { serverCode: 'ABC123', joinedServers: ['global', 'ABC123'] }]]);
  const { socket, ioInstance } = register({
    onlineUsersMap,
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() {}
    },
    UserModel: { async updateMany() {} },
    MessageModel: { async deleteMany() {} }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket];
  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { success: true });
  assert.equal(socket.serverCode, 'global');
  assert.equal(socket.joinedRooms.has('ABC123'), false);
  assert.equal(socket.joinedRooms.has('global'), true);
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'global');
});

test('room deletion computes fallback from fresh restrictions instead of stale cached bannedRooms', async () => {
  const rooms = [
    { code: 'global', owner: 'System', moderators: [] },
    { code: 'ABC123', owner: 'alice', moderators: [] },
    { code: 'XYZ789', owner: 'bob', moderators: [] }
  ];
  const users = {
    alice: { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] },
    bob: { username: 'Bob', role: 'user', servers: ['global', 'ABC123', 'XYZ789'] }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return Object.values(users).find(user => matcher.test(user.username));
        return users[query.username];
      },
      async updateMany() {
        for (const user of Object.values(users)) {
          user.servers = user.servers.filter(code => code !== 'ABC123');
        }
      }
    },
    ChatServerModel: {
      async find(query = {}) {
        const codes = query.code && Array.isArray(query.code.$in) ? query.code.$in : [];
        return rooms.filter(room => codes.includes(room.code));
      },
      async findOne(query) { return rooms.find(room => room.code === query.code) || null; },
      async deleteOne(query) {
        const index = rooms.findIndex(room => room.code === query.code);
        if (index >= 0) rooms.splice(index, 1);
      }
    },
    RoomRestrictionModel: {
      async find(query) {
        return query.username === 'bob'
          ? [{ serverCode: 'global', username: 'bob', bannedAt: new Date() }]
          : [];
      },
      async findOne() { return null; }
    },
    MessageModel: { async deleteMany() {} }
  });
  Object.assign(socket, {
    username: 'alice', displayName: 'Alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  onlineUsersMap.set(socket.id, {
    username: 'alice', role: 'admin', serverCode: 'global',
    joinedServers: ['global', 'ABC123'], bannedRooms: []
  });
  const target = new FakeSocket();
  target.id = 'target-delete-fallback';
  Object.assign(target, {
    username: 'Bob', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  target.joinedRooms.add('ABC123');
  onlineUsersMap.set(target.id, {
    username: 'Bob', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  onlineUsersMap.set('target-delete-map-only', {
    username: 'bob', role: 'user', serverCode: 'ABC123',
    joinedServers: ['global', 'ABC123', 'XYZ789'], bannedRooms: []
  });
  ioInstance.sockets = [socket, target];

  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  assert.equal(target.serverCode, 'XYZ789');
  assert.deepEqual(target.joinedServers, ['XYZ789']);
  assert.deepEqual(target.bannedRooms, ['global']);
  assert.equal(target.joinedRooms.has('global'), false);
  assert.equal(target.joinedRooms.has('XYZ789'), true);
  assert.equal(onlineUsersMap.get('target-delete-map-only').serverCode, 'XYZ789');
  assert.deepEqual(onlineUsersMap.get('target-delete-map-only').bannedRooms, ['global']);
});

test('room deletion preflights live sockets before destructive writes', async () => {
  let deleted = 0;
  const ioInstance = new FakeIo();
  ioInstance.fetchSockets = async () => { throw new Error('adapter unavailable'); };
  const { socket } = register({
    ioInstance,
    logger: { error() {} },
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() { deleted += 1; }
    },
    MessageModel: { async deleteMany() {} },
    UserModel: { async updateMany() {} }
  });
  socket.username = 'alice';
  socket.role = 'user';
  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);
  assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
  assert.equal(deleted, 0);
});

test('primary room deletion failure preserves live authorization state', async () => {
  let messageCleanupCalls = 0;
  let membershipCleanupCalls = 0;
  const ioInstance = new FakeIo();
  const { socket } = register({
    ioInstance,
    logger: { error() {} },
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() { throw new Error('delete unavailable'); }
    },
    MessageModel: { async deleteMany() { messageCleanupCalls += 1; } },
    UserModel: { async updateMany() { membershipCleanupCalls += 1; } }
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  ioInstance.sockets = [socket];

  const ack = acknowledge();
  await socket.trigger('delete_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
  assert.equal(socket.serverCode, 'ABC123');
  assert.deepEqual(socket.joinedServers, ['global', 'ABC123']);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.equal(messageCleanupCalls, 0);
  assert.equal(membershipCleanupCalls, 0);
  assert.equal(ioInstance.outbound.some(item => item.event === 'server_deleted'), false);
});

for (const failedStage of ['message cleanup', 'membership cleanup']) {
  test(`room deletion closes live access when ${failedStage} fails after room removal`, async () => {
    const ioInstance = new FakeIo();
    const onlineUsersMap = new Map([['socket-1', {
      username: 'alice', serverCode: 'ABC123', joinedServers: ['global', 'ABC123']
    }]]);
    let messageCleanupCalls = 0;
    let membershipCleanupCalls = 0;
    const { socket } = register({
      ioInstance,
      onlineUsersMap,
      logger: { error() {} },
      ChatServerModel: {
        async findOne() { return { code: 'ABC123', owner: 'alice' }; },
        async deleteOne() {}
      },
      MessageModel: {
        async deleteMany() {
          messageCleanupCalls += 1;
          if (failedStage === 'message cleanup') throw new Error('messages unavailable');
        }
      },
      UserModel: {
        async updateMany() {
          membershipCleanupCalls += 1;
          if (failedStage === 'membership cleanup') throw new Error('users unavailable');
        }
      }
    });
    socket.username = 'alice';
    socket.role = 'user';
    socket.serverCode = 'ABC123';
    socket.joinedServers = ['global', 'ABC123'];
    socket.joinedRooms.add('ABC123');
    ioInstance.sockets = [socket];

    const ack = acknowledge();
    await socket.trigger('delete_server', 'ABC123', ack.callback);

    assert.deepEqual(ack.value(), { error: 'Deletion failed.' });
    assert.equal(socket.serverCode, 'global');
    assert.deepEqual(socket.joinedServers, ['global']);
    assert.equal(socket.joinedRooms.has('ABC123'), false);
    assert.equal(socket.joinedRooms.has('global'), true);
    assert.equal(ioInstance.outbound.some(item =>
      item.room === '*' && item.event === 'server_deleted' && item.payload === 'ABC123'
    ), true);
    assert.equal(messageCleanupCalls, 1);
    assert.equal(membershipCleanupCalls, 1);
  });
}

test('join grant cannot resurrect a detached membership removed by a concurrent leave', async () => {
  const grantSaveStarted = deferred();
  const releaseGrantSave = deferred();
  const persisted = { username: 'alice', servers: ['global', 'SECRET'] };

  function readUser() {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      const proposedServers = [...document.servers];
      if (proposedServers.includes('OTHER1')) {
        grantSaveStarted.resolve();
        await releaseGrantSave.promise;
      }
      persisted.servers = proposedServers;
    };
    return document;
  }

  const joinedRoom = { code: 'OTHER1', owner: 'owner', moderators: [] };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return readUser(); } },
    ChatServerModel: {
      async findOne({ code }) { return code === joinedRoom.code ? joinedRoom : null; },
      async updateOne() {}
    },
    logger: { error() {} }
  };
  const joiner = registerSharedSocket(shared, 'socket-joiner');
  const leaver = registerSharedSocket(shared, 'socket-leaver');
  for (const live of [joiner, leaver]) {
    Object.assign(live, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
    live.joinedRooms.add('SECRET');
    onlineUsersMap.set(live.id, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
  }
  onlineUsersMap.set('map-only', {
    username: 'ALICE', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [joiner, leaver];

  const joinAck = acknowledge();
  const joinPending = joiner.trigger('join_server', 'OTHER1', joinAck.callback);
  await grantSaveStarted.promise;

  const arriving = registerSharedSocket(shared, 'socket-arriving');
  Object.assign(arriving, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  arriving.joinedRooms.add('SECRET');
  onlineUsersMap.set(arriving.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [joiner, leaver, arriving];

  const leaveAck = acknowledge();
  const leavePending = leaver.trigger('leave_server', 'SECRET', leaveAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  const leaveCompletedBeforeGrant = leaveAck.value() !== undefined;
  releaseGrantSave.resolve();
  await Promise.all([joinPending, leavePending]);

  assert.equal(leaveCompletedBeforeGrant, false);
  assert.deepEqual(joinAck.value(), { success: true, server: joinedRoom });
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(persisted.servers, ['global', 'OTHER1']);
  for (const live of [joiner, leaver, arriving]) {
    assert.deepEqual(live.joinedServers, ['global', 'OTHER1']);
    assert.equal(live.serverCode, 'global');
    assert.equal(live.joinedRooms.has('SECRET'), false);
    assert.deepEqual(onlineUsersMap.get(live.id).joinedServers, ['global', 'OTHER1']);
  }
  assert.deepEqual(onlineUsersMap.get('map-only').joinedServers, ['global', 'OTHER1']);
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');
});

test('create grant cannot resurrect a detached membership removed by a concurrent leave', async () => {
  const grantSaveStarted = deferred();
  const releaseGrantSave = deferred();
  const persisted = { username: 'alice', servers: ['global', 'SECRET'] };

  function readUser() {
    const document = { ...persisted, servers: [...persisted.servers] };
    document.save = async () => {
      const proposedServers = [...document.servers];
      if (proposedServers.includes('NEW123')) {
        grantSaveStarted.resolve();
        await releaseGrantSave.promise;
      }
      persisted.servers = proposedServers;
    };
    return document;
  }

  const createdRoom = { code: 'NEW123', name: 'Team', owner: 'alice', moderators: ['alice'] };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return readUser(); } },
    ChatServerModel: {
      async create() { return createdRoom; },
      async updateOne() {}
    },
    logger: { error() {} }
  };
  const creator = registerSharedSocket(shared, 'socket-creator');
  const leaver = registerSharedSocket(shared, 'socket-leaver');
  for (const live of [creator, leaver]) {
    Object.assign(live, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
    live.joinedRooms.add('SECRET');
    onlineUsersMap.set(live.id, {
      username: 'alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
      joinedServers: ['global', 'SECRET']
    });
  }
  onlineUsersMap.set('map-only', {
    username: 'ALICE', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [creator, leaver];

  const createAck = acknowledge();
  const createPending = creator.trigger('create_server', 'Team', createAck.callback);
  await grantSaveStarted.promise;

  const arriving = registerSharedSocket(shared, 'socket-arriving');
  Object.assign(arriving, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  arriving.joinedRooms.add('SECRET');
  onlineUsersMap.set(arriving.id, {
    username: 'Alice', displayName: 'Alice', role: 'user', serverCode: 'SECRET',
    joinedServers: ['global', 'SECRET']
  });
  ioInstance.sockets = [creator, leaver, arriving];

  const leaveAck = acknowledge();
  const leavePending = leaver.trigger('leave_server', 'SECRET', leaveAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  const leaveCompletedBeforeGrant = leaveAck.value() !== undefined;
  releaseGrantSave.resolve();
  await Promise.all([createPending, leavePending]);

  assert.equal(leaveCompletedBeforeGrant, false);
  assert.deepEqual(createAck.value(), { success: true, server: createdRoom });
  assert.deepEqual(leaveAck.value(), { success: true });
  assert.deepEqual(persisted.servers, ['global', 'NEW123']);
  for (const live of [creator, leaver, arriving]) {
    assert.deepEqual(live.joinedServers, ['global', 'NEW123']);
    assert.equal(live.serverCode, 'global');
    assert.equal(live.joinedRooms.has('SECRET'), false);
    assert.deepEqual(onlineUsersMap.get(live.id).joinedServers, ['global', 'NEW123']);
  }
  assert.deepEqual(onlineUsersMap.get('map-only').joinedServers, ['global', 'NEW123']);
  assert.equal(onlineUsersMap.get('map-only').serverCode, 'global');
});

test('room deletion serializes against an in-flight membership join', async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  const state = { roomExists: true, persistedServers: ['global'], savedAfterDeletion: false };
  const joinerUser = {
    username: 'bob', role: 'user', servers: ['global'],
    async save() {
      const proposedServers = [...this.servers];
      saveStarted.resolve();
      await releaseSave.promise;
      state.savedAfterDeletion = !state.roomExists;
      state.persistedServers = proposedServers;
    }
  };
  const deleterUser = { username: 'alice', role: 'admin', servers: ['global'] };
  const UserModel = {
    async findOne(query) {
      const matcher = query.username && query.username.$regex;
      return matcher && matcher.test('alice') ? deleterUser : joinerUser;
    },
    async updateMany() {
      state.persistedServers = state.persistedServers.filter(code => code !== 'ABC123');
    }
  };
  const ChatServerModel = {
    async findOne() {
      return state.roomExists ? { code: 'ABC123', owner: 'alice' } : null;
    },
    async deleteOne() { state.roomExists = false; }
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const shared = {
    ioInstance,
    onlineUsersMap,
    UserModel,
    ChatServerModel,
    MessageModel: { async deleteMany() {} },
    logger: { error() {} }
  };
  const joiner = register(shared).socket;
  joiner.id = 'socket-joiner';
  joiner.username = 'bob';
  joiner.serverCode = 'global';
  joiner.joinedServers = ['global'];
  joiner.joinedRooms.add('global');
  onlineUsersMap.set(joiner.id, {
    username: 'bob', serverCode: 'global', joinedServers: ['global']
  });
  const deleter = register(shared).socket;
  deleter.id = 'socket-deleter';
  deleter.username = 'alice';
  deleter.role = 'admin';
  deleter.serverCode = 'global';
  deleter.joinedServers = ['global'];
  onlineUsersMap.set(deleter.id, {
    username: 'alice', role: 'admin', serverCode: 'global', joinedServers: ['global']
  });
  ioInstance.sockets = [joiner, deleter];

  const joinAck = acknowledge();
  const deleteAck = acknowledge();
  const joinPending = joiner.trigger('join_server', 'ABC123', joinAck.callback);
  await saveStarted.promise;
  const deletePending = deleter.trigger('delete_server', 'ABC123', deleteAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseSave.resolve();
  await Promise.all([joinPending, deletePending]);

  assert.equal(state.savedAfterDeletion, false);
  assert.deepEqual(state.persistedServers, ['global']);
  assert.deepEqual(joiner.joinedServers, ['global']);
  assert.equal(joiner.joinedRooms.has('ABC123'), false);
  assert.deepEqual(deleteAck.value(), { success: true });
});

test('deletion preflights sockets then waits for a queued switch account commit', async () => {
  const mutationEntered = deferred();
  const historyEntered = deferred();
  const historyPrepared = deferred();
  const releaseMutation = deferred();
  const deletionFinished = deferred();
  const order = [];
  const state = { roomExists: true, mutationReleased: false, roomReads: 0 };
  const room = { code: 'ABC123', owner: 'alice', moderators: [] };
  const ioInstance = new FakeIo();
  ioInstance.fetchSockets = async () => {
    order.push('delete:fetchSockets');
    return ioInstance.sockets;
  };
  const onlineUsersMap = new Map();
  const ChatServerModel = {
    async findOne() {
      state.roomReads += 1;
      if (state.roomReads === 3 && !state.mutationReleased) {
        await deletionFinished.promise;
        return room;
      }
      return state.roomExists ? room : null;
    },
    async deleteOne() { state.roomExists = false; }
  };
  const MessageModel = {
    async create(data) {
      mutationEntered.resolve();
      await releaseMutation.promise;
      return { _id: 'message-1', ...data };
    },
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        lean() {
          historyEntered.resolve();
          return historyPrepared.promise;
        }
      };
    },
    async deleteMany() {}
  };
  const UserModel = {
    async findOne() { return { username: 'alice', role: 'admin', servers: ['global', 'ABC123'] }; },
    async updateMany() { deletionFinished.resolve(); }
  };
  const shared = {
    ioInstance,
    onlineUsersMap,
    ChatServerModel,
    MessageModel,
    UserModel,
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    broadcastOnlineUsersFn: async () => {},
    logger: { error() {} }
  };
  const holder = registerSharedSocket(shared, 'socket-holder');
  holder.username = 'alice';
  holder.displayName = 'Alice';
  holder.role = 'admin';
  holder.serverCode = 'ABC123';
  holder.joinedServers = ['global', 'ABC123'];
  holder.joinedRooms.add('ABC123');
  const late = registerSharedSocket(shared, 'socket-late');
  late.username = 'bob';
  late.displayName = 'Bob';
  late.role = 'admin';
  late.serverCode = 'global';
  late.joinedServers = ['global'];
  late.joinedRooms.add('global');
  const originalLateJoin = late.join.bind(late);
  late.join = roomCode => {
    if (roomCode === 'ABC123') order.push('late:join:ABC123');
    originalLateJoin(roomCode);
  };
  const deleter = registerSharedSocket(shared, 'socket-deleter');
  deleter.username = 'alice';
  deleter.role = 'admin';
  deleter.serverCode = 'global';
  deleter.joinedServers = ['global'];
  deleter.joinedRooms.add('global');
  for (const live of [holder, late, deleter]) {
    onlineUsersMap.set(live.id, {
      username: live.username,
      role: live.role,
      serverCode: live.serverCode,
      joinedServers: [...live.joinedServers]
    });
  }
  ioInstance.sockets = [holder, late, deleter];

  const mutationPending = holder.trigger('chat_message', { text: 'held mutation' });
  await mutationEntered.promise;
  const switchAck = acknowledge();
  const switchPending = late.trigger('switch_server', 'ABC123', switchAck.callback);
  await historyEntered.promise;
  historyPrepared.resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  const deleteAck = acknowledge();
  const deletePending = deleter.trigger('delete_server', 'ABC123', deleteAck.callback);
  await Promise.resolve();
  await Promise.resolve();
  state.mutationReleased = true;
  releaseMutation.resolve();
  await mutationPending;
  await Promise.all([switchPending, deletePending]);

  const joinIndex = order.indexOf('late:join:ABC123');
  const fetchIndex = order.indexOf('delete:fetchSockets');
  assert.notEqual(joinIndex, -1);
  assert.notEqual(fetchIndex, -1);
  assert.ok(fetchIndex < joinIndex);
  assert.deepEqual(switchAck.value(), {
    history: [], roomRole: 'user',
    restriction: { banned: false, timedOut: false, timeoutUntil: null }
  });
  assert.deepEqual(deleteAck.value(), { success: true });
  assert.equal(late.serverCode, 'global');
  assert.equal(onlineUsersMap.get(late.id).serverCode, 'global');
  assert.equal(late.joinedRooms.has('ABC123'), false);
  assert.equal(late.joinedRooms.has('global'), true);
  assert.equal(late.joinedServers.includes('ABC123'), false);
  assert.equal(onlineUsersMap.get(late.id).joinedServers.includes('ABC123'), false);
});

test('a switch waiting behind deletion cannot join the deleted room', async () => {
  const deleteEntered = deferred();
  const historyEntered = deferred();
  const historyPrepared = deferred();
  const releaseDelete = deferred();
  const state = { roomExists: true };
  const room = { code: 'ABC123', owner: 'alice', moderators: [] };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const ChatServerModel = {
    async findOne() { return state.roomExists ? room : null; },
    async deleteOne() {
      deleteEntered.resolve();
      await releaseDelete.promise;
      state.roomExists = false;
    }
  };
  const MessageModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        lean() {
          historyEntered.resolve();
          return historyPrepared.promise;
        }
      };
    },
    async deleteMany() {}
  };
  const shared = {
    ioInstance,
    onlineUsersMap,
    ChatServerModel,
    MessageModel,
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher && matcher.test('alice')) {
          return { username: 'alice', role: 'admin', servers: ['global'] };
        }
        return { username: 'bob', role: 'user', servers: ['global', 'OLD123', 'ABC123'] };
      },
      async updateMany() {}
    },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    logger: { error() {} }
  };
  const deleter = registerSharedSocket(shared, 'socket-deleter');
  deleter.username = 'alice';
  deleter.role = 'admin';
  deleter.serverCode = 'global';
  deleter.joinedServers = ['global'];
  deleter.joinedRooms.add('global');
  ioInstance.sockets = [deleter];
  const switcher = registerSharedSocket(shared, 'socket-switcher');
  switcher.username = 'bob';
  switcher.role = 'user';
  switcher.serverCode = 'OLD123';
  switcher.joinedServers = ['global', 'OLD123', 'ABC123'];
  switcher.joinedRooms.add('OLD123');
  onlineUsersMap.set(switcher.id, {
    username: 'bob', role: 'user', serverCode: 'OLD123',
    joinedServers: ['global', 'OLD123', 'ABC123']
  });

  const deleteAck = acknowledge();
  const deletePending = deleter.trigger('delete_server', 'ABC123', deleteAck.callback);
  await deleteEntered.promise;
  const switchAck = acknowledge();
  const switchPending = switcher.trigger('switch_server', 'ABC123', switchAck.callback);
  await historyEntered.promise;
  historyPrepared.resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  releaseDelete.resolve();
  await Promise.all([deletePending, switchPending]);

  assert.deepEqual(deleteAck.value(), { success: true });
  assert.deepEqual(switchAck.value(), { error: 'Server not found.' });
  assert.equal(switcher.serverCode, 'OLD123');
  assert.equal(onlineUsersMap.get(switcher.id).serverCode, 'OLD123');
  assert.equal(switcher.joinedRooms.has('OLD123'), true);
  assert.equal(switcher.joinedRooms.has('ABC123'), false);
  assert.deepEqual(switcher.leftRooms, []);
});

test('room deletion clears every session cache before awaiting transport eviction', async () => {
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    ChatServerModel: {
      async findOne() { return { code: 'ABC123', owner: 'alice' }; },
      async deleteOne() {}
    },
    UserModel: { async updateMany() {} },
    MessageModel: { async deleteMany() {} }
  });
  socket.username = 'alice';
  socket.role = 'admin';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];
  socket.joinedRooms.add('ABC123');
  socket.leave = async room => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(socket, room);
  };
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'bob';
  second.serverCode = 'ABC123';
  second.joinedServers = ['global', 'ABC123'];
  second.joinedRooms.add('ABC123');
  for (const live of [socket, second]) {
    onlineUsersMap.set(live.id, {
      username: live.username,
      serverCode: 'ABC123',
      joinedServers: ['global', 'ABC123']
    });
  }
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  const pending = socket.trigger('delete_server', 'ABC123', ack.callback);
  await firstLeaveStarted.promise;
  assert.deepEqual(second.joinedServers, ['global']);
  assert.deepEqual(onlineUsersMap.get(second.id).joinedServers, ['global']);
  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(ack.value(), { success: true });
});

test('global-admin demotion evicts every ghost-viewing session before acknowledgement', async () => {
  const target = {
    username: 'bob', displayName: 'Bob', role: 'admin', servers: ['global'],
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map([
    ['socket-2', { username: 'bob', role: 'admin', serverCode: 'ABC123', joinedServers: ['global'] }],
    ['socket-3', { username: 'bob', role: 'admin', serverCode: 'XYZ789', joinedServers: ['global'] }]
  ]);
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return target; } }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';

  const targetSockets = ['ABC123', 'XYZ789'].map((code, index) => {
    const live = new FakeSocket();
    live.id = `socket-${index + 2}`;
    live.username = 'bob';
    live.role = 'admin';
    live.serverCode = code;
    live.joinedServers = ['global'];
    live.joinedRooms.add(code);
    return live;
  });
  ioInstance.sockets = targetSockets;

  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'demote_global_admin'
  }, ack.callback);

  assert.deepEqual(ack.value(), { success: true });
  for (const live of targetSockets) {
    assert.equal(live.role, 'user');
    assert.equal(live.serverCode, 'global');
    assert.equal(live.joinedRooms.has('global'), true);
    assert.equal(live.leftRooms.length, 1);
    assert.equal(onlineUsersMap.get(live.id).role, 'user');
    assert.equal(onlineUsersMap.get(live.id).serverCode, 'global');
  }
});

test('global-admin demotion stages every session role and fallback before awaiting transport eviction', async () => {
  const firstLeaveStarted = deferred();
  const releaseFirstLeave = deferred();
  const target = {
    username: 'bob', displayName: 'Bob', role: 'admin', servers: ['global'],
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return target; } }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';

  const first = new FakeSocket();
  first.id = 'socket-2';
  first.username = 'bob';
  first.role = 'admin';
  first.serverCode = 'ABC123';
  first.joinedServers = ['global'];
  first.leave = async room => {
    firstLeaveStarted.resolve();
    await releaseFirstLeave.promise;
    FakeSocket.prototype.leave.call(first, room);
  };
  const second = new FakeSocket();
  second.id = 'socket-3';
  second.username = 'bob';
  second.role = 'admin';
  second.serverCode = 'XYZ789';
  second.joinedServers = ['global'];
  for (const live of [first, second]) {
    live.joinedRooms.add(live.serverCode);
    onlineUsersMap.set(live.id, {
      username: 'bob', role: 'admin', serverCode: live.serverCode, joinedServers: ['global']
    });
  }
  ioInstance.sockets = [first, second];

  const ack = acknowledge();
  const pending = socket.trigger('manage_role', {
    targetUser: 'bob', action: 'demote_global_admin'
  }, ack.callback);
  await firstLeaveStarted.promise;
  const stagedBeforeTransport = {
    liveRole: second.role,
    liveServerCode: second.serverCode,
    sessionRole: onlineUsersMap.get(second.id).role,
    sessionServerCode: onlineUsersMap.get(second.id).serverCode
  };
  releaseFirstLeave.resolve();
  await pending;
  assert.deepEqual(stagedBeforeTransport, {
    liveRole: 'user', liveServerCode: 'global',
    sessionRole: 'user', sessionServerCode: 'global'
  });
  assert.deepEqual(ack.value(), { success: true });
});

test('profile updates synchronize identity snapshots across every live session', async () => {
  const user = {
    username: 'alice', displayName: 'Alice', color: '', avatarUrl: '',
    async save() {}
  };
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map([
    ['socket-1', { username: 'alice', displayName: 'Alice', color: '', avatarUrl: '', joinedServers: ['global'] }],
    ['socket-2', { username: 'alice', displayName: 'Alice', color: '', avatarUrl: '', joinedServers: ['global'] }]
  ]);
  const { socket } = register({
    ioInstance,
    onlineUsersMap,
    UserModel: {
      async findOne(query) {
        if (query.displayName) return null;
        return user;
      }
    },
    MessageModel: { async updateMany() {} }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.joinedServers = ['global'];
  const second = new FakeSocket();
  second.id = 'socket-2';
  second.username = 'alice';
  second.displayName = 'Alice';
  second.color = '';
  second.avatarUrl = '';
  second.joinedServers = ['global'];
  ioInstance.sockets = [socket, second];

  const ack = acknowledge();
  await socket.trigger('update_profile', {
    displayName: 'Alice Smith', color: '#aabbcc', avatarUrl: 'https://example.test/alice.png'
  }, ack.callback);

  assert.deepEqual(ack.value(), {
    success: true,
    displayName: 'Alice Smith',
    color: '#aabbcc',
    avatarUrl: 'https://example.test/alice.png'
  });
  for (const live of [socket, second]) {
    assert.equal(live.displayName, 'Alice Smith');
    assert.equal(live.color, '#aabbcc');
    assert.equal(live.avatarUrl, 'https://example.test/alice.png');
    assert.equal(onlineUsersMap.get(live.id).displayName, 'Alice Smith');
  }
});

test('a failed best-effort admin notification acknowledges server creation only once', async () => {
  const user = { servers: ['global'], async save() {} };
  const ioInstance = new FakeIo();
  const logged = [];
  ioInstance.fetchSockets = async () => { throw new Error('notification unavailable'); };
  const { socket } = register({
    ioInstance,
    ChatServerModel: { async create() { return { code: 'ABC123', name: 'Team', owner: 'alice' }; } },
    UserModel: { async findOne() { return user; } },
    logger: { error(...args) { logged.push(args); } }
  });
  socket.username = 'alice';
  const acknowledgements = [];
  await assert.doesNotReject(socket.trigger('create_server', 'Team', value => acknowledgements.push(value)));
  assert.deepEqual(acknowledgements, [{
    success: true,
    server: { code: 'ABC123', name: 'Team', owner: 'alice' }
  }]);
  assert.equal(logged.some(args => JSON.stringify(args).includes('create_server_admin_notification')), true);
  assert.equal(JSON.stringify(logged).includes('notification unavailable'), false);
});

test('server creation normalizes malformed legacy memberships before checking the new room', async () => {
  const user = { username: 'alice', servers: null, async save() {} };
  const { socket } = register({
    UserModel: { async findOne() { return user; } },
    ChatServerModel: {
      async create(value) { return { ...value, code: 'ABC123' }; }
    }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';

  const ack = acknowledge();
  await socket.trigger('create_server', 'Private Room', ack.callback);

  assert.equal(ack.value().success, true);
  assert.deepEqual(user.servers, ['global', 'ABC123']);
});

test('invalid profile values do not write the user record', async () => {
  let lookups = 0;
  const UserModel = { async findOne() { lookups += 1; } };
  const { socket } = register({ UserModel });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  const ack = acknowledge();
  await socket.trigger('update_profile', {
    displayName: 'Alice', color: 'blue', avatarUrl: 'https://example.test/a.png'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Invalid input format.' });
  assert.equal(lookups, 0);
});

test('profile updates reserve the system owner name for every account', async () => {
  let lookups = 0;
  const { socket } = register({
    UserModel: { async findOne() { lookups += 1; } }
  });
  socket.username = 'NYZhang1';
  socket.displayName = 'Bacon';
  const ack = acknowledge();
  await socket.trigger('update_profile', {
    displayName: 'NYZhang1', color: '', avatarUrl: ''
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Reserved name.' });
  assert.equal(lookups, 0);
});

test('promoting a non-member does not write the room moderator list', async () => {
  let roomWrites = 0;
  const actor = { username: 'alice', displayName: 'Alice', role: 'admin', servers: ['global'] };
  const target = { username: 'bob', displayName: 'Bob', servers: ['global'], async save() {} };
  const room = {
    code: 'ABC123', owner: 'alice', moderators: [],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return matcher.test(actor.username) ? actor : target;
        return query.username === actor.username ? actor : target;
      }
    },
    ChatServerModel: { findOne: async () => room }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'admin';
  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'promote_mod', serverCode: 'ABC123'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Target user is not a room member.' });
  assert.equal(roomWrites, 0);
});

test('a stale nonmember moderator cannot promote a current room member', async () => {
  let roomWrites = 0;
  const users = {
    bob: { username: 'bob', displayName: 'Bob', servers: ['global', 'ABC123'] },
    alice: { username: 'alice', displayName: 'Alice', servers: ['global'] }
  };
  const room = {
    code: 'ABC123', owner: 'owner', moderators: ['alice'],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return Object.values(users).find(user => matcher.test(user.username));
        return users[query.username];
      }
    },
    ChatServerModel: { async findOne() { return room; } }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.joinedServers = ['global'];

  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'promote_mod', serverCode: 'ABC123'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(room.moderators, ['alice']);
  assert.equal(roomWrites, 0);
});

test('a timed-out room moderator cannot promote a current room member', async () => {
  let roomWrites = 0;
  const users = {
    alice: { username: 'alice', displayName: 'Alice', role: 'user', servers: ['global', 'ABC123'] },
    bob: { username: 'bob', displayName: 'Bob', role: 'user', servers: ['global', 'ABC123'] }
  };
  const room = {
    code: 'ABC123', owner: 'owner', moderators: ['alice'],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: {
      async findOne(query) {
        const matcher = query.username && query.username.$regex;
        if (matcher) return Object.values(users).find(user => matcher.test(user.username));
        return users[query.username];
      }
    },
    ChatServerModel: { async findOne() { return room; } },
    RoomRestrictionModel: {
      async findOne(query) {
        return query.username === 'alice'
          ? { serverCode: 'ABC123', username: 'alice', timeoutUntil: new Date(Date.now() + 60_000) }
          : null;
      },
      async find() { return []; }
    }
  });
  socket.username = 'alice';
  socket.displayName = 'Alice';
  socket.role = 'user';
  socket.serverCode = 'ABC123';
  socket.joinedServers = ['global', 'ABC123'];

  const ack = acknowledge();
  await socket.trigger('manage_role', {
    targetUser: 'bob', action: 'promote_mod', serverCode: 'ABC123'
  }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Permission denied.' });
  assert.deepEqual(room.moderators, ['alice']);
  assert.equal(roomWrites, 0);
});

for (const scenario of [
  {
    name: 'room deletion',
    mutate(state) { state.room = null; },
    expected: { error: 'Server not found.' }
  },
  {
    name: 'membership removal',
    mutate(_state, socket) { socket.joinedServers = ['global']; },
    expected: { error: 'Permission denied.' }
  },
  {
    name: 'administrator demotion',
    configure(socket) { socket.role = 'admin'; socket.joinedServers = ['global']; },
    mutate(_state, socket) { socket.role = 'user'; },
    expected: { error: 'Permission denied.' }
  }
]) {
  test(`room switch rechecks ${scenario.name} after pending history work`, async () => {
    const history = deferred();
    const historyStarted = deferred();
    const state = { room: { code: 'ABC123', moderators: [] } };
    const ChatServerModel = { async findOne() { return state.room; } };
    const MessageModel = {
      find() {
        return {
          sort() { return this; },
          limit() { return this; },
          async lean() {
            historyStarted.resolve();
            return history.promise;
          }
        };
      }
    };
    const { socket } = register({ ChatServerModel, MessageModel });
    socket.username = 'alice';
    socket.role = 'user';
    socket.joinedServers = ['global', 'ABC123'];
    socket.serverCode = 'global';
    socket.joinedRooms.add('global');
    if (scenario.configure) scenario.configure(socket);

    const ack = acknowledge();
    const pending = socket.trigger('switch_server', 'ABC123', ack.callback);
    await historyStarted.promise;
    scenario.mutate(state, socket);
    history.resolve([]);
    await pending;

    assert.deepEqual(ack.value(), scenario.expected);
    assert.equal(socket.serverCode, 'global');
    assert.equal(socket.joinedRooms.has('ABC123'), false);
    assert.deepEqual(socket.leftRooms, []);
  });
}

test('spoofed forwarded addresses cannot rotate an authentication attempt budget', async () => {
  const { socket } = register();
  socket.handshake.address = '203.0.113.77';
  const results = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    socket.handshake.headers['x-forwarded-for'] = `198.51.100.${attempt}`;
    await socket.trigger('register', {
      username: 'NYZhang1', displayName: 'Owner', password: '123456'
    }, result => results.push(result));
  }
  assert.deepEqual(results.slice(0, 10), Array(10).fill(null).map(() => ({ error: 'Reserved name.' })));
  assert.deepEqual(results[10], { error: 'Too many requests. Try again later.' });
});

test('concurrent registrations allocate case-insensitive identity names only once', async () => {
  const firstCreateStarted = deferred();
  const releaseFirstCreate = deferred();
  const records = [];
  let createCalls = 0;
  const UserModel = {
    async findOne(query) {
      if (query.username && typeof query.username === 'object') {
        return records.find(record => query.username.$regex.test(record.username)) || null;
      }
      if (query.displayName && typeof query.displayName === 'object') {
        return records.find(record => query.displayName.$regex.test(record.displayName)) || null;
      }
      return null;
    },
    async create(value) {
      createCalls += 1;
      if (createCalls === 1) {
        firstCreateStarted.resolve();
        await releaseFirstCreate.promise;
      }
      records.push({ ...value });
      return value;
    }
  };
  const first = register({ UserModel, bcryptImpl: { async hash() { return 'hash'; } } }).socket;
  const second = register({ UserModel, bcryptImpl: { async hash() { return 'hash'; } } }).socket;
  first.handshake.address = '203.0.113.81';
  second.handshake.address = '203.0.113.82';
  const firstAck = acknowledge();
  const secondAck = acknowledge();

  const firstPending = first.trigger('register', {
    username: 'Alice', displayName: 'First', password: '123456'
  }, firstAck.callback);
  await firstCreateStarted.promise;
  const secondPending = second.trigger('register', {
    username: 'alice', displayName: 'Second', password: '123456'
  }, secondAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstCreate.resolve();
  await Promise.all([firstPending, secondPending]);

  assert.equal(records.length, 1);
  assert.deepEqual([firstAck.value(), secondAck.value()], [
    { success: true },
    { error: 'Username taken.' }
  ]);
});

test('concurrent profile changes allocate a display name only once and sync all sessions', async () => {
  const firstSaveStarted = deferred();
  const releaseFirstSave = deferred();
  const records = {
    alice: { username: 'alice', displayName: 'Alice', color: '', avatarUrl: '' },
    bob: { username: 'bob', displayName: 'Bob', color: '', avatarUrl: '' }
  };
  const UserModel = {
    async findOne(query) {
      if (query.displayName && typeof query.displayName === 'object') {
        return Object.values(records).find(record => query.displayName.$regex.test(record.displayName)) || null;
      }
      const record = records[query.username];
      if (!record) return null;
      return {
        ...record,
        async save() {
          if (query.username === 'alice') {
            firstSaveStarted.resolve();
            await releaseFirstSave.promise;
          }
          records[query.username] = {
            username: query.username,
            displayName: this.displayName,
            color: this.color,
            avatarUrl: this.avatarUrl
          };
        }
      };
    }
  };
  const MessageModel = { async updateMany() {} };
  const aliceIo = new FakeIo();
  const bobIo = new FakeIo();
  const alice = register({ UserModel, MessageModel, ioInstance: aliceIo }).socket;
  const bob = register({ UserModel, MessageModel, ioInstance: bobIo }).socket;
  Object.assign(alice, { username: 'alice', displayName: 'Alice', joinedServers: ['global'] });
  Object.assign(bob, { username: 'bob', displayName: 'Bob', joinedServers: ['global'] });
  aliceIo.sockets = [alice];
  bobIo.sockets = [bob];
  const aliceAck = acknowledge();
  const bobAck = acknowledge();

  const alicePending = alice.trigger('update_profile', {
    displayName: 'Shared', color: '#112233', avatarUrl: ''
  }, aliceAck.callback);
  await firstSaveStarted.promise;
  const bobPending = bob.trigger('update_profile', {
    displayName: 'shared', color: '#445566', avatarUrl: ''
  }, bobAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstSave.resolve();
  await Promise.all([alicePending, bobPending]);

  assert.equal(Object.values(records).filter(record => record.displayName.toLowerCase() === 'shared').length, 1);
  assert.deepEqual(aliceAck.value(), {
    success: true, displayName: 'Shared', color: '#112233', avatarUrl: ''
  });
  assert.deepEqual(bobAck.value(), { error: 'Display Name is already taken.' });
});

test('identity mutation lock releases after a failed registration', async () => {
  let shouldFail = true;
  const UserModel = {
    async findOne() {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('lookup failed');
      }
      return null;
    },
    async create() {}
  };
  const { socket } = register({
    UserModel,
    bcryptImpl: { async hash() { return 'hash'; } },
    logger: { error() {} }
  });
  socket.handshake.address = '203.0.113.83';
  const firstAck = acknowledge();
  const secondAck = acknowledge();
  await socket.trigger('register', {
    username: 'alice', displayName: 'Alice', password: '123456'
  }, firstAck.callback);
  await socket.trigger('register', {
    username: 'alice', displayName: 'Alice', password: '123456'
  }, secondAck.callback);
  assert.deepEqual(firstAck.value(), { error: 'Registration failed.' });
  assert.deepEqual(secondAck.value(), { success: true });
});

test('registration rejects case-insensitive username collisions', async () => {
  const calls = [];
  const { socket } = register({
    UserModel: {
      findOne(query) { calls.push(query); return queryResult({ username: 'Alice' }); },
      async create() { throw new Error('must not create'); }
    }
  });
  const ack = acknowledge();
  await socket.trigger('register', {
    username: 'alice', displayName: 'New Name', password: '123456'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Username taken.' });
  assert.equal(calls.length, 1);
});

test('registration rejects case-insensitive display-name collisions independently', async () => {
  const calls = [];
  const { socket } = register({
    UserModel: {
      findOne(query) {
        calls.push(query);
        return queryResult(calls.length === 1 ? null : { displayName: 'DISPLAY NAME' });
      },
      async create() { throw new Error('must not create'); }
    }
  });
  const ack = acknowledge();
  await socket.trigger('register', {
    username: 'alice', displayName: 'display name', password: '123456'
  }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Display Name is already taken.' });
  assert.equal(calls.length, 2);
});

test('seedSystem creates the global room without an administrator password', async () => {
  const roomUpdates = [];
  let userLookups = 0;
  await seedSystem({
    UserModel: { async findOne() { userLookups += 1; } },
    ChatServerModel: { async findOneAndUpdate(...args) { roomUpdates.push(args); } },
    adminPassword: ''
  });
  assert.deepEqual(roomUpdates, [[
    { code: 'global' },
    { $setOnInsert: { code: 'global', name: 'Global Chat', owner: 'System', moderators: [] } },
    { upsert: true, setDefaultsOnInsert: true }
  ]]);
  assert.equal(userLookups, 0);
});

test('unexpected handler failures log only event-specific safe metadata', async () => {
  const logged = [];
  const secret = 'password=do-not-log';
  const { socket } = register({
    logger: { error(...args) { logged.push(args); } },
    ChatServerModel: { async findOne() { throw new Error(secret); } }
  });
  socket.username = 'alice';
  const ack = acknowledge();
  await socket.trigger('join_server', 'ABC123', ack.callback);

  assert.deepEqual(ack.value(), { error: 'Join failed.' });
  assert.equal(logged.length, 1);
  assert.equal(JSON.stringify(logged).includes('join_server'), true);
  assert.equal(JSON.stringify(logged).includes(secret), false);
});

test('malformed acknowledgement inputs use the standard protocol error', async () => {
  const { socket } = register();
  socket.username = 'alice';
  socket.displayName = 'Alice';
  const cases = [
    ['change_password', [null]],
    ['update_profile', [{ displayName: '<bad>', color: '', avatarUrl: '' }]],
    ['manage_role', [null]],
    ['create_server', ['<bad>']],
    ['join_server', ['<bad>']],
    ['leave_server', ['<bad>']],
    ['delete_server', ['<bad>']],
    ['switch_server', ['<bad>']],
    ['get_edit_history', ['not-an-id']],
    ['get_deleted_message', ['not-an-id']]
  ];

  for (const [event, args] of cases) {
    const ack = acknowledge();
    await socket.trigger(event, ...args, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid input format.' }, event);
  }
});

const acknowledgementEvents = [
  ['register', [null]],
  ['login', [null]],
  ['change_password', [null]],
  ['logout_all_devices', []],
  ['update_profile', [null]],
  ['manage_role', [null]],
  ['create_server', [null]],
  ['join_server', [null]],
  ['leave_server', [null]],
  ['delete_server', [null]],
  ['switch_server', [null]],
  ['get_edit_history', [null]],
  ['get_deleted_message', [null]]
];

for (const [event, args] of acknowledgementEvents) {
  test(`${event} tolerates an omitted acknowledgement callback`, async () => {
    const { socket } = register();
    await assert.doesNotReject(socket.trigger(event, ...args));
  });
}
