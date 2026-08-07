const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnectionHandler, seedSystem } = require('../server');
const { FakeSocket, FakeIo, queryResult, acknowledge } = require('./support/fakes');

function register(overrides = {}) {
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
    broadcastOnlineUsersFn: async code => broadcasts.push(code)
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
  assert.deepEqual(ack.value(), { history: [], roomRole: 'user' });
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

test('a failed best-effort admin notification acknowledges server creation only once', async () => {
  const user = { servers: ['global'], async save() {} };
  const ioInstance = new FakeIo();
  ioInstance.fetchSockets = async () => { throw new Error('notification unavailable'); };
  const { socket } = register({
    ioInstance,
    ChatServerModel: { async create() { return { code: 'ABC123', name: 'Team', owner: 'alice' }; } },
    UserModel: { async findOne() { return user; } }
  });
  socket.username = 'alice';
  const acknowledgements = [];
  await assert.doesNotReject(socket.trigger('create_server', 'Team', value => acknowledgements.push(value)));
  assert.deepEqual(acknowledgements, [{
    success: true,
    server: { code: 'ABC123', name: 'Team', owner: 'alice' }
  }]);
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
  assert.deepEqual(ack.value(), { error: 'Invalid profile data.' });
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
  const target = { username: 'bob', displayName: 'Bob', servers: ['global'], async save() {} };
  const room = {
    code: 'ABC123', owner: 'alice', moderators: [],
    async save() { roomWrites += 1; }
  };
  const { socket } = register({
    UserModel: { findOne: async () => target },
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
