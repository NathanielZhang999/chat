const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  DEFAULT_APPEARANCE_PREFERENCES,
  normalizeAppearancePreferences,
  normalizeStoredAppearancePreferences,
  normalizePreferencesVersion,
  storedPreferencesVersion,
  safePreferencesSnapshot,
  readRawPreferencesVersion,
  applyPreferencesSnapshotToSessions,
  UserSchema,
  createConnectionHandler
} = require('../server');
const { FakeSocket, FakeIo, acknowledge, deferred, createMemoryModel } = require('./support/fakes');

const defaultPreferences = {
  theme: 'dark', textScale: 100, compactMessages: false, motion: 'system'
};

function preferenceRateLimiter() {
  return { check() { return true; }, clear() {}, prune() {} };
}

function connect(overrides = {}) {
  const socket = new FakeSocket();
  const ioInstance = new FakeIo();
  const onlineUsersMap = new Map();
  createConnectionHandler({
    ioInstance,
    UserModel: { async findOne() { return null; }, async create(value) { return value; } },
    ChatServerModel: { async find() { return [{ code: 'global', name: 'Global Chat' }]; }, async findOne() { return null; } },
    RoomRestrictionModel: { async find() { return []; }, async findOne() { return null; } },
    bcryptImpl: { async hash() { return 'hash'; }, async compare() { return true; } },
    onlineUsersMap,
    rateLimiter: preferenceRateLimiter(),
    logger: { error() {} },
    ...overrides
  })(socket);
  return { socket, ioInstance, onlineUsersMap };
}

function assertWithoutPreferenceData(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /preferences|PREFERENCE_SECRET/);
}

test('appearance preferences accept only the complete strict allowlist', () => {
  const base = { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' };
  for (const [key, values] of Object.entries({
    theme: ['dark', 'light'],
    textScale: [100, 112.5, 125],
    compactMessages: [false, true],
    motion: ['system', 'reduce']
  })) {
    for (const value of values) {
      const candidate = { ...base, [key]: value };
      assert.deepEqual(normalizeAppearancePreferences(candidate), candidate);
    }
  }
  for (const missingKey of Object.keys(base)) {
    const candidate = { ...base };
    delete candidate[missingKey];
    assert.equal(normalizeAppearancePreferences(candidate), null);
  }
  for (const invalid of [
    null,
    { ...base, theme: 'system' },
    { ...base, textScale: 90 },
    { ...base, compactMessages: 'true' },
    { ...base, motion: 'force' },
    { ...base, extra: true }
  ]) assert.equal(normalizeAppearancePreferences(invalid), null);
  assert.deepEqual(DEFAULT_APPEARANCE_PREFERENCES, defaultPreferences);
  assert.ok(Object.isFrozen(DEFAULT_APPEARANCE_PREFERENCES));
});

test('stored appearance preferences safely default legacy and malformed fields', () => {
  assert.deepEqual(normalizeStoredAppearancePreferences(undefined), {
    theme: 'dark', textScale: 100,
    compactMessages: false, motion: 'system'
  });
  assert.deepEqual(normalizeStoredAppearancePreferences({
    theme: 'light', textScale: null,
    compactMessages: true, motion: 'unexpected'
  }), {
    theme: 'light', textScale: 100,
    compactMessages: true, motion: 'system'
  });
});

test('preference versions accept only non-negative safe integers', () => {
  assert.equal(normalizePreferencesVersion(0), 0);
  assert.equal(normalizePreferencesVersion(4), 4);
  for (const value of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizePreferencesVersion(value), null);
  }
  assert.equal(storedPreferencesVersion(undefined), 0);
});

test('preference version schema rejects fractions and unsafe integers', async () => {
  const path = UserSchema.path('preferencesVersion');
  const validate = value => new Promise((resolve, reject) =>
    path.doValidate(value, error => error ? reject(error) : resolve()));
  await validate(0);
  await validate(1);
  await validate(Number.MAX_SAFE_INTEGER);
  await assert.rejects(validate(-1));
  await assert.rejects(validate(1.5));
  await assert.rejects(validate(Number.MAX_SAFE_INTEGER + 1));
});

test('raw preference-version projection preserves values Mongoose Number hydration casts', async () => {
  const TestUser = mongoose.models.AppearanceRawVersionTestUser ||
    mongoose.model('AppearanceRawVersionTestUser', UserSchema.clone());
  const hydrated = new TestUser({ username: 'raw_version', password: 'hash', preferencesVersion: '1' });
  assert.equal(hydrated.preferencesVersion, 1);
  const raw = await readRawPreferencesVersion({
    collection: { async findOne(query, options) {
      assert.deepEqual(query, { _id: hydrated._id });
      assert.deepEqual(options, { projection: { preferencesVersion: 1 } });
      return { preferencesVersion: '1' };
    } }
  }, hydrated);
  assert.deepEqual(raw, { exists: true, value: '1' });
});

