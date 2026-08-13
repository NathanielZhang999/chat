const test = require('node:test');
const assert = require('node:assert/strict');
const {
  bcryptCost,
  createConnectionAdmission,
  createConnectionHandler,
  createDummyPasswordHash,
  createInFlightRequestCoordinator,
  createLayeredAuthLimiter,
  createSocketEventDispatcher,
  hashNetworkAddress,
  seedSystem,
  withAccountTransitionLock
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

function createAuthUserModel(records, events = []) {
  let reads = 0;
  return {
    async findOne(query) {
      const matcher = query && query.username && query.username.$regex;
      const record = [...records.values()].find(candidate => matcher && matcher.test(candidate.username));
      if (!record) return null;
      reads += 1;
      if (reads > 1) events.push('locked reload');
      return {
        ...record,
        servers: [...record.servers],
        async save() {
          events.push('save');
          records.set(record.username.toLowerCase(), {
            ...record,
            ...this,
            servers: [...this.servers],
            save: undefined
          });
        }
      };
    }
  };
}

function registerAuthenticationSocket({
  id = 'auth-socket',
  address = '203.0.113.10',
  authLimiter = createLayeredAuthLimiter({ salt: 'handler-test-salt' }),
  dummyPasswordHash = '$2b$11$dummy-password-hash',
  passwordHashCost = 11,
  ...overrides
} = {}) {
  const socket = register({ authLimiter, dummyPasswordHash, passwordHashCost, ...overrides }).socket;
  socket.id = id;
  socket.handshake.address = address;
  return socket;
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

test('login rejects replacing an authenticated socket identity', async () => {
  const { socket } = register();
  socket.username = 'alice';
  const ack = acknowledge();
  await socket.trigger('login', { username: 'bob', password: '123456' }, ack.callback);
  assert.deepEqual(ack.value(), { error: 'Already authenticated.' });
  assert.equal(socket.username, 'alice');
});

test('unknown and wrong-password login share one error and one comparison boundary', async () => {
  const comparisons = [];
  const bcryptImpl = {
    async compare(password, hash) {
      comparisons.push([password, hash]);
      return false;
    },
    getRounds() { return 11; },
    async hash() { throw new Error('must not hash'); }
  };
  const authLimiter = createLayeredAuthLimiter({ salt: 'generic-login-test-salt' });
  const records = new Map([['known', {
    username: 'known', displayName: 'Known', password: '$2b$11$known-hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global']
  }]]);
  const UserModel = createAuthUserModel(records);
  const unknown = registerAuthenticationSocket({
    id: 'unknown-login', address: '203.0.113.11', authLimiter, UserModel, bcryptImpl
  });
  const wrong = registerAuthenticationSocket({
    id: 'wrong-login', address: '203.0.113.12', authLimiter, UserModel, bcryptImpl
  });
  const unknownAck = acknowledge();
  const wrongAck = acknowledge();

  await unknown.trigger('login', { username: 'missing', password: 'secret-one' }, unknownAck.callback);
  await wrong.trigger('login', { username: 'known', password: 'secret-two' }, wrongAck.callback);

  assert.deepEqual(unknownAck.value(), { error: 'Invalid username or password.' });
  assert.deepEqual(wrongAck.value(), { error: 'Invalid username or password.' });
  assert.deepEqual(comparisons, [
    ['secret-one', '$2b$11$dummy-password-hash'],
    ['secret-two', '$2b$11$known-hash']
  ]);
});

test('successful legacy bcrypt login upgrades to cost eleven before acknowledgement', async () => {
  const events = [];
  const records = new Map([['alice', {
    username: 'Alice', displayName: 'Alice', password: '$2b$10$legacy-hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global']
  }]]);
  const UserModel = createAuthUserModel(records, events);
  let comparisons = 0;
  const bcryptImpl = {
    async compare(password, hash) {
      comparisons += 1;
      events.push(comparisons === 1 ? 'compare' : 'locked compare');
      return password === 'correct-password' && hash === '$2b$10$legacy-hash';
    },
    getRounds(hash) {
      events.push('getRounds');
      assert.equal(hash, '$2b$10$legacy-hash');
      return 10;
    },
    async hash(password, cost) {
      events.push(`hash(${cost})`);
      assert.equal(password, 'correct-password');
      return '$2b$11$upgraded-hash';
    }
  };
  const onlineUsersMap = new Map();
  const setSession = onlineUsersMap.set.bind(onlineUsersMap);
  onlineUsersMap.set = (key, value) => {
    events.push('session publication');
    return setSession(key, value);
  };
  const socket = registerAuthenticationSocket({ UserModel, bcryptImpl, onlineUsersMap });
  const ack = acknowledge();

  await socket.trigger('login', { username: 'alice', password: 'correct-password' }, value => {
    events.push('ack');
    ack.callback(value);
  });

  assert.equal(ack.value().success, true);
  assert.equal(records.get('alice').password, '$2b$11$upgraded-hash');
  assert.deepEqual(events, [
    'compare',
    'locked reload',
    'locked compare',
    'getRounds',
    'hash(11)',
    'save',
    'session publication',
    'ack'
  ]);
});

test('current and stronger bcrypt hashes are not rewritten', async () => {
  for (const cost of [11, 12]) {
    let hashCalls = 0;
    let saveCalls = 0;
    const user = {
      username: `User${cost}`, displayName: `User ${cost}`, password: `$2b$${cost}$current-hash`,
      role: 'user', color: '', avatarUrl: '', servers: ['global'],
      async save() { saveCalls += 1; }
    };
    const UserModel = { async findOne() { return user; } };
    const bcryptImpl = {
      async compare() { return true; },
      getRounds() { return cost; },
      async hash() { hashCalls += 1; return 'unexpected'; }
    };
    const socket = registerAuthenticationSocket({
      id: `cost-${cost}`, address: `203.0.113.${cost}`, UserModel, bcryptImpl
    });
    const ack = acknowledge();

    await socket.trigger('login', {
      username: `User${cost}`, password: 'correct-password'
    }, ack.callback);

    assert.equal(ack.value().success, true, `cost ${cost}`);
    assert.equal(hashCalls, 0, `cost ${cost}`);
    assert.equal(saveCalls, 0, `cost ${cost}`);
    assert.equal(user.password, `$2b$${cost}$current-hash`, `cost ${cost}`);
  }
});

