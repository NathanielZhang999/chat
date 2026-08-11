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
  UserSchema,
  createConnectionHandler
} = require('../server');
const { FakeSocket, FakeIo, acknowledge } = require('./support/fakes');

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