test('user schema persists every exact appearance path default type and enum', () => {
  const expected = {
    'preferences.theme': { instance: 'String', enumValues: ['dark', 'light'], defaultValue: 'dark' },
    'preferences.textScale': { instance: 'Number', enumValues: [100, 112.5, 125], defaultValue: 100 },
    'preferences.compactMessages': { instance: 'Boolean', enumValues: [], defaultValue: false },
    'preferences.motion': { instance: 'String', enumValues: ['system', 'reduce'], defaultValue: 'system' }
  };
  for (const [name, contract] of Object.entries(expected)) {
    const path = UserSchema.path(name);
    assert.ok(path, `missing schema path ${name}`);
    assert.equal(path.instance, contract.instance);
    assert.deepEqual(path.options.enum || path.enumValues || [], contract.enumValues);
    assert.equal(path.getDefault(null), contract.defaultValue);
  }
  const TestUser = mongoose.models.AppearanceSchemaTestUser ||
    mongoose.model('AppearanceSchemaTestUser', UserSchema.clone());
  const document = new TestUser({ username: 'schema_user', password: 'hash' });
  assert.deepEqual(document.preferences.toObject(), {
    theme: 'dark', textScale: 100, compactMessages: false, motion: 'system'
  });
  document.preferences.theme = 'system';
  assert.ok(document.validateSync().errors['preferences.theme']);
  document.preferences.theme = 'dark';
  document.preferences.textScale = 90;
  assert.ok(document.validateSync().errors['preferences.textScale']);
  document.preferences.textScale = 100;
  document.preferences.motion = 'force';
  assert.ok(document.validateSync().errors['preferences.motion']);
});

test('registration and login return only the safe appearance snapshot', async () => {
  const createdUser = { username: 'new_user', preferences: { ...defaultPreferences }, preferencesVersion: 0 };
  const registration = connect({
    UserModel: {
      async findOne() { return null; },
      async create(value) { return { ...createdUser, ...value }; }
    }
  });
  const registrationAck = acknowledge();
  await registration.socket.trigger('register', {
    username: 'new_user', displayName: 'New User', password: '123456'
  }, registrationAck.callback);
  assert.deepEqual(JSON.parse(JSON.stringify(registrationAck.value())), {
    success: true, preferences: defaultPreferences, preferencesVersion: 0
  });

  const storedUser = {
    username: 'login_user', displayName: 'Login User', password: 'hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global'], preferencesVersion: 7,
    preferences: {
      theme: 'light', textScale: null, compactMessages: true, motion: 'reduce',
      secretSentinel: 'PREFERENCE_SECRET'
    },
    async save() {}
  };
  const login = connect({ UserModel: { async findOne() { return { ...storedUser, preferences: { ...storedUser.preferences } }; } } });
  const loginAck = acknowledge();
  await login.socket.trigger('login', { username: 'login_user', password: '123456' }, loginAck.callback);
  const serialized = JSON.parse(JSON.stringify(loginAck.value()));
  assert.deepEqual(serialized.preferences, {
    theme: 'light', textScale: 100, compactMessages: true, motion: 'reduce'
  });
  assert.equal(serialized.preferencesVersion, 7);
  assert.deepEqual(Object.keys(serialized.preferences).sort(),
    ['compactMessages', 'motion', 'textScale', 'theme']);
  assertWithoutPreferenceData({ ...serialized, preferences: undefined, preferencesVersion: undefined });
  assert.equal(JSON.stringify(serialized).includes('PREFERENCE_SECRET'), false);
  assert.deepEqual(safePreferencesSnapshot(storedUser), {
    preferences: serialized.preferences, preferencesVersion: 7
  });
});