test('bcrypt migration failure publishes no authenticated state', async () => {
  for (const failure of ['cost', 'hash', 'save']) {
    const onlineUsersMap = new Map();
    const broadcasts = [];
    const user = {
      username: 'Alice', displayName: 'Alice', password: '$2b$10$legacy-hash', role: 'user',
      color: '', avatarUrl: '', servers: ['global'],
      async save() {
        if (failure === 'save') throw new Error('migration save failed');
      }
    };
    const bcryptImpl = {
      async compare() { return true; },
      getRounds() {
        if (failure === 'cost') throw new Error('unreadable password hash');
        return 10;
      },
      async hash() {
        if (failure === 'hash') throw new Error('migration hash failed');
        return '$2b$11$upgraded-hash';
      }
    };
    const socket = registerAuthenticationSocket({
      id: `migration-${failure}`,
      address: failure === 'cost'
        ? '203.0.113.20'
        : (failure === 'hash' ? '203.0.113.21' : '203.0.113.22'),
      UserModel: { async findOne() { return user; } },
      bcryptImpl,
      onlineUsersMap,
      broadcastOnlineUsersFn: code => broadcasts.push(code),
      logger: { error() {} }
    });
    const ack = acknowledge();

    await socket.trigger('login', { username: 'alice', password: 'correct-password' }, ack.callback);

    assert.deepEqual(ack.value(), { error: 'Login failed.' }, failure);
    assert.equal(socket.username, undefined, failure);
    assert.equal(socket.serverCode, null, failure);
    assert.deepEqual(socket.joinedServers, [], failure);
    assert.equal(socket.joinedRooms.size, 0, failure);
    assert.equal(onlineUsersMap.size, 0, failure);
    assert.deepEqual(broadcasts, [], failure);
  }
});

test('password change cannot be overwritten by concurrent legacy bcrypt login migration', async () => {
  const migrationHashStarted = deferred();
  const releaseMigrationHash = deferred();
  const persisted = {
    username: 'Alice', displayName: 'Alice', password: '$2b$10$legacy-hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global']
  };
  const UserModel = {
    async findOne(query) {
      const matcher = query && query.username && query.username.$regex;
      if (!(matcher ? matcher.test(persisted.username) : query.username === persisted.username)) return null;
      return {
        ...persisted,
        servers: [...persisted.servers],
        async save() {
          Object.assign(persisted, this, { servers: [...this.servers], save: undefined });
        }
      };
    }
  };
  const bcryptImpl = {
    async compare(password, hash) {
      if (password !== 'old-password') return false;
      return hash === '$2b$10$legacy-hash' || hash === '$2b$11$upgraded-old-password';
    },
    getRounds(hash) {
      return hash === '$2b$10$legacy-hash' ? 10 : 11;
    },
    async hash(password, cost) {
      assert.equal(cost, 11);
      if (password === 'old-password') {
        migrationHashStarted.resolve();
        await releaseMigrationHash.promise;
        return '$2b$11$upgraded-old-password';
      }
      assert.equal(password, 'new-password');
      return '$2b$11$new-password';
    }
  };
  const loginSocket = registerAuthenticationSocket({
    id: 'legacy-login', address: '203.0.113.23', UserModel, bcryptImpl
  });
  const passwordSocket = register({
    UserModel,
    bcryptImpl,
    rateLimiter: { check() { return true; }, clear() {} }
  }).socket;
  passwordSocket.id = 'password-change';
  passwordSocket.username = 'Alice';
  const loginAck = acknowledge();
  const passwordAck = acknowledge();

  const loginPending = loginSocket.trigger('login', {
    username: 'alice', password: 'old-password'
  }, loginAck.callback);
  await migrationHashStarted.promise;
  const passwordPending = passwordSocket.trigger('change_password', {
    oldPassword: 'old-password', newPassword: 'new-password'
  }, passwordAck.callback);
  await new Promise(resolve => setImmediate(resolve));
  releaseMigrationHash.resolve();
  await Promise.all([loginPending, passwordPending]);

  assert.equal(loginAck.value().success, true);
  assert.deepEqual(passwordAck.value(), { success: true });
  assert.equal(persisted.password, '$2b$11$new-password');
});

test('shared networks allow many valid accounts while isolating one attacked account', async () => {
  const authLimiter = createLayeredAuthLimiter({ salt: 'shared-network-test-salt' });
  const records = new Map();
  for (let index = 0; index < 42; index += 1) {
    const username = `user${index}`;
    records.set(username, {
      username, displayName: `User ${index}`, password: `$2b$11$${username}-hash`, role: 'user',
      color: '', avatarUrl: '', servers: ['global']
    });
  }
  const UserModel = createAuthUserModel(records);
  const bcryptImpl = {
    async compare(password) { return password === 'valid-password'; },
    getRounds() { return 11; },
    async hash() { throw new Error('must not hash'); }
  };
  const address = '198.51.100.40';

  for (let index = 0; index < 40; index += 1) {
    const socket = registerAuthenticationSocket({
      id: `shared-valid-${index}`, address, authLimiter, UserModel, bcryptImpl
    });
    const ack = acknowledge();
    await socket.trigger('login', {
      username: `user${index}`, password: 'valid-password'
    }, ack.callback);
    assert.equal(ack.value().success, true, `valid shared-network account ${index}`);
  }

  const attackedResults = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const socket = registerAuthenticationSocket({
      id: `attacked-${attempt}`, address, authLimiter, UserModel, bcryptImpl
    });
    await socket.trigger('login', {
      username: 'user40', password: 'wrong-password'
    }, result => attackedResults.push(result));
  }
  assert.deepEqual(attackedResults.slice(0, 6), Array.from({ length: 6 }, () => ({
    error: 'Invalid username or password.'
  })));
  assert.deepEqual(attackedResults[6], { error: 'Too many requests. Try again later.' });

  const unaffected = registerAuthenticationSocket({
    id: 'shared-unaffected', address, authLimiter, UserModel, bcryptImpl
  });
  const unaffectedAck = acknowledge();
  await unaffected.trigger('login', {
    username: 'user41', password: 'valid-password'
  }, unaffectedAck.callback);
  assert.equal(unaffectedAck.value().success, true);
});