test('appearance preferences never enter presence room message or moderation payloads', async () => {
  const storedUser = {
    username: 'payload_user', displayName: 'Payload User', password: 'hash', role: 'user',
    color: '', avatarUrl: '', servers: ['global'], preferencesVersion: 2,
    preferences: {
      theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce',
      secretSentinel: 'PREFERENCE_SECRET'
    },
    async save() {}
  };
  const onlineUsersEvents = [];
  const { socket, ioInstance, onlineUsersMap } = connect({
    UserModel: { async findOne() { return { ...storedUser, preferences: { ...storedUser.preferences } }; } },
    broadcastOnlineUsersFn: async room => {
      const payload = [...onlineUsersMap.values()].map(({ username, displayName, role, color, avatarUrl }) => ({
        username, displayName, role, color, avatarUrl, online: true, roomRole: 'user'
      }));
      onlineUsersEvents.push({ room, payload });
      ioInstance.to(room).emit('online_users', payload);
    }
  });
  const loginAck = acknowledge();
  await socket.trigger('login', { username: 'payload_user', password: '123456' }, loginAck.callback);

  assert.deepEqual(loginAck.value().preferences, {
    theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce'
  });
  assertWithoutPreferenceData([...onlineUsersMap.values()]);
  assertWithoutPreferenceData(onlineUsersEvents);
  assertWithoutPreferenceData(ioInstance.outbound.filter(event => event.event === 'online_users'));
  assertWithoutPreferenceData(socket.outbound.filter(event => event.event === 'system_message'));
  assertWithoutPreferenceData(loginAck.value().servers);
  assertWithoutPreferenceData({
    message: {
      _id: 'message-1', username: socket.username, displayName: socket.displayName,
      role: socket.role, roomRole: 'user', color: socket.color, avatarUrl: socket.avatarUrl,
      text: 'hello', attachment: null, reactions: {}, timestamp: new Date(0), edited: false, deleted: false
    },
    moderation: {
      action: 'timeout', serverCode: socket.serverCode, actorUsername: socket.username,
      targetUsername: 'other_user', metadata: { reason: 'fixture' }
    }
  });
});

function preferenceUser(overrides = {}) {
  return {
    _id: 'user-alice', username: 'Alice', displayName: 'Alice', password: 'hash',
    role: 'user', color: '', avatarUrl: '', servers: ['global'], preferencesVersion: 0,
    preferences: { ...defaultPreferences }, ...overrides
  };
}

function preferenceConnection({ rows = [preferenceUser()], ...overrides } = {}) {
  const UserModel = overrides.UserModel || createMemoryModel(rows);
  const ioInstance = overrides.ioInstance || new FakeIo();
  const onlineUsersMap = overrides.onlineUsersMap || new Map();
  const socket = overrides.socket || new FakeSocket();
  createConnectionHandler({
    ioInstance, UserModel,
    ChatServerModel: { async find() { return []; }, async findOne() { return null; } },
    RoomRestrictionModel: { async find() { return []; }, async findOne() { return null; } },
    bcryptImpl: { async hash() { return 'hash'; }, async compare() { return true; } },
    onlineUsersMap, rateLimiter: preferenceRateLimiter(), logger: { error() {} },
    ...overrides
  })(socket);
  return { socket, ioInstance, onlineUsersMap, UserModel };
}

function updateData(preferences = { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' }, expectedVersion = 0) {
  return { preferences, expectedVersion };
}

test('preference update requires authentication and an exact complete payload', async () => {
  const unauthenticated = preferenceConnection();
  const unauthAck = acknowledge();
  await unauthenticated.socket.trigger('update_preferences', updateData(), unauthAck.callback);
  assert.deepEqual(unauthAck.value(), { error: 'Not authenticated.' });

  const { socket, UserModel } = preferenceConnection();
  socket.username = 'Alice';
  let calls = 0;
  UserModel.findOne = async () => { calls += 1; return null; };
  const complete = { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' };
  const invalid = [
    undefined,
    { expectedVersion: 0 },
    ...Object.keys(complete).map(key => {
      const preferences = { ...complete }; delete preferences[key]; return { preferences, expectedVersion: 0 };
    }),
    { preferences: { ...complete, extra: true }, expectedVersion: 0 },
    { preferences: { ...complete, theme: 'system' }, expectedVersion: 0 },
    { preferences: { ...complete, compactMessages: 'false' }, expectedVersion: 0 },
    { preferences: complete, expectedVersion: -1 },
    { preferences: complete, expectedVersion: 1.5 },
    { preferences: complete, expectedVersion: '0' }
  ];
  for (const payload of invalid) {
    const ack = acknowledge();
    await socket.trigger('update_preferences', payload, ack.callback);
    assert.deepEqual(ack.value(), { error: 'Invalid input format.' });
  }
  assert.equal(calls, 0);
  for (const theme of ['dark', 'light']) for (const textScale of [100, 112.5, 125]) {
    for (const compactMessages of [false, true]) for (const motion of ['system', 'reduce']) {
      const ack = acknowledge();
      await socket.trigger('update_preferences', updateData({ theme, textScale, compactMessages, motion }), ack.callback);
      assert.notEqual(ack.value()?.error, 'Invalid input format.');
    }
  }
});

test('preference update atomically increments the expected version', async () => {
  const { socket, ioInstance, UserModel } = preferenceConnection({ rows: [preferenceUser({ preferencesVersion: 3 })] });
  socket.username = 'Alice'; ioInstance.sockets = [socket];
  const ack = acknowledge();
  await socket.trigger('update_preferences', updateData(undefined, 3), ack.callback);
  const expected = { preferences: { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' }, preferencesVersion: 4 };
  assert.deepEqual(ack.value(), { success: true, ...expected });
  assert.deepEqual(UserModel.rows[0].preferences, expected.preferences);
  assert.equal(UserModel.rows[0].preferencesVersion, 4);
  assert.deepEqual(socket.outbound.at(-1), { target: 'self', event: 'preferences_updated', payload: expected });
});

test('legacy version zero compare-and-swap matches missing stored version', async () => {
  const observed = [];
  const legacyUser = preferenceUser(); delete legacyUser.preferencesVersion;
  const UserModel = createMemoryModel([legacyUser]);
  const original = UserModel.findOneAndUpdate;
  UserModel.findOneAndUpdate = async (...args) => { observed.push(args[0]); return original(...args); };
  const { socket } = preferenceConnection({ UserModel }); socket.username = 'Alice';
  const ack = acknowledge();
  await socket.trigger('update_preferences', updateData(), ack.callback);
  assert.deepEqual(observed, [{ username: 'Alice', $or: [{ preferencesVersion: 0 }, { preferencesVersion: { $exists: false } }] }]);
  assert.equal(ack.value().preferencesVersion, 1);
});

test('shared memory model distinguishes absent fields from explicit undefined for exists', async () => {
  const model = createMemoryModel([
    { _id: 'absent' },
    { _id: 'undefined', preferencesVersion: undefined },
    { _id: 'zero', preferencesVersion: 0 }
  ]);
  const missing = await model.find({ preferencesVersion: { $exists: false } });
  const present = await model.find({ preferencesVersion: { $exists: true } });
  assert.deepEqual(missing.map(row => row._id), ['absent']);
  assert.deepEqual(present.map(row => row._id), ['undefined', 'zero']);
});

test('shared memory model rejects nonnumeric increments atomically', async () => {
  const model = createMemoryModel([
    { _id: 'bad-string', preferencesVersion: 'bad', marker: 'before' },
    { _id: 'bad-undefined', preferencesVersion: undefined, marker: 'before' },
    { _id: 'missing', marker: 'before' },
    { _id: 'numeric', preferencesVersion: 2, marker: 'before' }
  ]);
  for (const id of ['bad-string', 'bad-undefined']) {
    await assert.rejects(model.findOneAndUpdate(
      { _id: id },
      { $set: { marker: 'after' }, $inc: { preferencesVersion: 1 } },
      { new: true }
    ));
    const row = model.rows.find(candidate => candidate._id === id);
    assert.equal(row.marker, 'before', `${id} update remains atomic`);
  }
  await model.findOneAndUpdate(
    { _id: 'missing' }, { $inc: { preferencesVersion: 1 } }, { new: true }
  );
  await model.findOneAndUpdate(
    { _id: 'numeric' }, { $inc: { preferencesVersion: 1 } }, { new: true }
  );
  assert.equal(model.rows.find(row => row._id === 'missing').preferencesVersion, 1);
  assert.equal(model.rows.find(row => row._id === 'numeric').preferencesVersion, 3);
});

test('malformed and maximum stored preference versions fail closed without overwrite', async () => {
  for (const rawVersion of [-1, 1.5, '1', 'invalid', Number.MAX_SAFE_INTEGER]) {
    const UserModel = createMemoryModel([preferenceUser({ preferencesVersion: 2 })]);
    let writes = 0;
    UserModel.findOneAndUpdate = async () => { writes += 1; return null; };
    const { socket } = preferenceConnection({ UserModel, readRawPreferencesVersionFn: async () => ({ exists: true, value: rawVersion }) });
    socket.username = 'Alice';
    const ack = acknowledge();
    await socket.trigger('update_preferences', updateData(undefined, 2), ack.callback);
    assert.deepEqual(ack.value(), { error: 'Appearance settings unavailable.' });
    assert.equal(writes, 0);
    assert.equal(socket.outbound.length, 0);
  }
});

test('concurrent devices publish only the preference winner', async () => {
  const UserModel = createMemoryModel([preferenceUser()]);
  const ioInstance = new FakeIo();
  const first = new FakeSocket(); first.id = 'first'; first.username = 'Alice';
  const second = new FakeSocket(); second.id = 'second'; second.username = 'alice';
  const shared = { UserModel, ioInstance };
  preferenceConnection({ ...shared, socket: first }); preferenceConnection({ ...shared, socket: second });
  ioInstance.sockets = [first, second];
  const firstAck = acknowledge(); const secondAck = acknowledge();
  await Promise.all([
    first.trigger('update_preferences', updateData(), firstAck.callback),
    second.trigger('update_preferences', updateData({ theme: 'dark', textScale: 125, compactMessages: false, motion: 'system' }), secondAck.callback)
  ]);
  assert.equal([firstAck.value(), secondAck.value()].filter(value => value.success).length, 1);
  assert.equal([firstAck.value(), secondAck.value()].filter(value => value.error === 'Settings changed on another device.').length, 1);
  assert.equal(UserModel.rows[0].preferencesVersion, 1);
  assert.equal(first.outbound.filter(event => event.event === 'preferences_updated').length, 1);
  assert.equal(second.outbound.filter(event => event.event === 'preferences_updated').length, 1);
});

test('stale preference update returns the current safe snapshot without writing', async () => {
  const UserModel = createMemoryModel([preferenceUser({ preferencesVersion: 4, preferences: { theme: 'dark', textScale: 125, compactMessages: false, motion: 'system', hostile: 'PREFERENCE_SECRET' } })]);
  let writes = 0; UserModel.findOneAndUpdate = async () => { writes += 1; return null; };
  const { socket } = preferenceConnection({ UserModel }); socket.username = 'Alice';
  const ack = acknowledge(); await socket.trigger('update_preferences', updateData(undefined, 3), ack.callback);
  assert.deepEqual(ack.value(), { error: 'Settings changed on another device.', preferences: { theme: 'dark', textScale: 125, compactMessages: false, motion: 'system' }, preferencesVersion: 4 });
  assert.equal(writes, 0); assert.equal(JSON.stringify(ack.value()).includes('PREFERENCE_SECRET'), false);
});

test('preference publication reaches every same-account session before acknowledgement', async () => {
  const UserModel = createMemoryModel([preferenceUser()]); const ioInstance = new FakeIo();
  const target = new FakeSocket(); target.id = 'target'; target.username = 'alice';
  const { socket } = preferenceConnection({ UserModel, ioInstance }); socket.username = 'Alice'; ioInstance.sockets = [socket, target];
  let acknowledged = false; let sawAckDuringEvent;
  const originalEmit = target.emit.bind(target); target.emit = (event, payload) => { sawAckDuringEvent = acknowledged; originalEmit(event, payload); };
  await socket.trigger('update_preferences', updateData(), () => { acknowledged = true; });
  assert.equal(sawAckDuringEvent, false); assert.equal(acknowledged, true);
  assert.equal(target.outbound.filter(event => event.event === 'preferences_updated').length, 1);
});

test('preference publication excludes other accounts and sanitizes committed snapshots', () => {
  const alice = new FakeSocket(); alice.id = 'alice'; alice.username = 'ALICE';
  const bob = new FakeSocket(); bob.id = 'bob'; bob.username = 'bob';
  applyPreferencesSnapshotToSessions([alice, bob], 'Alice', {
    preferences: {
      theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce',
      hostile: 'PREFERENCE_SECRET'
    },
    preferencesVersion: 3,
    hostileSnapshotKey: 'PREFERENCE_SECRET'
  });
  assert.deepEqual(alice.outbound, [{
    target: 'self', event: 'preferences_updated', payload: {
      preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' },
      preferencesVersion: 3
    }
  }]);
  assert.deepEqual(bob.outbound, []);
});

test('preference acknowledgement remains inside the account lock', async () => {
  const gate = deferred(); const persistenceStarted = deferred(); const entered = [];
  const UserModel = createMemoryModel([preferenceUser()]);
  const original = UserModel.findOneAndUpdate;
  UserModel.findOneAndUpdate = async (...args) => {
    persistenceStarted.resolve(); await gate.promise; return original(...args);
  };
  const { socket, ioInstance } = preferenceConnection({ UserModel }); socket.username = 'Alice';
  const target = new FakeSocket(); target.id = 'target'; target.username = 'alice';
  const originalEmit = target.emit.bind(target);
  target.emit = (event, payload) => { entered.push(`${event} event`); originalEmit(event, payload); };
  ioInstance.sockets = [socket, target];
  const pending = socket.trigger('update_preferences', updateData(), () => entered.push('preference acknowledgement'));
  await persistenceStarted.promise;
  const { withAccountTransitionLock } = require('../server');
  const contender = withAccountTransitionLock('ALICE', () => entered.push('contender entered'));
  gate.resolve(); await Promise.all([pending, contender]);
  assert.deepEqual(entered, ['preferences_updated event', 'preference acknowledgement', 'contender entered']);
});

test('compare-and-swap loss reloads an external preference winner', async () => {
  const winningPreferences = { theme: 'dark', textScale: 125, compactMessages: false, motion: 'system' };
  const UserModel = createMemoryModel([preferenceUser()]);
  const queries = [];
  UserModel.findOneAndUpdate = async query => {
    queries.push(query);
    Object.assign(UserModel.rows[0], { preferences: winningPreferences, preferencesVersion: 1 });
    return null;
  };
  const { socket } = preferenceConnection({ UserModel }); socket.username = 'Alice';
  const ack = acknowledge(); await socket.trigger('update_preferences', updateData(), ack.callback);
  assert.deepEqual(queries, [{ username: 'Alice', $or: [{ preferencesVersion: 0 }, { preferencesVersion: { $exists: false } }] }]);
  assert.deepEqual(ack.value(), {
    error: 'Settings changed on another device.', preferences: winningPreferences, preferencesVersion: 1
  });
  assert.equal(socket.outbound.length, 0);
});

test('memory preference persistence honors missing-version matching and increments without aliasing', async () => {
  const model = createMemoryModel([{ username: 'Alice' }]);
  const preferences = { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' };
  await model.findOneAndUpdate(
    { username: 'Alice', $or: [{ preferencesVersion: 0 }, { preferencesVersion: { $exists: false } }] },
    { $set: { preferences }, $inc: { preferencesVersion: 1 } }
  );
  preferences.theme = 'dark';
  assert.deepEqual(model.rows[0], {
    username: 'Alice', preferences: { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' }, preferencesVersion: 1
  });
});

test('preference recipient discovery failure occurs before persistence', async () => {
  const UserModel = createMemoryModel([preferenceUser()]); let writes = 0;
  UserModel.findOneAndUpdate = async () => { writes += 1; return null; };
  const { socket, ioInstance } = preferenceConnection({ UserModel, ioInstance: { async fetchSockets() { throw new Error('unavailable'); }, to() {} } });
  socket.username = 'Alice'; const ack = acknowledge(); await socket.trigger('update_preferences', updateData(), ack.callback);
  assert.deepEqual(ack.value(), { error: 'Failed to update appearance settings.' }); assert.equal(writes, 0);
});

test('one throwing preference recipient cannot change committed success', async () => {
  const UserModel = createMemoryModel([preferenceUser()]); const ioInstance = new FakeIo();
  const broken = new FakeSocket(); broken.id = 'broken'; broken.username = 'alice'; broken.emit = () => { throw new Error('broken'); };
  const healthy = new FakeSocket(); healthy.id = 'healthy'; healthy.username = 'ALICE';
  const logs = []; const { socket } = preferenceConnection({ UserModel, ioInstance, logger: { error(...args) { logs.push(args); } } });
  socket.username = 'Alice'; ioInstance.sockets = [socket, broken, healthy]; const ack = acknowledge();
  await socket.trigger('update_preferences', updateData(), ack.callback);
  assert.equal(ack.value().success, true); assert.equal(UserModel.rows[0].preferencesVersion, 1);
  assert.equal(healthy.outbound.filter(event => event.event === 'preferences_updated').length, 1);
  assert.equal(JSON.stringify(logs).includes('broken'), false);
});

test('preference database failure publishes nothing and returns a generic error', async () => {
  const UserModel = createMemoryModel([preferenceUser()]); UserModel.findOneAndUpdate = async () => { throw new Error('database'); };
  const { socket, ioInstance } = preferenceConnection({ UserModel }); socket.username = 'Alice'; ioInstance.sockets = [socket];
  const ack = acknowledge(); await socket.trigger('update_preferences', updateData(), ack.callback);
  assert.deepEqual(ack.value(), { error: 'Failed to update appearance settings.' }); assert.equal(socket.outbound.length, 0);
});

test('preference events and logs never contain unknown or hostile keys', async () => {
  const UserModel = createMemoryModel([preferenceUser({ preferences: { ...defaultPreferences, hostile: 'PREFERENCE_SECRET' } })]);
  const logs = []; const { socket, ioInstance } = preferenceConnection({ UserModel, logger: { error(...args) { logs.push(args); } } });
  socket.username = 'Alice'; ioInstance.sockets = [socket]; const ack = acknowledge();
  await socket.trigger('update_preferences', updateData(), ack.callback);
  const event = socket.outbound.find(item => item.event === 'preferences_updated');
  assert.deepEqual(Object.keys(event.payload.preferences).sort(), ['compactMessages', 'motion', 'textScale', 'theme']);
  assert.equal(JSON.stringify([event, ack.value(), logs]).includes('PREFERENCE_SECRET'), false);
});

test('complete appearance preference policy matrix uses registered handlers', async () => {
  const desired = {
    theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce'
  };
  const stored = {
    theme: 'dark', textScale: 125, compactMessages: false, motion: 'system',
    hostilePreference: 'PREFERENCE_SECRET'
  };
  const winner = {
    theme: 'light', textScale: 125, compactMessages: false, motion: 'reduce',
    hostileWinner: 'PREFERENCE_SECRET'
  };
  const invalidPayloads = {
    'missing key': { preferences: { theme: 'light', textScale: 112.5, compactMessages: true }, expectedVersion: 0 },
    'extra key': { preferences: { ...desired, hostileExtra: 'PREFERENCE_SECRET' }, expectedVersion: 4 },
    'invalid enum': { preferences: { ...desired, theme: 'system' }, expectedVersion: 3 },
    'invalid version': { preferences: desired, expectedVersion: '5' }
  };
  const rows = [
    {
      name: 'unauthenticated valid exact-current one-socket request', authentication: 'unauthenticated',
      payload: updateData(desired, 4), storedVersion: 4, topology: 'one socket', outcome: 'success',
      ack: { error: 'Not authenticated.' }, writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'terminally quarantined valid exact-current same-account request', authentication: 'terminally quarantined',
      payload: updateData(desired, 4), storedVersion: 4, topology: 'two same-account sockets', outcome: 'success',
      ack: { error: 'Connection unavailable.' }, writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'authenticated missing-key legacy-zero one-socket request', authentication: 'authenticated',
      payload: invalidPayloads['missing key'], storedVersion: 0, topology: 'one socket', outcome: 'success',
      ack: { error: 'Invalid input format.' }, writes: 0, rowVersion: 0, recipients: []
    },
    {
      name: 'authenticated extra-key exact-current same-account request', authentication: 'authenticated',
      payload: invalidPayloads['extra key'], storedVersion: 4, topology: 'two same-account sockets', outcome: 'CAS loser',
      ack: { error: 'Invalid input format.' }, writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'authenticated invalid-enum stale observer request', authentication: 'authenticated',
      payload: invalidPayloads['invalid enum'], storedVersion: 4, topology: 'different-account observer', outcome: 'database rejection',
      ack: { error: 'Invalid input format.' }, writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'authenticated invalid-version future one-socket request', authentication: 'authenticated',
      payload: invalidPayloads['invalid version'], storedVersion: 4, topology: 'one socket', outcome: 'success',
      ack: { error: 'Invalid input format.' }, writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'authenticated valid exact legacy-zero observer success', authentication: 'authenticated',
      payload: updateData(desired, 0), storedVersion: undefined, topology: 'different-account observer', outcome: 'success',
      ack: { success: true, preferences: desired, preferencesVersion: 1 }, writes: 1, rowVersion: 1,
      recipients: ['origin']
    },
    {
      name: 'authenticated valid exact-current same-account success', authentication: 'authenticated',
      payload: updateData(desired, 4), storedVersion: 4, topology: 'two same-account sockets', outcome: 'success',
      ack: { success: true, preferences: desired, preferencesVersion: 5 }, writes: 1, rowVersion: 5,
      recipients: ['origin', 'same-account']
    },
    {
      name: 'authenticated valid stale-lower observer conflict', authentication: 'authenticated',
      payload: updateData(desired, 3), storedVersion: 4, topology: 'different-account observer', outcome: 'success',
      ack: {
        error: 'Settings changed on another device.',
        preferences: { theme: 'dark', textScale: 125, compactMessages: false, motion: 'system' },
        preferencesVersion: 4
      },
      writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'authenticated valid future-higher one-socket conflict', authentication: 'authenticated',
      payload: updateData(desired, 5), storedVersion: 4, topology: 'one socket', outcome: 'success',
      ack: {
        error: 'Settings changed on another device.',
        preferences: { theme: 'dark', textScale: 125, compactMessages: false, motion: 'system' },
        preferencesVersion: 4
      },
      writes: 0, rowVersion: 4, recipients: []
    },
    {
      name: 'authenticated valid exact-current same-account CAS loser', authentication: 'authenticated',
      payload: updateData(desired, 4), storedVersion: 4, topology: 'two same-account sockets', outcome: 'CAS loser',
      ack: {
        error: 'Settings changed on another device.',
        preferences: { theme: 'light', textScale: 125, compactMessages: false, motion: 'reduce' },
        preferencesVersion: 5
      },
      writes: 1, rowVersion: 5, recipients: []
    },
    {
      name: 'authenticated valid exact-current observer database rejection', authentication: 'authenticated',
      payload: updateData(desired, 4), storedVersion: 4, topology: 'different-account observer', outcome: 'database rejection',
      ack: { error: 'Failed to update appearance settings.' }, writes: 1, rowVersion: 4, recipients: []
    }
  ];

  for (const row of rows) {
    const initial = preferenceUser({ preferences: stored });
    if (row.authentication === 'terminally quarantined') {
      initial.role = 'admin';
      initial.servers = ['global', 'OLD123', 'ABC123'];
    }
    if (row.storedVersion === undefined) delete initial.preferencesVersion;
    else initial.preferencesVersion = row.storedVersion;
    const UserModel = createMemoryModel([initial]);
    const originalUpdate = UserModel.findOneAndUpdate;
    let writes = 0;
    UserModel.findOneAndUpdate = async (...args) => {
      writes += 1;
      if (row.outcome === 'CAS loser') {
        Object.assign(UserModel.rows[0], { preferences: winner, preferencesVersion: 5 });
      }
      if (row.outcome === 'database rejection') throw new Error('DATABASE_SECRET_SENTINEL');
      return originalUpdate(...args);
    };

    const socket = new FakeSocket();
    socket.id = 'origin';
    const ioInstance = new FakeIo();
    const sameAccount = new FakeSocket();
    sameAccount.id = 'same-account';
    sameAccount.username = 'alice';
    const observer = new FakeSocket();
    observer.id = 'observer';
    observer.username = 'Bob';
    ioInstance.sockets = row.topology === 'two same-account sockets'
      ? [socket, sameAccount]
      : row.topology === 'different-account observer' ? [socket, observer] : [socket];
    const logs = [];
    if (row.authentication !== 'unauthenticated') socket.username = 'Alice';
    if (row.authentication === 'terminally quarantined') {
      Object.assign(socket, {
        displayName: 'Alice', role: 'admin', serverCode: 'OLD123',
        joinedServers: ['global', 'OLD123', 'ABC123']
      });
      socket.joinedRooms.add('OLD123');
      socket.join = roomCode => roomCode === 'ABC123'
        ? Promise.reject(new Error('quarantine transport failure'))
        : FakeSocket.prototype.join.call(socket, roomCode);
    }
    const connection = preferenceConnection({
      UserModel, ioInstance, socket,
      MessageModel: { find() { return { sort() { return this; }, limit() { return this; }, async lean() { return []; } }; } },
      logger: { error(...args) { logs.push(args); } },
      ...(row.authentication === 'terminally quarantined' ? {
        ChatServerModel: {
          async find() { return []; },
          async findOne() { return { code: 'ABC123', owner: 'owner', moderators: [] }; }
        },
        RoomRestrictionModel: { async find() { return []; }, async findOne() { return null; } },
        getRoomRoleFn: async () => 'user'
      } : {})
    });

    if (row.authentication === 'terminally quarantined') {
      const switchAck = acknowledge();
      await socket.trigger('switch_server', 'ABC123', switchAck.callback);
      assert.deepEqual(switchAck.value(), { error: 'Failed to switch server.' }, row.name);
    }

    const sequence = [];
    for (const live of [socket, sameAccount, observer]) {
      const originalEmit = live.emit.bind(live);
      live.emit = (event, payload) => {
        if (event === 'preferences_updated') sequence.push(`event:${live.id}`);
        originalEmit(event, payload);
      };
    }
    const ack = acknowledge();
    await connection.socket.trigger('update_preferences', row.payload, value => {
      sequence.push('ack');
      ack.callback(value);
    });

    assert.deepEqual(ack.value(), row.ack, `${row.name}: exact acknowledgement`);
    assert.deepEqual(Object.keys(ack.value()).sort(), Object.keys(row.ack).sort(), `${row.name}: acknowledgement keys`);
    assert.equal(writes, row.writes, `${row.name}: write count`);
    assert.equal(UserModel.rows[0].preferencesVersion ?? 0, row.rowVersion, `${row.name}: stored version`);
    const preferenceEvents = [socket, sameAccount, observer].flatMap(live =>
      live.outbound.filter(item => item.event === 'preferences_updated').map(item => ({ id: live.id, payload: item.payload })));
    assert.deepEqual(preferenceEvents.map(item => item.id).sort(), [...row.recipients].sort(), `${row.name}: recipients`);
    assert.deepEqual(sequence, [...row.recipients.map(id => `event:${id}`), 'ack'], `${row.name}: event-before-ack order`);
    for (const exposed of [ack.value(), ...preferenceEvents.map(item => item.payload)]) {
      if (exposed.preferences) {
        assert.deepEqual(Object.keys(exposed.preferences).sort(),
          ['compactMessages', 'motion', 'textScale', 'theme'], `${row.name}: safe preference keys`);
        assert.equal(Number.isSafeInteger(exposed.preferencesVersion), true, `${row.name}: safe version`);
      }
    }
    const serializedLogs = logs.flatMap(args => args.map(value => value instanceof Error
      ? `${value.name}:${value.message}` : JSON.stringify(value))).join('|');
    assert.doesNotMatch(`${JSON.stringify({ acknowledgement: ack.value(), preferenceEvents })}|${serializedLogs}`,
      /PREFERENCE_SECRET|DATABASE_SECRET_SENTINEL|hostilePreference|hostileWinner|hostileExtra/,
      `${row.name}: no unknown or sentinel disclosure`);
  }
});