test('eight existing account sessions allow no ninth authenticated socket', async () => {
  const address = '198.51.100.120';
  const ioInstance = new FakeIo();
  ioInstance.sockets = Array.from({ length: 8 }, (_, index) => {
    const live = new FakeSocket();
    live.id = `existing-alice-${index}`;
    live.username = index % 2 === 0 ? 'Alice' : 'alice';
    live.handshake.address = address;
    return live;
  });
  const onlineUsersMap = new Map(ioInstance.sockets.map(live => [live.id, {
    username: live.username,
    serverCode: 'global',
    joinedServers: ['global']
  }]));
  let roomReads = 0;
  const user = {
    username: 'Alice', displayName: 'Alice', password: '$2b$11$current-hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global']
  };
  const socket = registerAuthenticationSocket({
    id: 'ninth-alice',
    address,
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return user; } },
    ChatServerModel: {
      async find() { roomReads += 1; return [{ code: 'global', moderators: [] }]; },
      async findOne() { return null; }
    },
    bcryptImpl: {
      async compare() { return true; },
      getRounds() { return 11; },
      async hash() { throw new Error('must not hash'); }
    }
  });
  const ack = acknowledge();

  await socket.trigger('login', { username: 'alice', password: 'correct-password' }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Too many active sessions.' });
  assert.equal(socket.username, undefined);
  assert.equal(socket.serverCode, null);
  assert.deepEqual(socket.joinedServers, []);
  assert.equal(socket.joinedRooms.size, 0);
  assert.equal(onlineUsersMap.size, 8);
  assert.equal(roomReads, 0);
});

test('distinct accounts on one network remain independent below the emergency ceiling', async () => {
  const address = '198.51.100.121';
  const connectionAdmission = createConnectionAdmission({ salt: 'shared-network-session-ceiling' });
  const ioInstance = new FakeIo();
  ioInstance.sockets = Array.from({ length: 8 }, (_, index) => {
    const live = new FakeSocket();
    live.id = `shared-network-alice-${index}`;
    live.username = 'Alice';
    live.handshake.address = address;
    const admission = connectionAdmission.open(live);
    assert.equal(admission.allowed, true);
    return live;
  });
  const onlineUsersMap = new Map(ioInstance.sockets.map(live => [live.id, {
    username: live.username,
    serverCode: 'global',
    joinedServers: ['global']
  }]));
  const bob = {
    username: 'Bob', displayName: 'Bob', password: '$2b$11$current-hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global']
  };
  const socket = new FakeSocket();
  socket.id = 'shared-network-bob';
  socket.handshake.address = address;
  createConnectionHandler({
    connectionAdmission,
    ioInstance,
    onlineUsersMap,
    UserModel: { async findOne() { return bob; } },
    ChatServerModel: {
      async find() { return [{ code: 'global', moderators: [] }]; },
      async findOne() { return null; }
    },
    RoomRestrictionModel: { async findOne() { return null; }, async find() { return []; } },
    broadcastOnlineUsersFn: async () => {},
    getRoomRoleFn: async () => 'user',
    resolvePingsFn: async text => text,
    bcryptImpl: {
      async compare() { return true; },
      getRounds() { return 11; },
      async hash() { throw new Error('must not hash'); }
    }
  })(socket);
  const ack = acknowledge();

  await socket.trigger('login', { username: 'bob', password: 'correct-password' }, ack.callback);

  assert.equal(ack.value().success, true);
  assert.equal(socket.username, 'Bob');
  assert.equal(onlineUsersMap.size, 9);
  assert.equal(
    connectionAdmission.concurrent(hashNetworkAddress(address, 'shared-network-session-ceiling')),
    9
  );
});

test('one successful account does not reset aggregate network abuse state', async () => {
  const authLimiter = createLayeredAuthLimiter({
    salt: 'aggregate-network-test-salt',
    policies: {
      login: { account: 30, pair: 6, network: 3 },
      register: { account: 20, pair: 6, network: 300 }
    }
  });
  const records = new Map();
  for (const username of ['first', 'second', 'successful', 'blocked']) {
    records.set(username, {
      username, displayName: username, password: `$2b$11$${username}-hash`, role: 'user',
      color: '', avatarUrl: '', servers: ['global']
    });
  }
  const UserModel = createAuthUserModel(records);
  const bcryptImpl = {
    async compare(password) { return password === 'valid-password'; },
    getRounds() { return 11; },
    async hash() { throw new Error('must not hash'); }
  };
  const address = '192.0.2.88';

  for (const username of ['first', 'second']) {
    const socket = registerAuthenticationSocket({ id: username, address, authLimiter, UserModel, bcryptImpl });
    const ack = acknowledge();
    await socket.trigger('login', { username, password: 'wrong-password' }, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid username or password.' });
  }

  const successful = registerAuthenticationSocket({
    id: 'successful', address, authLimiter, UserModel, bcryptImpl
  });
  const successfulAck = acknowledge();
  await successful.trigger('login', {
    username: 'successful', password: 'valid-password'
  }, successfulAck.callback);
  assert.equal(successfulAck.value().success, true);
  const networkBucket = hashNetworkAddress(address, 'aggregate-network-test-salt');
  assert.equal(authLimiter.count('login:account:successful'), 0);
  assert.equal(authLimiter.count(`login:pair:successful:${networkBucket}`), 0);
  assert.equal(authLimiter.count(`login:network:${networkBucket}`), 3);

  const blocked = registerAuthenticationSocket({ id: 'blocked', address, authLimiter, UserModel, bcryptImpl });
  const blockedAck = acknowledge();
  await blocked.trigger('login', {
    username: 'blocked', password: 'valid-password'
  }, blockedAck.callback);
  assert.deepEqual(blockedAck.value(), { error: 'Too many requests. Try again later.' });
});

test('authentication acknowledgements and logs redact passwords hashes and raw network addresses', async () => {
  const password = 'password=AUTH_PASSWORD_SENTINEL';
  const passwordHash = '$2b$10$AUTH_HASH_SENTINEL';
  const address = '203.0.113.99';
  const logged = [];
  const user = {
    username: 'Alice', displayName: 'Alice', password: passwordHash, role: 'user',
    color: '', avatarUrl: '', servers: ['global'], async save() {}
  };
  const socket = registerAuthenticationSocket({
    address,
    UserModel: { async findOne() { return user; } },
    bcryptImpl: {
      async compare() { return true; },
      getRounds() { return 10; },
      async hash() { throw new Error(`${password} ${passwordHash} ${address}`); }
    },
    logger: { error(...args) { logged.push(args); } }
  });
  const ack = acknowledge();

  await socket.trigger('login', { username: 'alice', password }, ack.callback);

  assert.deepEqual(ack.value(), { error: 'Login failed.' });
  const published = JSON.stringify({ acknowledgement: ack.value(), logged, outbound: socket.outbound });
  for (const secret of [password, passwordHash, address]) {
    assert.equal(published.includes(secret), false, secret);
  }

  let passwordChangeRateKey;
  const passwordChangeSocket = register({
    UserModel: { async findOne() { return { password: passwordHash, async save() {} }; } },
    bcryptImpl: {
      async compare() { return true; },
      async hash() { return '$2b$11$changed-hash'; }
    },
    rateLimiter: {
      check(key) { passwordChangeRateKey = key; return true; },
      clear() {}
    }
  }).socket;
  passwordChangeSocket.username = 'alice';
  passwordChangeSocket.handshake.address = address;
  const passwordChangeAck = acknowledge();
  await passwordChangeSocket.trigger('change_password', {
    oldPassword: password,
    newPassword: 'replacement-password'
  }, passwordChangeAck.callback);
  assert.deepEqual(passwordChangeAck.value(), { success: true });
  assert.equal(passwordChangeRateKey.includes(address), false);
});

test('bcrypt helpers validate costs and construct one requested-cost dummy hash', async () => {
  assert.equal(bcryptCost('$2b$11$hash', { getRounds() { return 11; } }), 11);
  assert.equal(bcryptCost('$2b$11$hash', { getRounds() { return -1; } }), null);
  assert.equal(bcryptCost('$2b$11$hash', { getRounds() { throw new Error('bad hash'); } }), null);

  const calls = [];
  const dummyHash = await createDummyPasswordHash({
    bcryptImpl: {
      async hash(password, cost) {
        calls.push([password, cost]);
        return '$2b$11$dummy';
      }
    },
    cost: 11
  });
  assert.equal(dummyHash, '$2b$11$dummy');
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0][0], 'string');
  assert.equal(calls[0][0].length >= 32, true);
  assert.equal(calls[0][1], 11);
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
    },
    getRounds() { return 11; }
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
    },
    getRounds() { return 11; }
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
    },
    getRounds() { return 11; }
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

test('room switch acknowledges success before broadcasting target presence', async () => {
  const events = [];
  const onlineUsersMap = new Map([['socket-1', {
    username: 'alice', serverCode: 'OLD123', joinedServers: ['global', 'OLD123', 'ABC123']
  }]]);
  const ChatServerModel = { findOne: () => queryResult({ code: 'ABC123', moderators: [] }) };
  const MessageModel = { find: () => queryResult([]) };
  const { socket } = register({
    ChatServerModel,
    MessageModel,
    onlineUsersMap,
    broadcastOnlineUsersFn: code => events.push(`broadcast:${code}`)
  });
  socket.username = 'alice';
  socket.role = 'user';
  socket.joinedServers = ['global', 'OLD123', 'ABC123'];
  socket.serverCode = 'OLD123';
  socket.joinedRooms.add('OLD123');

  await socket.trigger('switch_server', 'ABC123', result => {
    events.push('ack');
    assert.deepEqual(result, {
      history: [], roomRole: 'user',
      restriction: { banned: false, timedOut: false, timeoutUntil: null }
    });
  });

  assert.equal(socket.serverCode, 'ABC123');
  assert.equal(socket.joinedRooms.has('OLD123'), false);
  assert.equal(socket.joinedRooms.has('ABC123'), true);
  assert.equal(onlineUsersMap.get('socket-1').serverCode, 'ABC123');
  assert.deepEqual(events, [
    'ack', 'broadcast:OLD123', 'broadcast:ABC123', 'broadcast:global'
  ]);
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
  const { socket } = register({
    authLimiter: createLayeredAuthLimiter({ salt: 'spoofed-forwarded-test-salt' })
  });
  socket.handshake.address = '203.0.113.77';
  const results = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    socket.handshake.headers['x-forwarded-for'] = `198.51.100.${attempt}`;
    await socket.trigger('register', {
      username: 'NYZhang1', displayName: 'Owner', password: '123456'
    }, result => results.push(result));
  }
  assert.deepEqual(results.slice(0, 6), Array(6).fill(null).map(() => ({ error: 'Reserved name.' })));
  assert.deepEqual(results[6], { error: 'Too many requests. Try again later.' });
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
  const hashCalls = [];
  const bcryptImpl = {
    async hash(password, cost) {
      hashCalls.push([password, cost]);
      return 'hash';
    }
  };
  const first = register({ UserModel, bcryptImpl }).socket;
  const second = register({ UserModel, bcryptImpl }).socket;
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
  assert.deepEqual(hashCalls, [['123456', 11]]);
  assert.deepEqual([firstAck.value(), secondAck.value()], [
    {
      success: true,
      preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
      preferencesVersion: 0
    },
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
  assert.deepEqual(secondAck.value(), {
    success: true,
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
    preferencesVersion: 0
  });
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

test('security failures disclose no credential payload attachment or network sentinels', async (t) => {
  await t.test('registered login matrix enforces pair account and network layers before model work', async () => {
    const dimensions = ['pair', 'account', 'network'];
    const boundaries = ['below', 'at'];
    const accountKinds = ['unknown', 'existing'];
    const passwordKinds = ['correct', 'wrong'];
    let rowNumber = 0;

    for (const dimension of dimensions) {
      for (const boundary of boundaries) {
        for (const accountKind of accountKinds) {
          for (const passwordKind of passwordKinds) {
            rowNumber += 1;
            const username = `${accountKind === 'existing' ? 'user' : 'missing'}${rowNumber}`;
            const address = '198.51.100.180';
            const storedHash = `$2b$11$matrix-${rowNumber}-hash`;
            const dummyHash = `$2b$11$matrix-${rowNumber}-dummy`;
            const policies = {
              login: {
                account: dimension === 'account' ? 2 : 100,
                pair: dimension === 'pair' ? 2 : 100,
                network: dimension === 'network' ? 2 : 100
              },
              register: { account: 20, pair: 6, network: 300 }
            };
            const authLimiter = createLayeredAuthLimiter({
              salt: `login-matrix-${rowNumber}`,
              policies
            });
            const prefills = boundary === 'below' ? 1 : 2;
            for (let index = 0; index < prefills; index += 1) {
              const prefill = authLimiter.attempt({
                action: 'login',
                account: dimension === 'network' ? `prefill-${rowNumber}-${index}` : username,
                address: dimension === 'account' ? `192.0.2.${index + 1}` : address
              });
              assert.equal(prefill.allowed, true, `${dimension} ${boundary} prefill ${index + 1}`);
            }

            let modelQueries = 0;
            let writes = 0;
            let broadcasts = 0;
            const comparisons = [];
            const user = {
              username,
              displayName: username,
              password: storedHash,
              role: 'user',
              color: '',
              avatarUrl: '',
              servers: ['global'],
              preferencesVersion: 0,
              async save() { writes += 1; }
            };
            const UserModel = {
              async findOne(query) {
                modelQueries += 1;
                const matcher = query && query.username && query.username.$regex;
                return accountKind === 'existing' && matcher && matcher.test(username) ? user : null;
              }
            };
            const ChatServerModel = {
              async find() {
                modelQueries += 1;
                return [{ code: 'global', moderators: [] }];
              },
              async findOne() {
                modelQueries += 1;
                return null;
              }
            };
            const RoomRestrictionModel = {
              async find() { modelQueries += 1; return []; },
              async findOne() { modelQueries += 1; return null; }
            };
            const bcryptImpl = {
              async compare(password, hash) {
                comparisons.push([password, hash]);
                return accountKind === 'existing' && passwordKind === 'correct' &&
                  password === 'correct-password' && hash === storedHash;
              },
              getRounds() { return 11; },
              async hash() { writes += 1; return '$2b$11$unexpected'; }
            };
            const socket = registerAuthenticationSocket({
              id: `login-matrix-${rowNumber}`,
              address,
              authLimiter,
              dummyPasswordHash: dummyHash,
              UserModel,
              ChatServerModel,
              RoomRestrictionModel,
              bcryptImpl,
              broadcastOnlineUsersFn() { broadcasts += 1; }
            });
            const ack = acknowledge();
            await socket.trigger('login', {
              username,
              password: passwordKind === 'correct' ? 'correct-password' : 'wrong-password'
            }, ack.callback);
            const label = `${dimension} ${boundary} ${accountKind} ${passwordKind}`;

            if (boundary === 'at') {
              assert.deepEqual(ack.value(), { error: 'Too many requests. Try again later.' }, label);
              assert.equal(modelQueries, 0, label);
              assert.equal(comparisons.length, 0, label);
              assert.equal(writes, 0, label);
              assert.equal(broadcasts, 0, label);
              assert.deepEqual(socket.outbound, [], label);
              continue;
            }

            assert.equal(modelQueries > 0, true, label);
            assert.equal(comparisons.length > 0, true, label);
            if (accountKind === 'unknown') {
              assert.equal(comparisons[0][1], dummyHash, label);
            } else {
              assert.equal(comparisons[0][1], storedHash, label);
            }
            if (accountKind === 'existing' && passwordKind === 'correct') {
              assert.equal(ack.value().success, true, label);
              assert.equal(socket.username, username, label);
              assert.equal(broadcasts > 0, true, label);
            } else {
              assert.deepEqual(ack.value(), { error: 'Invalid username or password.' }, label);
              assert.equal(socket.username, undefined, label);
              assert.equal(broadcasts, 0, label);
            }
            assert.equal(writes, 0, label);
          }
        }
      }
    }
  });

  await t.test('default layered authentication storage never exceeds ten thousand union keys', () => {
    const limiter = createLayeredAuthLimiter({
      salt: 'matrix-default-auth-storage-cap',
      policies: {
        login: { account: 100_000, pair: 100_000, network: 100_000 },
        register: { account: 100_000, pair: 100_000, network: 100_000 }
      }
    });
    for (let index = 0; index < 5_001; index += 1) {
      assert.equal(limiter.attempt({
        action: 'login',
        account: `cap${index}`,
        address: '198.51.100.230'
      }).allowed, true, `default-cap attempt ${index + 1}`);
    }
    assert.equal(limiter.size(), 10_000);
  });

  await t.test('bcrypt costs ten eleven and twelve preserve migration save outcomes', async () => {
    for (const cost of [10, 11, 12]) {
      for (const saveOutcome of ['success', 'failure']) {
        let saves = 0;
        let hashes = 0;
        const onlineUsersMap = new Map();
        const broadcasts = [];
        const user = {
          username: `Cost${cost}${saveOutcome}`,
          displayName: `Cost ${cost} ${saveOutcome}`,
          password: `$2b$${cost}$matrix-cost-hash`,
          role: 'user',
          color: '',
          avatarUrl: '',
          servers: ['global'],
          async save() {
            saves += 1;
            if (saveOutcome === 'failure') throw new Error('matrix migration save failure');
          }
        };
        const socket = registerAuthenticationSocket({
          id: `cost-${cost}-${saveOutcome}`,
          address: `203.0.113.${cost + (saveOutcome === 'failure' ? 30 : 0)}`,
          UserModel: { async findOne() { return user; } },
          bcryptImpl: {
            async compare() { return true; },
            getRounds() { return cost; },
            async hash(password, requestedCost) {
              hashes += 1;
              assert.equal(password, 'correct-password');
              assert.equal(requestedCost, 11);
              return '$2b$11$matrix-upgraded-hash';
            }
          },
          onlineUsersMap,
          broadcastOnlineUsersFn(code) { broadcasts.push(code); },
          logger: { error() {} }
        });
        const ack = acknowledge();
        await socket.trigger('login', {
          username: user.username,
          password: 'correct-password'
        }, ack.callback);
        const label = `cost ${cost} save ${saveOutcome}`;

        if (cost === 10 && saveOutcome === 'failure') {
          assert.deepEqual(ack.value(), { error: 'Login failed.' }, label);
          assert.equal(onlineUsersMap.size, 0, label);
          assert.equal(socket.username, undefined, label);
          assert.deepEqual(broadcasts, [], label);
        } else {
          assert.equal(ack.value().success, true, label);
          assert.equal(onlineUsersMap.size, 1, label);
        }
        assert.equal(hashes, cost === 10 ? 1 : 0, label);
        assert.equal(saves, cost === 10 ? 1 : 0, label);
      }
    }
  });

  await t.test('forty shared-network accounts and one attacked account remain independent', async () => {
    const authLimiter = createLayeredAuthLimiter({ salt: 'complete-matrix-shared-network' });
    const records = new Map();
    for (let index = 0; index < 42; index += 1) {
      const username = `matrixuser${index}`;
      records.set(username, {
        username,
        displayName: `Matrix User ${index}`,
        password: `$2b$11$matrix-user-${index}`,
        role: 'user',
        color: '',
        avatarUrl: '',
        servers: ['global']
      });
    }
    const UserModel = createAuthUserModel(records);
    const bcryptImpl = {
      async compare(password) { return password === 'valid-password'; },
      getRounds() { return 11; },
      async hash() { throw new Error('must not hash current-cost accounts'); }
    };
    const address = '198.51.100.200';
    let successes = 0;
    for (let index = 0; index < 40; index += 1) {
      const socket = registerAuthenticationSocket({
        id: `matrix-shared-${index}`,
        address,
        authLimiter,
        UserModel,
        bcryptImpl
      });
      const ack = acknowledge();
      await socket.trigger('login', {
        username: `matrixuser${index}`,
        password: 'valid-password'
      }, ack.callback);
      assert.equal(ack.value().success, true, `shared account ${index + 1}`);
      successes += 1;
    }
    assert.equal(successes, 40);

    const attackedAcks = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const socket = registerAuthenticationSocket({
        id: `matrix-attacked-${attempt}`,
        address,
        authLimiter,
        UserModel,
        bcryptImpl
      });
      await socket.trigger('login', {
        username: 'matrixuser40',
        password: 'wrong-password'
      }, value => attackedAcks.push(value));
    }
    assert.deepEqual(attackedAcks.slice(0, 6), Array.from({ length: 6 }, () => ({
      error: 'Invalid username or password.'
    })));
    assert.deepEqual(attackedAcks[6], { error: 'Too many requests. Try again later.' });

    const unaffected = registerAuthenticationSocket({
      id: 'matrix-shared-unaffected',
      address,
      authLimiter,
      UserModel,
      bcryptImpl
    });
    const unaffectedAck = acknowledge();
    await unaffected.trigger('login', {
      username: 'matrixuser41',
      password: 'valid-password'
    }, unaffectedAck.callback);
    assert.equal(unaffectedAck.value().success, true);
  });

  await t.test('seven existing sessions admit the eighth and eight reject the ninth', async () => {
    for (const existingCount of [7, 8]) {
      const ioInstance = new FakeIo();
      ioInstance.sockets = Array.from({ length: existingCount }, (_, index) => {
        const live = new FakeSocket();
        live.id = `matrix-existing-${existingCount}-${index}`;
        live.username = index % 2 === 0 ? 'Alice' : 'alice';
        return live;
      });
      const onlineUsersMap = new Map(ioInstance.sockets.map(live => [live.id, {
        username: live.username,
        serverCode: 'global',
        joinedServers: ['global']
      }]));
      let roomReads = 0;
      const user = {
        username: 'Alice', displayName: 'Alice', password: '$2b$11$matrix-session-hash', role: 'user',
        color: '', avatarUrl: '', servers: ['global']
      };
      const socket = registerAuthenticationSocket({
        id: `matrix-next-${existingCount}`,
        address: `192.0.2.${existingCount}`,
        ioInstance,
        onlineUsersMap,
        UserModel: { async findOne() { return user; } },
        ChatServerModel: {
          async find() { roomReads += 1; return [{ code: 'global', moderators: [] }]; },
          async findOne() { return null; }
        },
        bcryptImpl: {
          async compare() { return true; },
          getRounds() { return 11; },
          async hash() { throw new Error('must not hash'); }
        }
      });
      const ack = acknowledge();
      await socket.trigger('login', {
        username: 'alice',
        password: 'correct-password'
      }, ack.callback);

      if (existingCount === 7) {
        assert.equal(ack.value().success, true);
        assert.equal(onlineUsersMap.size, 8);
        assert.equal(roomReads, 1);
      } else {
        assert.deepEqual(ack.value(), { error: 'Too many active sessions.' });
        assert.equal(onlineUsersMap.size, 8);
        assert.equal(roomReads, 0);
        assert.equal(socket.username, undefined);
      }
    }
  });

  await t.test('generic failures serialize no credential payload attachment or network markers', async () => {
    const credentialMarker = 'matrix-credential-private-marker';
    const hashMarker = '$2b$10$matrix-hash-private-marker';
    const payloadMarker = 'matrix-payload-private-marker';
    const attachmentMarker = 'data:image/png;base64,bWF0cml4LWF0dGFjaG1lbnQtcHJpdmF0ZS1tYXJrZXI=';
    const networkMarker = '203.0.113.251';
    const logs = [];
    const user = {
      username: 'PrivacyUser',
      displayName: 'Privacy User',
      password: hashMarker,
      role: 'user',
      color: '',
      avatarUrl: '',
      servers: ['global'],
      async save() {}
    };
    const loginSocket = registerAuthenticationSocket({
      id: 'matrix-privacy-login',
      address: networkMarker,
      UserModel: { async findOne() { return user; } },
      bcryptImpl: {
        async compare() { return true; },
        getRounds() { return 10; },
        async hash() {
          throw new Error(`${credentialMarker} ${hashMarker} ${payloadMarker} ${networkMarker}`);
        }
      },
      logger: { error(...args) { logs.push(args); } }
    });
    const loginAck = acknowledge();
    await loginSocket.trigger('login', {
      username: 'PrivacyUser',
      password: credentialMarker
    }, loginAck.callback);
    assert.deepEqual(loginAck.value(), { error: 'Login failed.' });

    let handlerEntries = 0;
    let writes = 0;
    let broadcasts = 0;
    const dispatcher = createSocketEventDispatcher({
      securityLogger: { warn(...args) { logs.push(args); } }
    });
    const packetSocket = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
    packetSocket.handshake.address = networkMarker;
    packetSocket.on('chat_message', () => {
      handlerEntries += 1;
      writes += 1;
      broadcasts += 1;
    });
    const packetAck = acknowledge();
    await packetSocket.trigger('chat_message', {
      serverCode: 'global',
      clientContextId: 1,
      text: payloadMarker,
      attachment: attachmentMarker,
      replyTo: null,
      unexpectedPrivateField: credentialMarker
    }, packetAck.callback);
    assert.deepEqual(packetAck.value(), { error: 'Invalid input format.' });
    assert.equal(handlerEntries, 0);
    assert.equal(writes, 0);
    assert.equal(broadcasts, 0);

    const serialized = JSON.stringify({
      loginAck: loginAck.value(),
      packetAck: packetAck.value(),
      logs,
      outbound: [...loginSocket.outbound, ...packetSocket.outbound]
    });
    for (const marker of [
      credentialMarker, hashMarker, payloadMarker, attachmentMarker, networkMarker
    ]) {
      assert.equal(serialized.includes(marker), false, marker);
    }
  });

  await t.test('all denial families redact distinct private sentinels before private work', async () => {
    const passwordSentinel = 'matrix-denial-password-private';
    const hashSentinel = '$2b$11$matrix-denial-hash-private';
    const networkSentinel = '203.0.113.252';
    const payloadSentinel = 'matrix-denial-payload-private';
    const attachmentSentinel =
      'data:image/png;base64,bWF0cml4LWRlbmlhbC1hdHRhY2htZW50LXByaXZhdGU=';
    const serializedFamilies = {};

    {
      const logs = [];
      let modelCalls = 0;
      let comparisons = 0;
      let writes = 0;
      let broadcasts = 0;
      const socket = registerAuthenticationSocket({
        id: 'matrix-private-layered-auth',
        address: networkSentinel,
        authLimiter: { attempt() { return { allowed: false }; }, success() {} },
        dummyPasswordHash: hashSentinel,
        UserModel: {
          async findOne() {
            modelCalls += 1;
            return { password: hashSentinel, async save() { writes += 1; } };
          }
        },
        bcryptImpl: {
          async compare() { comparisons += 1; return true; },
          getRounds() { return 11; },
          async hash() { writes += 1; return hashSentinel; }
        },
        broadcastOnlineUsersFn() { broadcasts += 1; },
        logger: { error(...args) { logs.push(args); } }
      });
      const ack = acknowledge();
      await socket.trigger('login', {
        username: 'PrivateAuth', password: passwordSentinel
      }, ack.callback);
      assert.deepEqual(ack.value(), { error: 'Too many requests. Try again later.' });
      assert.equal(modelCalls, 0);
      assert.equal(comparisons, 0);
      assert.equal(writes, 0);
      assert.equal(broadcasts, 0);
      assert.deepEqual(socket.outbound, []);
      serializedFamilies.layeredAuth = { ack: ack.value(), logs, outbound: socket.outbound };
    }

    {
      const logs = [];
      let handlerEntries = 0;
      let writes = 0;
      let broadcasts = 0;
      const dispatcher = createSocketEventDispatcher({
        eventBudgetController: { consume() { return { allowed: false }; } },
        securityLogger: { warn(...args) { logs.push(args); } }
      });
      const socket = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
      socket.username = 'PrivateBudget';
      socket.handshake.address = networkSentinel;
      socket.on('update_profile', () => {
        handlerEntries += 1;
        writes += 1;
        broadcasts += 1;
      });
      const ack = acknowledge();
      await socket.trigger('update_profile', {
        displayName: payloadSentinel,
        color: '#112233',
        avatarUrl: attachmentSentinel
      }, ack.callback);
      assert.deepEqual(ack.value(), { error: 'Too many requests. Try again later.' });
      assert.equal(handlerEntries, 0);
      assert.equal(writes, 0);
      assert.equal(broadcasts, 0);
      assert.deepEqual(socket.outbound, []);
      serializedFamilies.eventBudget = { ack: ack.value(), logs, outbound: socket.outbound };
    }

    {
      const logs = [];
      const started = deferred();
      const release = deferred();
      let handlerEntries = 0;
      const dispatcher = createSocketEventDispatcher({
        inFlightCoordinator: createInFlightRequestCoordinator(),
        securityLogger: { warn(...args) { logs.push(args); } }
      });
      const socket = new FakeSocket({ dispatchPacket: dispatcher.dispatch });
      socket.username = 'PrivateDuplicate';
      socket.handshake.address = networkSentinel;
      socket.on('update_profile', async () => {
        handlerEntries += 1;
        started.resolve();
        await release.promise;
      });
      const payload = {
        displayName: payloadSentinel,
        color: '#112233',
        avatarUrl: attachmentSentinel
      };
      const first = socket.trigger('update_profile', payload, () => {});
      await started.promise;
      const duplicateAck = acknowledge();
      await socket.trigger('update_profile', payload, duplicateAck.callback);
      assert.deepEqual(duplicateAck.value(), { error: 'Request already in progress.' });
      assert.equal(handlerEntries, 1);
      assert.deepEqual(socket.outbound, []);
      serializedFamilies.duplicate = {
        ack: duplicateAck.value(), logs, outbound: socket.outbound
      };
      release.resolve();
      await first;
    }

    {
      const logs = [];
      const admission = createConnectionAdmission({
        salt: 'matrix-private-connection',
        maxAttemptsPerMinute: 10,
        maxConcurrentPerNetwork: 1
      });
      const first = admission.open({ handshake: { address: networkSentinel } });
      assert.equal(first.allowed, true);
      const socket = new FakeSocket();
      socket.handshake.address = networkSentinel;
      createConnectionHandler({
        connectionAdmission: admission,
        ioInstance: new FakeIo(),
        onlineUsersMap: new Map(),
        broadcastOnlineUsersFn() {},
        logger: { error(...args) { logs.push(args); } }
      })(socket);
      assert.equal(socket.disconnected, true);
      assert.equal(socket.handlers.size, 0);
      assert.deepEqual(socket.outbound, []);
      serializedFamilies.connection = { logs, outbound: socket.outbound };
      admission.release(first.token);
    }

    {
      const logs = [];
      const ioInstance = new FakeIo();
      ioInstance.sockets = Array.from({ length: 8 }, (_, index) => {
        const live = new FakeSocket();
        live.id = `matrix-private-session-${index}`;
        live.username = index % 2 ? 'privateuser' : 'PrivateUser';
        return live;
      });
      const onlineUsersMap = new Map(ioInstance.sockets.map(live => [live.id, {
        username: live.username, serverCode: 'global', joinedServers: ['global']
      }]));
      let writes = 0;
      let broadcasts = 0;
      let roomReads = 0;
      const user = {
        username: 'PrivateUser', displayName: 'Private User', password: hashSentinel,
        role: 'user', color: '', avatarUrl: '', servers: ['global'],
        async save() { writes += 1; }
      };
      const socket = registerAuthenticationSocket({
        id: 'matrix-private-session-next',
        address: networkSentinel,
        ioInstance,
        onlineUsersMap,
        UserModel: { async findOne() { return user; } },
        ChatServerModel: {
          async find() { roomReads += 1; return [{ code: 'global', moderators: [] }]; },
          async findOne() { roomReads += 1; return null; }
        },
        bcryptImpl: {
          async compare(password, hash) {
            assert.equal(password, passwordSentinel);
            assert.equal(hash, hashSentinel);
            return true;
          },
          getRounds() { return 11; },
          async hash() { writes += 1; return hashSentinel; }
        },
        broadcastOnlineUsersFn() { broadcasts += 1; },
        logger: { error(...args) { logs.push(args); } }
      });
      const ack = acknowledge();
      await socket.trigger('login', {
        username: 'PrivateUser', password: passwordSentinel
      }, ack.callback);
      assert.deepEqual(ack.value(), { error: 'Too many active sessions.' });
      assert.equal(writes, 0);
      assert.equal(broadcasts, 0);
      assert.equal(roomReads, 0);
      assert.equal(socket.username, undefined);
      assert.deepEqual(socket.outbound, []);
      serializedFamilies.accountSession = { ack: ack.value(), logs, outbound: socket.outbound };
    }

    const serialized = JSON.stringify(serializedFamilies);
    for (const sentinel of [
      passwordSentinel, hashSentinel, networkSentinel, payloadSentinel, attachmentSentinel
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
  });
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
