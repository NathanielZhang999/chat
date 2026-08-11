const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const chatPath = path.resolve(__dirname, '../../chat.html');
const startDelimiter = 'TESTABLE_CLIENT_HELPERS_START';
const endDelimiter = 'TESTABLE_CLIENT_HELPERS_END';

function loadHelpers() {
  const source = fs.readFileSync(chatPath, 'utf8');
  const start = source.indexOf(startDelimiter);
  const end = source.indexOf(endDelimiter);

  assert.notEqual(start, -1, `missing ${startDelimiter}`);
  assert.notEqual(end, -1, `missing ${endDelimiter}`);
  assert.ok(end > start, 'client helper delimiters are out of order');

  const helperBlock = source.slice(start + startDelimiter.length, end);
  const context = vm.createContext({ URL });
  vm.runInContext(helperBlock, context, { filename: 'chat-client-helpers.js' });
  return new Proxy(context.ChatClientHelpers, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        if (['moderationActionsFor', 'restrictionActionsFor'].includes(property)) return [...result];
        if (property === 'normalizeModerationPrompt' && result) return { ...result };
        if ([
          'normalizeReportPrompt',
          'dispatchModerationReport',
          'normalizeResolutionPrompt',
          'normalizeAutoModPrompt',
          'moderatorCenterRequestFor',
          'moderatorCenterMutationRequestFor'
        ].includes(property) && result) return structuredClone(result);
        return result;
      };
    }
  });
}

test('new users receive the deployed Render backend URL by default', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(
    source,
    /id="url-input"[^>]*value="https:\/\/chat-backend-iekp\.onrender\.com"/
  );
});

test('browser title and AutoMod message-rate controls are exact', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /<title>Chat v1\.3\.2<\/title>/);
  assert.match(source, /id="automod-message-limit"[^>]*min="1"[^>]*max="20"/);
  assert.match(source, /id="automod-message-window"[^>]*min="1"[^>]*max="60"/);
});

test('client motion policy avoids broad transitions and respects reduced motion', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.doesNotMatch(source, /transition:\s*all\b/);
  assert.doesNotMatch(source, /transition:\s*(?:\d+(?:\.\d+)?s|var\(--motion-[^)]+\))(?:\s|;|})/);
  assert.doesNotMatch(source, /cubic-bezier\([^)]*,\s*1\.[0-9]+\s*\)/);
  assert.match(source, /--ease-standard:\s*cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\)/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(source, /\.no-enter-animation\s*\{[^}]*animation:\s*none/s);
  assert.match(source, /#chat-window\s*\{[^}]*scroll-behavior:\s*auto/s);
});

test('reduced motion keeps user rows visible without transition delays', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const reducedMotionStart = source.indexOf('@media (prefers-reduced-motion: reduce)');
  const reducedMotionRule = source.slice(reducedMotionStart, source.indexOf('</style>', reducedMotionStart));

  assert.notEqual(reducedMotionStart, -1, 'reduced-motion rule is present');
  assert.match(reducedMotionRule, /transition-delay:\s*0s\s*!important/);
  assert.match(reducedMotionRule, /\.user-item\s*\{[^}]*opacity:\s*1\s*!important/s);
  assert.match(reducedMotionRule, /\.user-item\.offline\s*\{[^}]*opacity:\s*0\.5\s*!important/s);
});

test('system messages use the shared base motion timing', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(
    source,
    /\.system-msg\s*\{[^}]*animation:\s*fadePop\s+var\(--motion-base\)\s+var\(--ease-standard\)/s
  );
});

function createClientSocket(initiallyConnected = false) {
  const listeners = new Map();
  const emitted = [];
  return {
    connected: initiallyConnected,
    listeners,
    emitted,
    on(event, handler) {
      const handlers = listeners.get(event) || [];
      handlers.push(handler);
      listeners.set(event, handlers);
    },
    once(event, handler) {
      const onceHandler = (...args) => {
        this.off(event, onceHandler);
        handler(...args);
      };
      this.on(event, onceHandler);
    },
    off(event, handler) {
      if (!listeners.has(event)) return;
      if (!handler) return listeners.delete(event);
      listeners.set(event, listeners.get(event).filter(candidate => candidate !== handler));
    },
    emit(event, ...args) { emitted.push({ event, args }); },
    deliver(event, payload) {
      for (const handler of [...(listeners.get(event) || [])]) handler(payload);
    }
  };
}

function appearanceElements() {
  return {
    theme: { value: '' },
    textScale: { value: '' },
    compactMessages: { value: '' },
    motion: { value: '' }
  };
}

function appearanceRoot() {
  const values = {};
  return {
    values,
    setAttribute(name, value) { values[name] = String(value); },
    removeAttribute(name) { delete values[name]; }
  };
}

test('client appearance normalization matches the server allowlist', () => {
  const helpers = loadHelpers();
  const base = { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' };
  for (const [key, allowed] of Object.entries({
    theme: ['dark', 'light'],
    textScale: [100, 112.5, 125],
    compactMessages: [false, true],
    motion: ['system', 'reduce']
  })) {
    for (const value of allowed) {
      assert.deepEqual({ ...helpers.normalizeAppearancePreferences({ ...base, [key]: value }) }, { ...base, [key]: value });
    }
  }
  for (const key of Object.keys(base)) {
    const candidate = { ...base };
    delete candidate[key];
    assert.equal(helpers.normalizeAppearancePreferences(candidate), null);
  }
  for (const candidate of [
    null, [], { ...base, extra: true }, { ...base, theme: 1 },
    { ...base, textScale: '100' }, { ...base, compactMessages: 0 }, { ...base, motion: false }
  ]) assert.equal(helpers.normalizeAppearancePreferences(candidate), null);
  const first = helpers.defaultAppearancePreferences();
  const second = helpers.defaultAppearancePreferences();
  assert.deepEqual({ ...first }, base);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
});

test('appearance cache keys are normalized and account scoped', () => {
  const helpers = loadHelpers();
  assert.equal(
    helpers.appearanceCacheKey('HTTPS://Example.COM/', ' Alice '),
    'pro_chat_appearance:https%3A%2F%2Fexample.com:alice'
  );
  assert.equal(helpers.appearanceCacheKey('https://example.com', 'Ａlice'), 'pro_chat_appearance:https%3A%2F%2Fexample.com:alice');
  assert.notEqual(helpers.appearanceCacheKey('https://example.com', 'Alice'), helpers.appearanceCacheKey('https://example.com', 'Bob'));
  assert.equal(helpers.appearanceCacheKey('javascript:alert(1)', 'Alice'), null);
  assert.equal(helpers.appearanceCacheKey('https://example.com', 'bad name'), null);
});

test('identical usernames on different backend origins never share appearance cache', () => {
  const helpers = loadHelpers();
  const one = helpers.appearanceCacheKey('https://one.example/', 'Alice');
  const two = helpers.appearanceCacheKey('https://two.example', 'Alice');
  assert.notEqual(one, two);
  assert.equal(one, helpers.appearanceCacheKey('HTTPS://ONE.EXAMPLE', 'alice'));
});

test('corrupt appearance cache falls back without throwing', () => {
  const helpers = loadHelpers();
  const valid = { preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' }, preferencesVersion: 8 };
  assert.deepEqual(structuredClone(helpers.normalizeStoredAppearanceSnapshot(valid)), valid);
  for (const value of [null, {}, { ...valid, preferencesVersion: -1 }, { ...valid, preferencesVersion: '8' },
    { ...valid, preferences: { ...valid.preferences, extra: true } }, { ...valid, extra: true }]) {
    assert.equal(helpers.normalizeStoredAppearanceSnapshot(value), null);
  }
});

test('versioned appearance accepts newer and idempotent equal snapshots but rejects older snapshots', () => {
  const helpers = loadHelpers();
  const dark = { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' };
  const light = { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' };
  const current = { preferences: dark, preferencesVersion: 4 };
  assert.deepEqual(structuredClone(helpers.acceptVersionedPreferences(current, { preferences: dark, preferencesVersion: 3 })), {
    accepted: false, changed: false, snapshot: current
  });
  assert.deepEqual(structuredClone(helpers.acceptVersionedPreferences(current, { preferences: dark, preferencesVersion: 4 })), {
    accepted: true, changed: false, snapshot: current
  });
  assert.deepEqual(structuredClone(helpers.acceptVersionedPreferences(current, { preferences: light, preferencesVersion: 4 })), {
    accepted: false, changed: false, snapshot: current
  });
  assert.deepEqual(structuredClone(helpers.acceptVersionedPreferences(current, { preferences: light, preferencesVersion: 5 })), {
    accepted: true, changed: true, snapshot: { preferences: light, preferencesVersion: 5 }
  });
});

test('appearance form reads and renders all exact values', () => {
  const helpers = loadHelpers();
  for (const preferences of [
    { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
    { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' },
    { theme: 'light', textScale: 125, compactMessages: false, motion: 'system' }
  ]) {
    const elements = appearanceElements();
    helpers.applyAppearanceForm(elements, preferences);
    assert.deepEqual({ ...helpers.readAppearanceForm(elements) }, preferences);
  }
});

test('appearance controls expose exact labels options and associations', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const expected = {
    'appearance-theme': ['Dark', 'Light'],
    'appearance-text-scale': ['Normal', 'Large', 'Extra Large'],
    'appearance-compact': ['Off', 'On'],
    'appearance-motion': ['Follow device', 'Reduce motion']
  };
  for (const [id, copy] of Object.entries(expected)) {
    assert.match(source, new RegExp(`<label\\s+for=["']${id}["'][^>]*>`, 'i'), id);
    const control = source.match(new RegExp(`<select[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'));
    assert.ok(control, `${id} select is present`);
    assert.deepEqual([...control[1].matchAll(/<option[^>]*>([^<]+)<\/option>/gi)].map(match => match[1].trim()), copy);
  }
  for (const id of ['save-appearance-btn', 'appearance-status']) assert.match(source, new RegExp(`id=["']${id}["']`));
  const viewport = source.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);
  assert.ok(viewport);
  assert.doesNotMatch(viewport[1], /maximum-scale|user-scalable\s*=\s*no/i);
});

test('effective reduced motion combines the account preference and device query', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.effectiveReducedMotion({ motion: 'system' }, false), false);
  assert.equal(helpers.effectiveReducedMotion({ motion: 'system' }, true), true);
  assert.equal(helpers.effectiveReducedMotion({ motion: 'reduce' }, false), true);
  assert.equal(helpers.effectiveReducedMotion({ motion: 'reduce' }, true), true);
});

function authenticatedAppearanceFixture({ storage } = {}) {
  const helpers = loadHelpers();
  const socket = createClientSocket(true);
  const session = helpers.createSessionContextCoordinator();
  session.replace(socket);
  session.connected(socket);
  session.authenticate(socket);
  const rootElement = appearanceRoot();
  const formElements = appearanceElements();
  const statuses = [];
  const writes = [];
  const persistence = storage || {
    values: new Map(),
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, value); writes.push({ key, value }); }
  };
  const emitted = [];
  const controller = helpers.createAppearanceController({
    getSessionContext: () => session.snapshot(),
    getBackendUrl: () => 'https://one.example',
    getUsername: () => 'Alice',
    storage: persistence,
    rootElement,
    formElements,
    deviceReducedMotion: () => false,
    onStatus: value => statuses.push(value),
    onPendingChange: () => {},
    emitUpdate(payload, callback) { emitted.push({ payload, callback }); }
  });
  return { helpers, socket, session, rootElement, formElements, statuses, writes, persistence, emitted, controller };
}

test('appearance cache ignores throwing reads and writes only authoritative snapshots', () => {
  const readFailure = authenticatedAppearanceFixture({
    getItem() { throw new Error('storage denied'); },
    setItem() { throw new Error('storage denied'); }
  });
  assert.doesNotThrow(() => readFailure.controller.applyProvisionalCache('https://one.example', 'Alice'));
  const accepted = assert.doesNotThrow(() => readFailure.controller.acceptAuthoritative('https://one.example', 'Alice', {
    preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' },
    preferencesVersion: 2
  }));
  assert.equal(accepted, undefined);

  const fixture = authenticatedAppearanceFixture();
  const cached = { preferences: { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' }, preferencesVersion: 9 };
  fixture.persistence.values.set(fixture.helpers.appearanceCacheKey('https://one.example', 'Alice'), JSON.stringify(cached));
  fixture.controller.applyProvisionalCache('https://one.example', 'Alice');
  assert.equal(fixture.writes.length, 0, 'provisional reads never write');
  fixture.formElements.theme.value = 'dark';
  assert.equal(fixture.writes.length, 0, 'form edits never write');
  const pending = fixture.controller.beginSave({ theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' });
  assert.ok(pending);
  assert.equal(fixture.writes.length, 0, 'pending saves never write');
  fixture.controller.finishSave(pending.token, {}, { success: true, preferences: cached.preferences, preferencesVersion: 10 });
  assert.equal(fixture.writes.length, 0, 'wrong-socket callbacks never write');
  fixture.controller.finishSave(pending.token, fixture.socket, { error: 'rejected' });
  assert.equal(fixture.writes.length, 0, 'errors never write');
  fixture.controller.acceptAuthoritative('https://one.example', 'Alice', cached);
  assert.equal(fixture.writes.length, 1, 'authoritative login writes once');
});

test('login appearance overrides a stale per-account cache', () => {
  const fixture = authenticatedAppearanceFixture();
  const key = fixture.helpers.appearanceCacheKey('https://one.example', 'Alice');
  fixture.persistence.values.set(key, JSON.stringify({
    preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' },
    preferencesVersion: 90
  }));
  fixture.controller.applyProvisionalCache('https://one.example', 'Alice');
  assert.equal(fixture.rootElement.values['data-theme'], 'light');
  const login = fixture.controller.acceptAuthoritative('https://one.example', 'Alice', {
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
    preferencesVersion: 2
  });
  assert.equal(login.accepted, true);
  assert.equal(fixture.rootElement.values['data-theme'], 'dark');
  assert.equal(JSON.parse(fixture.persistence.values.get(key)).preferencesVersion, 2);
});

test('appearance save sends the complete expected-version payload and rejects stale acknowledgements', () => {
  const fixture = authenticatedAppearanceFixture();
  fixture.controller.acceptAuthoritative('https://one.example', 'Alice', {
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' }, preferencesVersion: 4
  });
  fixture.writes.length = 0;
  const desired = { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' };
  const request = fixture.controller.beginSave(desired);
  assert.deepEqual(structuredClone(request.payload), { preferences: desired, expectedVersion: 4 });
  assert.deepEqual(structuredClone(fixture.emitted[0].payload), { preferences: desired, expectedVersion: 4 });
  assert.equal(fixture.controller.beginSave(desired), null, 'only one save may be pending');
  fixture.session.invalidate();
  fixture.controller.resetToDefaults();
  fixture.emitted[0].callback({ success: true, preferences: desired, preferencesVersion: 5 });
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.controller.current().preferencesVersion, 0);

  fixture.session.connected(fixture.socket);
  fixture.session.authenticate(fixture.socket);
  fixture.controller.acceptAuthoritative('https://one.example', 'Alice', {
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' }, preferencesVersion: 4
  });
  fixture.writes.length = 0;
  const retry = fixture.controller.beginSave(desired);
  fixture.emitted.at(-1).callback({
    error: 'Settings changed on another device.',
    preferences: { theme: 'light', textScale: 125, compactMessages: false, motion: 'reduce' },
    preferencesVersion: 6
  });
  assert.equal(fixture.controller.current().preferencesVersion, 6);
  assert.equal(fixture.writes.length, 1, 'current version mismatch reconciles and caches');
  assert.equal(fixture.controller.finishSave(retry.token, fixture.socket, {}), null, 'completed token is single use');
});

test('preference events from replaced sockets and older versions have no effect', () => {
  const fixture = authenticatedAppearanceFixture();
  const oldSocket = fixture.socket;
  fixture.controller.acceptAuthoritative('https://one.example', 'Alice', {
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' }, preferencesVersion: 4
  });
  fixture.writes.length = 0;
  assert.equal(fixture.controller.handleEvent(oldSocket, {
    preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' }, preferencesVersion: 3
  }).accepted, false);
  const replacement = createClientSocket(true);
  fixture.session.replace(replacement);
  fixture.session.connected(replacement);
  fixture.session.authenticate(replacement);
  assert.equal(fixture.controller.handleEvent(oldSocket, {
    preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' }, preferencesVersion: 5
  }), null);
  assert.equal(fixture.rootElement.values['data-theme'], 'dark');
  assert.equal(fixture.writes.length, 0);
});

test('same-object disconnect and reconnect invalidate authenticated appearance work', () => {
  const fixture = authenticatedAppearanceFixture();
  const guard = fixture.helpers.createSessionDispatchGuard({
    sessionCoordinator: fixture.session,
    getActiveSocket: () => fixture.socket,
    getCurrentRoomCode: () => 'global',
    getClientContextId: () => 1
  });
  const before = guard.capture(fixture.socket, { serverCode: 'global', clientContextId: 1 });
  const save = fixture.controller.beginSave({ theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' });
  fixture.session.disconnect(fixture.socket);
  fixture.socket.connected = true;
  fixture.session.connected(fixture.socket);
  fixture.session.authenticate(fixture.socket);
  assert.equal(guard.acceptCallback(before, { serverCode: 'global', clientContextId: 1 }), false);
  fixture.controller.finishSave(save.token, fixture.socket, {
    success: true,
    preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' },
    preferencesVersion: 1
  });
  assert.equal(fixture.controller.current().preferencesVersion, 0);
});

test('login clicked while disconnected authenticates on the connected generation', () => {
  const helpers = loadHelpers();
  const socket = createClientSocket(false);
  const session = helpers.createSessionContextCoordinator();
  session.replace(socket);
  const applied = [];
  const authResults = [];
  const preferenceEvents = [];
  const appearance = {
    applyProvisionalCache(backendUrl, username) { applied.push(['provisional', backendUrl, username]); },
    acceptAuthoritative(backendUrl, username, snapshot) { applied.push(['authoritative', backendUrl, username, snapshot]); return { accepted: true }; },
    resetToDefaults() { applied.push(['defaults']); },
    handleEvent(socketReference, response) { preferenceEvents.push({ socketReference, response }); return { accepted: true }; },
    beginSave() { return null; }
  };
  const bridge = helpers.createAppearanceRuntimeBridge({
    sessionCoordinator: session,
    appearanceController: appearance,
    getActiveSocket: () => socket,
    enterSanitizedUnauthenticatedState: reason => authResults.push(['sanitized', reason]),
    onAuthenticated: response => authResults.push(['authenticated', response.username]),
    onAuthFailure: error => authResults.push(['failed', error])
  });
  bridge.bindSocket(socket);
  bridge.selectAuthCandidate('https://one.example', 'Alice');
  assert.equal(bridge.beginConnectedAuth(socket), null);
  socket.connected = true;
  socket.deliver('connect');
  const token = bridge.beginConnectedAuth(socket);
  assert.ok(token);
  bridge.finishAuth(token, 'https://one.example', 'Alice', {
    username: 'Alice',
    preferences: { theme: 'light', textScale: 112.5, compactMessages: true, motion: 'reduce' },
    preferencesVersion: 1
  });
  assert.equal(session.snapshot().authenticated, true);
  assert.deepEqual(applied.map(entry => entry[0]), ['provisional', 'authoritative']);
  const priorGenerationPreferenceHandler = socket.listeners.get('preferences_updated')[0];

  socket.connected = false;
  socket.deliver('disconnect');
  socket.connected = true;
  socket.deliver('connect');
  const reconnectToken = bridge.beginConnectedAuth(socket);
  assert.ok(reconnectToken);
  assert.notEqual(reconnectToken.session.generation, token.session.generation);
  assert.equal(bridge.finishAuth(token, 'https://one.example', 'Alice', { username: 'Alice' }), null);
  bridge.finishAuth(reconnectToken, 'https://one.example', 'Alice', { error: 'bad password' });
  assert.equal(session.snapshot().authenticated, false);
  assert.deepEqual(authResults.at(-1), ['failed', 'bad password']);

  const malformedToken = bridge.beginConnectedAuth(socket);
  const malformedResult = bridge.finishAuth(malformedToken, 'https://one.example', 'Alice', { username: 'Alice' });
  assert.equal(malformedResult.accepted, false);
  assert.equal(session.snapshot().authenticated, false, 'malformed authority cannot authenticate');

  const finalToken = bridge.beginConnectedAuth(socket);
  bridge.finishAuth(finalToken, 'https://one.example', 'Alice', {
    username: 'Alice',
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
    preferencesVersion: 2
  });
  const currentPreferenceHandler = socket.listeners.get('preferences_updated')[0];
  assert.notEqual(currentPreferenceHandler, priorGenerationPreferenceHandler);
  priorGenerationPreferenceHandler({
    preferences: { theme: 'light', textScale: 125, compactMessages: true, motion: 'reduce' },
    preferencesVersion: 99
  });
  assert.equal(preferenceEvents.length, 0, 'retired generation listener rejects delayed events');
  currentPreferenceHandler({
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
    preferencesVersion: 2
  });
  assert.equal(preferenceEvents.length, 1, 'current generation listener accepts the event');
});

test('disconnect and account change sanitize prior room state before another account authenticates', () => {
  const helpers = loadHelpers();
  const state = {
    history: ['ALICE_PRIVATE_MESSAGE_SENTINEL'], members: ['Alice'], room: 'SECRET1',
    servers: { SECRET1: true }, roles: ['admin'], typing: ['Alice'], composition: 'draft',
    attachment: 'data:alice', dialogs: ['history'], requests: ['switch'], audio: ['ping'], navigation: ['SECRET1'],
    auth: false
  };
  const sanitizer = helpers.createUnauthenticatedStateSanitizer({
    clearHistory: () => { state.history = []; },
    clearMembers: () => { state.members = []; },
    clearRoomState: () => { state.room = null; },
    clearServerState: () => { state.servers = {}; },
    resetRoles: () => { state.roles = []; },
    resetTyping: () => { state.typing = []; },
    resetComposition: () => { state.composition = ''; },
    resetAttachment: () => { state.attachment = null; },
    closeRoomDialogs: () => { state.dialogs = []; },
    invalidateRequests: () => { state.requests = []; },
    unbindAuthenticatedEvents: () => {},
    clearAudio: () => { state.audio = []; },
    clearNavigation: () => { state.navigation = []; },
    showAuthentication: () => { state.auth = true; }
  });
  sanitizer.sanitize('disconnect');
  assert.deepEqual(state, {
    history: [], members: [], room: null, servers: {}, roles: [], typing: [], composition: '', attachment: null,
    dialogs: [], requests: [], audio: [], navigation: [], auth: true
  });
  assert.doesNotThrow(() => sanitizer.sanitize('account-change'));

  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /function enterSanitizedUnauthenticatedState\(reason\)\s*\{\s*return unauthenticatedStateSanitizer\.sanitize\(reason\);\s*\}/s);
  assert.match(source, /appearanceRuntimeBridge\.selectAuthCandidate\(url,\s*user\)/);
  assert.match(source, /appearanceRuntimeBridge\.beginConnectedAuth\(authSocket\)/);
  assert.match(source, /appearanceRuntimeBridge\.finishAuth\(authToken,\s*url,\s*user,\s*res\)/);
  assert.match(source, /save-appearance-btn[\s\S]*saveAppearanceSettings/);
  assert.match(source, /createAuthenticatedListenerTable/);
  assert.match(source, /createGuardedAcknowledgementAdapter/);
  assert.match(source, /dispatchModeratorCenterRequest\([\s\S]*captureAcknowledgement:/);
  assert.match(source, /list_room_restrictions[\s\S]{0,500}guardedRequestAcknowledgement\('moderation'/);
});

test('production unauthenticated owners erase action history and room controls', () => {
  const helpers = loadHelpers();
  const state = {
    chat: 'ALICE_PRIVATE_MESSAGE_SENTINEL', historyDetail: 'ALICE_PRIVATE_HISTORY_SENTINEL',
    members: ['Alice'], room: 'SECRET1', servers: ['SECRET1'], role: 'admin', typing: ['Alice'],
    composition: 'alice draft', attachment: 'data:alice', infoBarVisible: true, sendLabel: 'Save',
    dialogs: ['history'], requests: ['switch'], bound: true, audio: ['ping'], navigation: ['SECRET1'],
    controls: Object.fromEntries(['invite', 'leave', 'delete', 'join', 'moderate'].map(name => [name, 'block'])),
    authVisible: false, authReason: null
  };
  const owners = helpers.createProductionUnauthenticatedOwners({
    clearChatHistory: () => { state.chat = ''; },
    clearHistoryDetails: () => { state.historyDetail = ''; },
    clearMembers: () => { state.members = []; },
    clearRoomState: () => { state.room = null; },
    clearServerState: () => { state.servers = []; },
    resetRoles: () => { state.role = 'user'; },
    resetTyping: () => { state.typing = []; },
    resetCompositionState: () => { state.composition = ''; },
    cancelAction: () => { state.infoBarVisible = false; state.sendLabel = 'Send'; },
    resetAttachment: () => { state.attachment = null; },
    closeRoomDialogs: () => { state.dialogs = []; },
    invalidateRequestState: () => { state.requests = []; },
    unbindAuthenticatedEvents: () => { state.bound = false; },
    clearAudio: () => { state.audio = []; },
    clearNavigationState: () => { state.navigation = []; },
    hideRoomControls: () => { for (const name of Object.keys(state.controls)) state.controls[name] = 'none'; },
    showAuthentication: reason => { state.authVisible = true; state.authReason = reason; }
  });
  const sanitizer = helpers.createUnauthenticatedStateSanitizer(owners);
  const socket = createClientSocket(true);
  const session = helpers.createSessionContextCoordinator();
  session.replace(socket);
  session.connected(socket);
  const bridge = helpers.createAppearanceRuntimeBridge({
    sessionCoordinator: session,
    appearanceController: {
      applyProvisionalCache() {}, resetToDefaults() {},
      acceptAuthoritative() { return { accepted: true }; }, handleEvent() {}, beginSave() {}
    },
    getActiveSocket: () => socket,
    enterSanitizedUnauthenticatedState: reason => sanitizer.sanitize(reason)
  });
  bridge.bindSocket(socket);
  const token = bridge.beginConnectedAuth(socket);
  bridge.finishAuth(token, 'https://one.example', 'Alice', {
    username: 'Alice',
    preferences: { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' },
    preferencesVersion: 1
  });
  socket.connected = false;
  socket.deliver('disconnect');
  assert.deepEqual(state, {
    chat: '', historyDetail: '', members: [], room: null, servers: [], role: 'user', typing: [],
    composition: '', attachment: null, infoBarVisible: false, sendLabel: 'Send', dialogs: [], requests: [],
    bound: false, audio: [], navigation: [], controls: {
      invite: 'none', leave: 'none', delete: 'none', join: 'none', moderate: 'none'
    }, authVisible: true, authReason: 'disconnect'
  });
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /createProductionUnauthenticatedOwners\(\{[\s\S]*clearHistoryDetails:\s*closeMessageHistory[\s\S]*cancelAction,[\s\S]*hideRoomControls\(\)/,
    'production delegates history, action, and room-control cleanup into the executed owner factory');
});

test('authenticated surface stays covered until initial room or lobby is accepted', () => {
  const helpers = loadHelpers();
  const socket = createClientSocket(true);
  const session = helpers.createSessionContextCoordinator();
  session.replace(socket);
  session.connected(socket);
  let authVisible = true;
  const gate = helpers.createAuthenticatedSurfaceGate({
    showAuthentication: () => { authVisible = true; },
    showAuthenticated: () => { authVisible = false; }
  });
  const preferences = { theme: 'dark', textScale: 100, compactMessages: false, motion: 'system' };
  const bridge = helpers.createAppearanceRuntimeBridge({
    sessionCoordinator: session,
    appearanceController: {
      applyProvisionalCache() {}, resetToDefaults() {},
      acceptAuthoritative() { return { accepted: true }; }, handleEvent() {}, beginSave() {}
    },
    getActiveSocket: () => socket,
    authenticatedSurfaceGate: gate
  });
  bridge.bindSocket(socket);
  const token = bridge.beginConnectedAuth(socket);
  bridge.finishAuth(token, 'https://one.example', 'Bob', {
    username: 'Bob', preferences, preferencesVersion: 1
  });
  assert.equal(authVisible, true, 'successful auth remains covered while the initial room is unresolved');

  helpers.applySwitchResult({
    currentServerCode: null, targetServerCode: 'global', response: { error: 'switch failed' },
    showAlert() {}, applySuccess() { gate.acceptRoom(); }
  });
  assert.equal(authVisible, true, 'failed initial switch cannot reveal the blank lobby');
  helpers.applySwitchResult({
    currentServerCode: null, targetServerCode: 'global', response: { history: [] },
    showAlert() {}, applySuccess() { gate.acceptRoom(); }
  });
  assert.equal(authVisible, false, 'accepted initial room reveals the authenticated surface');
  gate.hold('account-change');
  gate.acceptLobby();
  assert.equal(authVisible, false, 'explicit no-access lobby resolution reveals the neutral lobby');
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /createAppearanceRuntimeBridge\(\{[\s\S]{0,400}authenticatedSurfaceGate/);
  assert.match(source, /function enterLobby\(\)[\s\S]*authenticatedSurfaceGate\.acceptLobby\(\)/);
  assert.match(source, /applySuccess\([\s\S]*authenticatedSurfaceGate\.acceptRoom\(\)/);
});

test('sanitized sessions reject prior socket events and delayed room and detail callbacks', () => {
  const helpers = loadHelpers();
  let activeSocket = createClientSocket(true);
  const aliceSocket = activeSocket;
  const session = helpers.createSessionContextCoordinator();
  session.replace(aliceSocket);
  session.connected(aliceSocket);
  session.authenticate(aliceSocket);
  let room = 'SECRET1';
  let contextId = 7;
  const mutations = [];
  const guard = helpers.createSessionDispatchGuard({
    sessionCoordinator: session,
    getActiveSocket: () => activeSocket,
    getCurrentRoomCode: () => room,
    getClientContextId: () => contextId
  });
  const listenerTable = helpers.createAuthenticatedListenerTable({
    chatMessage: value => mutations.push(['chat', value.text]),
    onlineUsers: value => mutations.push(['members', value.length])
  });
  const bindingToken = guard.capture(aliceSocket, { serverCode: room, clientContextId: contextId });
  const binding = helpers.createAuthenticatedSocketBinder({ socket: aliceSocket, bindingToken, dispatchGuard: guard, listenerTable });
  const handlerMap = helpers.createAcknowledgementHandlerMap({
    switchHistorySuccess: response => mutations.push(['switch', response.history]),
    switchHistoryError: response => mutations.push(['error', response.error]),
    editHistorySuccess: response => mutations.push(['edit', response.history]),
    editHistoryError: response => mutations.push(['error', response.error]),
    deletedMessageSuccess: response => mutations.push(['deleted', response.text]),
    deletedMessageError: response => mutations.push(['error', response.error])
  });
  const acknowledgements = helpers.createGuardedAcknowledgementAdapter({ dispatchGuard: guard, handlers: handlerMap });
  const switchAck = acknowledgements.capture('switchHistory', aliceSocket, { serverCode: room, clientContextId: contextId });
  const editAck = acknowledgements.capture('editHistory', aliceSocket, { serverCode: room, clientContextId: contextId, messageId: 'm1' });
  const deletedAck = acknowledgements.capture('deletedMessage', aliceSocket, { serverCode: room, clientContextId: contextId, messageId: 'm1' });
  assert.equal(guard.acceptSocket(bindingToken, { serverCode: 'invalid room' }), false);
  assert.equal(guard.acceptSocket(bindingToken, { clientContextId: 0 }), false);
  assert.equal(guard.acceptSocket(bindingToken, { messageId: '' }), false);

  activeSocket = createClientSocket(true);
  session.replace(activeSocket);
  session.connected(activeSocket);
  session.authenticate(activeSocket);
  room = null;
  contextId += 1;
  aliceSocket.deliver('chat_message', { serverCode: 'SECRET1', clientContextId: 7, text: 'ALICE_PRIVATE_MESSAGE_SENTINEL' });
  aliceSocket.deliver('online_users', [{ username: 'Alice' }]);
  switchAck({ history: ['ALICE_PRIVATE_MESSAGE_SENTINEL'], serverCode: 'SECRET1', clientContextId: 7 });
  editAck({ history: ['ALICE_PRIVATE_MESSAGE_SENTINEL'], serverCode: 'SECRET1', clientContextId: 7, messageId: 'm1' });
  deletedAck({ text: 'ALICE_PRIVATE_MESSAGE_SENTINEL', serverCode: 'SECRET1', clientContextId: 7, messageId: 'm1' });
  switchAck({ error: 'ALICE_PRIVATE_ERROR_SENTINEL', serverCode: 'SECRET1', clientContextId: 7 });
  assert.deepEqual(mutations, []);
  binding.unbind();
  binding.unbind();
  assert.equal((aliceSocket.listeners.get('chat_message') || []).length, 0);

  activeSocket = aliceSocket;
  aliceSocket.connected = false;
  session.replace(aliceSocket);
  session.connected(aliceSocket);
  session.authenticate(aliceSocket);
  const sameObjectToken = guard.capture(aliceSocket, {});
  session.disconnect(aliceSocket);
  aliceSocket.connected = true;
  session.connected(aliceSocket);
  session.authenticate(aliceSocket);
  assert.equal(guard.acceptSocket(sameObjectToken), false);
});

test('complete authenticated listener binding rejects retired force logout generations', () => {
  const helpers = loadHelpers();
  const socket = createClientSocket(true);
  const session = helpers.createSessionContextCoordinator();
  session.replace(socket);
  session.connected(socket);
  session.authenticate(socket);
  const calls = [];
  const dependencyNames = {
    chatMessage: 'chat_message', systemMessage: 'system_message', globalRoleUpdated: 'global_role_updated',
    roomRoleUpdated: 'room_role_updated', roomAccessUpdated: 'room_access_updated',
    roomRestrictionUpdated: 'room_restriction_updated', moderationQueueUpdated: 'moderation_queue_updated',
    messageBlocked: 'message_blocked', profileUpdated: 'profile_updated', messageEdited: 'message_edited',
    messageDeleted: 'message_deleted', reactionUpdated: 'reaction_updated', adminNewServer: 'admin_new_server',
    serverDeleted: 'server_deleted', onlineUsers: 'online_users', typing: 'typing', forceLogout: 'force_logout'
  };
  const dependencies = Object.fromEntries(Object.entries(dependencyNames).map(([name, event]) =>
    [name, () => calls.push(event)]));
  const guard = helpers.createSessionDispatchGuard({
    sessionCoordinator: session, getActiveSocket: () => socket,
    getCurrentRoomCode: () => 'global', getClientContextId: () => 1
  });
  const table = helpers.createAuthenticatedListenerTable(dependencies);
  const firstToken = guard.capture(socket, {});
  const firstBinding = helpers.createAuthenticatedSocketBinder({ socket, bindingToken: firstToken, dispatchGuard: guard, listenerTable: table });
  const oldForceLogout = socket.listeners.get('force_logout')[0];
  for (const event of Object.values(dependencyNames)) {
    socket.deliver(event, event === 'message_deleted' ? 'm1' : {});
  }
  assert.deepEqual(calls, Object.values(dependencyNames), 'the production table binds every authenticated event');

  session.disconnect(socket);
  socket.connected = false;
  socket.connected = true;
  session.connected(socket);
  session.authenticate(socket);
  oldForceLogout('ALICE_FORCE_LOGOUT_SENTINEL');
  assert.equal(calls.filter(value => value === 'force_logout').length, 1,
    'a retired same-object generation cannot execute force logout');
  firstBinding.unbind();
  const currentToken = guard.capture(socket, {});
  helpers.createAuthenticatedSocketBinder({ socket, bindingToken: currentToken, dispatchGuard: guard, listenerTable: table });
  socket.deliver('force_logout', 'BOB_FORCE_LOGOUT_SENTINEL');
  assert.equal(calls.filter(value => value === 'force_logout').length, 2,
    'the current authenticated generation still receives force logout');
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.doesNotMatch(source, /activeSocket\.on\(['"]force_logout['"]/);
  assert.match(source, /authenticatedEventTarget\.on\(['"]force_logout['"]/);
});

test('light theme and compact mode expose semantic attributes tokens and touch-target rules', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const selector of [':root,', ':root[data-theme="dark"]', ':root[data-theme="light"]',
    ':root[data-text-scale="112.5"]', ':root[data-text-scale="125"]',
    ':root[data-density="compact"] .msg', ':root[data-density="compact"] .msg-avatar',
    ':root[data-motion="reduce"] *']) assert.match(source, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const token of ['--page-bg', '--panel-bg', '--panel-subtle', '--input-bg', '--text-strong', '--text-normal',
    '--text-muted', '--border-color', '--overlay-bg', '--hover-bg', '--focus-ring', '--disabled-text']) {
    assert.match(source, new RegExp(`${token}:`));
  }
  for (const selector of ['body', '.modal', '.modal-box', '#servers-sidebar', '#chat-window', '#online-sidebar',
    '.context-menu', '.emoji-picker-container', '.hist-item', 'input.text-input', 'button.btn-primary', '.moderator-row']) {
    assert.match(source, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*var\\(--`, 's'), selector);
  }
  assert.match(source, /button[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(source, /data-density="compact"[^}]*font-size/s);
  assert.doesNotMatch(source, /color:\s*var\(--(?:error|primary|success|warning)\)(?:\s|;|!)/,
    'text selectors use foreground tokens rather than filled-surface aliases');
});

test('dark and light semantic text colors meet WCAG contrast ratios', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const blocks = [...source.matchAll(/:root(?:,\s*:root\[data-theme="dark"\]|\[data-theme="light"\])\s*\{([^}]+)\}/g)];
  assert.ok(blocks.length >= 2, 'dark and light token blocks are present');
  const parse = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(match => [match[1], match[2]]));
  const dark = parse(blocks[0][1]);
  const light = parse(blocks.find(match => match[0].includes('light'))[1]);
  const channel = value => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const luminance = hex => 0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(parseInt(hex.slice(3, 5), 16)) + 0.0722 * channel(parseInt(hex.slice(5, 7), 16));
  const ratio = (foreground, background) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  const textPairs = [
    ['--text-strong', '--panel-bg'], ['--text-normal', '--panel-bg'], ['--text-muted', '--panel-bg'],
    ['--placeholder-text', '--input-bg'], ['--primary-text', '--panel-bg'], ['--error-text', '--panel-bg'],
    ['--success-text', '--panel-bg'], ['--warning-text', '--panel-bg'], ['--disabled-text', '--panel-bg'],
    ['--on-primary', '--primary-surface'], ['--on-error', '--error-surface'], ['--on-success', '--success-surface'],
    ['--on-warning', '--warning-surface'], ['--badge-text', '--badge-surface']
  ];
  for (const [theme, tokens] of [['dark', dark], ['light', light]]) {
    for (const [foreground, background] of textPairs) {
      assert.ok(tokens[foreground] && tokens[background], `${theme} defines ${foreground}/${background}`);
      assert.ok(ratio(tokens[foreground], tokens[background]) >= 4.5, `${theme} ${foreground} on ${background}`);
    }
    for (const surface of ['--page-bg', '--panel-bg']) {
      assert.ok(ratio(tokens['--focus-ring'], tokens[surface]) >= 3, `${theme} focus ring on ${surface}`);
    }
    for (const surface of ['--panel-bg', '--panel-subtle']) {
      assert.ok(tokens['--primary-indicator'], `${theme} defines --primary-indicator`);
      assert.ok(ratio(tokens['--primary-indicator'], tokens[surface]) >= 3,
        `${theme} primary indicator on ${surface}`);
    }
    for (const indicator of ['--border-color']) {
      for (const surface of ['--panel-bg', '--panel-subtle']) {
        assert.ok(ratio(tokens[indicator], tokens[surface]) >= 3,
          `${theme} ${indicator} on ${surface}`);
      }
    }
    const replyOpacityMatch = source.match(/\.reply-text\s*\{[^}]*opacity:\s*([\d.]+)/s);
    const replyOpacity = replyOpacityMatch ? Number(replyOpacityMatch[1]) : 1;
    const blend = (foreground, background, alpha) => {
      const channels = [1, 3, 5].map(index => Math.round(
        parseInt(foreground.slice(index, index + 2), 16) * alpha +
        parseInt(background.slice(index, index + 2), 16) * (1 - alpha)
      ));
      return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}`;
    };
    assert.ok(ratio(blend(tokens['--text-muted'], tokens['--panel-bg'], replyOpacity), tokens['--panel-bg']) >= 4.5,
      `${theme} effective reply text on panel`);
  }
  for (const selector of ['.tab.active', '.compose-addon.show', '.hist-item', '.moderator-row']) {
    assert.match(source, new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{[^}]*var\\(--primary-indicator\\)`, 's'),
      `${selector} uses the primary indicator token`);
  }
  for (const selector of ['.auth-tabs', '.reply-context::before', '.chat-img', '.system-msg::before, .system-msg::after']) {
    assert.match(source, new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\{[^}]*var\\(--border-color\\)`, 's'),
      `${selector} uses a contrast-safe divider or connector token`);
  }
});

test('context-menu removal waits for the shared base motion duration', () => {
  const helpers = loadHelpers();
  let scheduled;
  let removed = false;

  const timerId = helpers.removeAfterBaseMotion(
    (callback, delay) => {
      scheduled = { callback, delay };
      return 'timer-id';
    },
    () => { removed = true; }
  );

  assert.equal(timerId, 'timer-id');
  assert.equal(scheduled.delay, 220);
  assert.equal(removed, false);
  scheduled.callback();
  assert.equal(removed, true);
});

test('scroll policy preserves readers and separates history from live motion', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.isNearScrollEnd({ scrollHeight: 1000, scrollTop: 600, clientHeight: 320 }), true);
  assert.equal(helpers.isNearScrollEnd({ scrollHeight: 1000, scrollTop: 300, clientHeight: 320 }), false);

  assert.deepEqual(
    { ...helpers.messageRenderPolicy({ history: true, wasNearBottom: true }) },
    { animate: false, shouldScroll: false, behavior: 'auto' }
  );
  assert.deepEqual(
    { ...helpers.messageRenderPolicy({ history: false, wasNearBottom: true }) },
    { animate: true, shouldScroll: true, behavior: 'smooth' }
  );
  assert.deepEqual(
    { ...helpers.messageRenderPolicy({ history: false, wasNearBottom: false }) },
    { animate: true, shouldScroll: false, behavior: 'smooth' }
  );
});

test('scroll coordinator coalesces requests and gives instant scroll priority', () => {
  const helpers = loadHelpers();
  const frames = [];
  const calls = [];
  const scroller = { scrollHeight: 900, scrollTo(options) { calls.push(options); } };
  const coordinator = helpers.createScrollCoordinator(callback => frames.push(callback), () => scroller);

  coordinator.request('smooth');
  coordinator.request('smooth');
  coordinator.request('auto');
  assert.equal(frames.length, 1);
  assert.equal(calls.length, 0);

  frames.shift()();
  assert.deepEqual({ ...calls[0] }, { top: 900, behavior: 'auto' });
});

test('scroll coordinator makes smooth requests instant for reduced motion', () => {
  const helpers = loadHelpers();
  const frames = [];
  const calls = [];
  const scroller = { scrollHeight: 900, scrollTo(options) { calls.push(options); } };
  const coordinator = helpers.createScrollCoordinator(
    callback => frames.push(callback),
    () => scroller,
    () => true
  );

  coordinator.request('smooth');
  frames.shift()();

  assert.deepEqual({ ...calls[0] }, { top: 900, behavior: 'auto' });
});

test('reply navigation uses the effective reduced-motion policy', () => {
  const helpers = loadHelpers();
  const calls = [];
  const targets = {
    normal: {
      classList: { contains: () => false },
      scrollIntoView: options => calls.push(['normal', options]), style: {}
    },
    reduced: {
      classList: { contains: () => false },
      scrollIntoView: options => calls.push(['reduced', options]), style: {}
    }
  };
  let reduce = false;
  const navigate = helpers.createReplyNavigationHandler({
    findTarget: id => targets[id] || null,
    prefersReducedMotion: () => reduce,
    highlight: target => { target.style.background = 'highlight'; },
    clearHighlight: target => { target.style.background = 'clear'; },
    schedule: callback => { callback(); }
  });
  assert.equal(navigate('normal'), true);
  reduce = true;
  assert.equal(navigate('reduced'), true);
  assert.deepEqual(calls.map(([name, options]) => [name, { ...options }]), [
    ['normal', { behavior: 'smooth', block: 'center' }],
    ['reduced', { behavior: 'auto', block: 'center' }]
  ]);
  assert.equal(targets.reduced.style.background, 'clear');
  assert.equal(navigate('missing'), false);
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /createReplyNavigationHandler\(\{[\s\S]{0,300}prefersReducedMotion/);
});

test('backend URLs allow only HTTP and HTTPS', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.normalizeBackendUrl('example.com/'), 'https://example.com');
  assert.equal(helpers.normalizeBackendUrl('localhost:3000/'), 'https://localhost:3000');
  assert.equal(helpers.normalizeBackendUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(helpers.normalizeBackendUrl('javascript:alert(1)'), null);
});

test('changing backend URL disconnects and replaces the old socket', () => {
  const helpers = loadHelpers();
  let disconnected = 0;
  const oldSocket = { disconnect() { disconnected += 1; } };
  const ioFactory = url => ({ url });
  assert.equal(helpers.replaceSocket(oldSocket, 'https://a.test', 'https://a.test', ioFactory).socket, oldSocket);
  assert.equal(disconnected, 0);
  assert.equal(helpers.replaceSocket(oldSocket, 'https://a.test', 'https://b.test', ioFactory).socket.url, 'https://b.test');
  assert.equal(disconnected, 1);
});

test('stored markup is assigned as text rather than interpreted HTML', () => {
  const helpers = loadHelpers();
  const parent = { children: [], appendChild(child) { this.children.push(child); } };
  const doc = { createElement: tagName => ({ tagName, className: '', textContent: '' }) };
  const child = helpers.appendTextElement(doc, parent, 'span', 'name', '<img src=x>');
  assert.equal(child.textContent, '<img src=x>');
});

test('typing display falls back to username', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.typingDisplayName({ username: 'alice', displayName: 'Alice' }), 'Alice');
  assert.equal(helpers.typingDisplayName({ username: 'alice' }), 'alice');
});

test('client renders and sounds only exact canonical ping tokens', () => {
  const helpers = loadHelpers();
  assert.equal(typeof helpers.formatTrustedPings, 'function');
  assert.equal(typeof helpers.hasTrustedPing, 'function');

  const canonical = helpers.formatTrustedPings(
    'hello {{PING:alice|Alice Smith}}', 'alice', 'Alice Smith'
  );
  assert.equal(canonical.isPinged, true);
  assert.equal(canonical.html.includes('<span class="ping-tag">@Alice Smith</span>'), true);
  assert.equal(helpers.hasTrustedPing('{{PING:alice|Alice Smith}}', 'alice', 'Alice Smith'), true);
  assert.equal(helpers.hasTrustedPing('{{PING:everyone|everyone}}', 'alice', 'Alice Smith'), true);

  for (const malformed of [
    '{{PING:alice|A{lice}}}',
    '{{PING:alice|Alice|extra}}',
    '{{PING:alice|{{PING:bob|Bob}}}}',
    '{{PING:alice|Alice Smith',
    '{{PING:alice|Alice Smith}}}'
  ]) {
    const result = helpers.formatTrustedPings(malformed, 'alice', 'Alice Smith');
    assert.equal(result.isPinged, false, malformed);
    assert.equal(result.html.includes('ping-tag'), false, malformed);
    assert.equal(helpers.hasTrustedPing(malformed, 'alice', 'Alice Smith'), false, malformed);
  }
});

test('client attachment validation accepts only bounded raster data URLs', () => {
  const helpers = loadHelpers();
  assert.equal(typeof helpers.sanitizeAttachment, 'function');
  assert.equal(helpers.sanitizeAttachment('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(helpers.sanitizeAttachment('data:image/svg+xml;base64,AAAA'), null);
  assert.equal(helpers.sanitizeAttachment('javascript:alert(1)'), null);
  assert.equal(helpers.sanitizeAttachment('https://example.test/image.png'), null);
});

test('production connect-error binding mutates auth controls only for the active socket and modal', () => {
  const helpers = loadHelpers();

  for (const scenario of [
    { name: 'active socket and modal', current: true, modal: true, expectedDisabled: false, expectedErrors: 1 },
    { name: 'stale socket', current: false, modal: true, expectedDisabled: true, expectedErrors: 0 },
    { name: 'closed modal', current: true, modal: false, expectedDisabled: true, expectedErrors: 0 }
  ]) {
    const handlers = {};
    const activeSocket = { on(event, handler) { handlers[event] = handler; } };
    const otherSocket = {};
    const authButton = { disabled: true };
    const errors = [];

    helpers.bindConnectErrorRecovery({
      activeSocket,
      getCurrentSocket: () => scenario.current ? activeSocket : otherSocket,
      isAuthModalActive: () => scenario.modal,
      authButton,
      showError: (message, success) => errors.push({ message, success })
    });
    assert.equal(typeof handlers.connect_error, 'function', scenario.name);
    handlers.connect_error();
    assert.equal(authButton.disabled, scenario.expectedDisabled, scenario.name);
    assert.equal(errors.length, scenario.expectedErrors, scenario.name);
    if (scenario.expectedErrors) {
      assert.deepEqual(errors[0], {
        message: 'Unable to connect. Check the backend URL and try again.',
        success: false
      });
    }
  }
});

test('production switch helper owns rejection and success mutation boundaries', () => {
  const helpers = loadHelpers();
  const alerts = [];
  const mutations = [];

  const rejected = helpers.applySwitchResult({
    currentServerCode: 'AAAAAA',
    targetServerCode: 'BBBBBB',
    response: { error: 'Denied.' },
    showAlert: (...args) => alerts.push(args),
    applySuccess: (...args) => mutations.push(args)
  });
  assert.equal(rejected.currentServerCode, 'AAAAAA');
  assert.deepEqual(alerts, [['Error', 'Denied.']]);
  assert.deepEqual(mutations, []);

  const accepted = helpers.applySwitchResult({
    currentServerCode: 'AAAAAA',
    targetServerCode: 'BBBBBB',
    response: { history: [], roomRole: 'user' },
    showAlert: () => { throw new Error('must not alert'); },
    applySuccess: (code, response) => mutations.push([code, response.roomRole])
  });
  assert.equal(accepted.currentServerCode, 'BBBBBB');
  assert.deepEqual(mutations, [['BBBBBB', 'user']]);
});

test('room switches serialize and retain only the latest queued target', () => {
  const helpers = loadHelpers();
  const acknowledgements = [];
  const events = [];
  const coordinator = helpers.createSwitchCoordinator(
    (target, callback) => {
      events.push(`emit:${target}`);
      acknowledgements.push(callback);
    },
    target => events.push(`handle:${target}`)
  );

  coordinator.request('AAAAAA');
  coordinator.request('BBBBBB');
  coordinator.request('CCCCCC');

  assert.deepEqual(events, ['emit:AAAAAA']);
  acknowledgements[0]({ history: [] });
  assert.deepEqual(events, ['emit:AAAAAA', 'handle:AAAAAA', 'emit:CCCCCC']);
  assert.equal(events.includes('emit:BBBBBB'), false);

  acknowledgements[1]({ history: [] });
  assert.deepEqual(events, [
    'emit:AAAAAA', 'handle:AAAAAA', 'emit:CCCCCC', 'handle:CCCCCC'
  ]);
});

test('room switch queue advances after an error acknowledgement', () => {
  const helpers = loadHelpers();
  const acknowledgements = [];
  const events = [];
  const coordinator = helpers.createSwitchCoordinator(
    (target, callback) => {
      events.push(`emit:${target}`);
      acknowledgements.push(callback);
    },
    (target, result) => events.push(`handle:${target}:${result.error || 'ok'}`)
  );

  coordinator.request('AAAAAA');
  coordinator.request('BBBBBB');
  acknowledgements[0]({ error: 'Denied.' });

  assert.deepEqual(events, [
    'emit:AAAAAA', 'handle:AAAAAA:Denied.', 'emit:BBBBBB'
  ]);
});

test('room switch coordinator reports pending state', () => {
  const helpers = loadHelpers();
  let acknowledgeSwitch;
  const coordinator = helpers.createSwitchCoordinator(
    (_target, callback) => { acknowledgeSwitch = callback; },
    () => {}
  );

  assert.equal(coordinator.isPending(), false);
  coordinator.request('BBBBBB');
  assert.equal(coordinator.isPending(), true);
  acknowledgeSwitch({ history: [] });
  assert.equal(coordinator.isPending(), false);
});

test('selecting the displayed room while another switch is pending returns to it', () => {
  const helpers = loadHelpers();
  const acknowledgements = [];
  const emissions = [];
  let displayedRoom = 'AAAAAA';
  const coordinator = helpers.createSwitchCoordinator(
    (target, callback) => {
      emissions.push(target);
      acknowledgements.push(callback);
    },
    (target, result) => {
      if (!result.error) displayedRoom = target;
    }
  );
  const selectRoom = target => {
    if (displayedRoom === target && !coordinator.isPending()) return;
    coordinator.request(target);
  };

  selectRoom('BBBBBB');
  selectRoom('AAAAAA');
  assert.deepEqual(emissions, ['BBBBBB']);

  acknowledgements[0]({ history: [] });
  assert.equal(displayedRoom, 'BBBBBB');
  assert.deepEqual(emissions, ['BBBBBB', 'AAAAAA']);

  acknowledgements[1]({ history: [] });
  assert.equal(displayedRoom, 'AAAAAA');
  assert.equal(coordinator.isPending(), false);
});

test('client moderation menu matches global and exact private-room policy', () => {
  const client = loadHelpers();
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'global', actorRole: 'admin', actorRoomRole: 'user', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  }), ['timeout', 'ban']);
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'ABC123', actorRole: 'user', actorRoomRole: 'mod', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: true, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  }), ['unban']);
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'XYZ789', actorRole: 'user', actorRoomRole: 'user', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  }), []);
  assert.deepEqual(client.moderationActionsFor({
    serverCode: 'global', actorRole: 'admin', actorRoomRole: 'user', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'NYZhang1', isSelf: false
  }), []);
});

test('private menu exposes only the target-specific moderation transitions', () => {
  const client = loadHelpers();
  const base = {
    serverCode: 'ABC123', actorRole: 'user', actorRoomRole: 'mod', targetRole: 'user',
    targetRoomRole: 'user', targetUsername: 'Member', isSelf: false
  };

  assert.deepEqual(client.moderationActionsFor({
    ...base, targetIsBanned: false, targetIsTimedOut: false
  }), ['kick', 'timeout', 'ban']);
  assert.deepEqual(client.moderationActionsFor({
    ...base, targetIsBanned: false, targetIsTimedOut: true
  }), ['kick', 'clear_timeout', 'ban']);
  assert.deepEqual(client.moderationActionsFor({
    ...base, targetIsBanned: true, targetIsTimedOut: false
  }), ['unban']);
  assert.deepEqual(client.moderationActionsFor({
    ...base, targetRole: 'admin', targetIsBanned: false, targetIsTimedOut: false
  }), []);
  assert.deepEqual(client.moderationActionsFor({
    ...base, targetRoomRole: 'mod', targetIsBanned: false, targetIsTimedOut: false
  }), []);
  assert.deepEqual(client.moderationActionsFor({
    ...base, actorRole: 'admin', targetRoomRole: 'mod', targetIsBanned: false,
    targetIsTimedOut: false
  }), ['kick', 'timeout', 'ban']);
});

test('moderation prompt requires bounded reason and timeout duration', () => {
  const client = loadHelpers();
  assert.deepEqual(client.normalizeModerationPrompt({ action: 'timeout', reason: ' spam ', duration: '1h' }), { action: 'timeout', reason: 'spam', duration: '1h' });
  assert.equal(client.normalizeModerationPrompt({ action: 'timeout', reason: '', duration: '1h' }), null);
  assert.equal(client.normalizeModerationPrompt({ action: 'timeout', reason: 'spam', duration: '2h' }), null);
});

test('production client wires moderation coordinators and direct room events', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const event of [
    'room_access_updated', 'room_restriction_updated', 'moderation_queue_updated', 'message_blocked'
  ]) {
    assert.match(source, new RegExp(`authenticatedEventTarget\\.on\\(['"]${event}['"]`), event);
  }
  assert.match(source, /createAuthenticatedListenerTable\(listenerDependencies\)/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(res,\s*['"]defaultServerCode['"]\)/);
  assert.match(source, /if\s*\(initialCode\)\s*switchServer\(initialCode\);\s*else\s*enterLobby\(\);/s);
  assert.match(source, /roomAccessCoordinator\.handleAccessUpdate\(data\)/);
  assert.match(source, /roomAccessCoordinator\.handleRestrictionUpdate\(data\)/);
  assert.match(source, /dispatchModeratorCenterRequest/);
  assert.match(source, /appendModerationItemRow/);
  assert.doesNotMatch(source, /internalSecret|storageSecret/);
});

test('production dialog acknowledgements are bound to the exact open prompt request', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const functionSource = name => {
    const start = source.indexOf(`function ${name}()`);
    assert.notEqual(start, -1, `${name} exists`);
    const next = source.indexOf('\n    function ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
  };

  for (const [name, coordinator, dispatchMarker] of [
    ['submitModerationAction', 'moderationDialogCoordinator', 'moderate_user'],
    ['submitReport', 'reportDialogCoordinator', 'dispatchModerationReport'],
    ['submitResolution', 'resolutionDialogCoordinator', 'resolve_moderation_report']
  ]) {
    const block = functionSource(name);
    assert.match(block, new RegExp(`const token = ${coordinator}\\.begin\\(request\\.identity\\)`));
    assert.match(block, new RegExp(dispatchMarker));
    assert.match(block, new RegExp(`if \\(!${coordinator}\\.finish\\(token\\)\\) return`));
    assert.match(
      block,
      new RegExp(`response => \\{\\s*if \\(!${coordinator}\\.finish\\(token\\)\\) return`),
      `${name} makes acknowledgement validation the callback's first statement`
    );
    const callbackStart = block.indexOf('response =>');
    const acknowledgementGuard = block.indexOf(`${coordinator}.finish(token)`);
    const resultHandling = block.indexOf('const result =');
    assert.ok(
      callbackStart > block.indexOf(dispatchMarker) &&
        acknowledgementGuard > callbackStart &&
        resultHandling > acknowledgementGuard,
      `${name} validates inside its acknowledgement before any result handling`
    );
    assert.doesNotMatch(
      block.slice(callbackStart, acknowledgementGuard),
      /close(?:Moderation|Report|Resolution)Prompt|showAppAlert|\.textContent|\.disabled/,
      `${name} performs no UI mutation before validating the acknowledgement`
    );
  }

  assert.match(source, /if \(socket !== previousSocket\)[\s\S]{0,400}enterSanitizedUnauthenticatedState\('socket-replacement'\)/);
});

function createDeferredSocket() {
  const calls = [];
  return {
    calls,
    emit(event, payload, callback) { calls.push({ event, payload, callback }); }
  };
}

function createTextOnlyDocument() {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = '';
      this.children = [];
      this._textContent = '';
    }
    appendChild(child) { this.children.push(child); return child; }
    set textContent(value) { this._textContent = value == null ? '' : String(value); }
    get textContent() { return this._textContent; }
    set innerHTML(_value) { throw new Error('unsafe HTML assignment'); }
  }
  return { createElement: tagName => new Element(tagName), Element };
}

test('behavioral moderation helpers build exact report, resolution, and AutoMod payloads', () => {
  const client = loadHelpers();
  const reportSocket = createDeferredSocket();
  const base = {
    serverCode: 'ABC123', actorRole: 'user', actorRoomRole: 'mod', targetRole: 'user',
    targetRoomRole: 'user', targetIsBanned: false, targetIsTimedOut: false,
    targetUsername: 'Member', isSelf: false
  };
  assert.deepEqual(client.moderationActionsFor(base), ['kick', 'timeout', 'ban']);
  assert.deepEqual(client.moderationActionsFor({ ...base, isSelf: true }), []);
  assert.deepEqual(client.moderationActionsFor({ ...base, targetUsername: 'System' }), []);
  assert.deepEqual(client.moderationActionsFor({ ...base, targetRole: 'admin' }), []);
  assert.deepEqual(client.moderationActionsFor({ ...base, serverCode: 'global', actorRole: 'admin', actorRoomRole: 'user' }), ['timeout', 'ban']);

  assert.deepEqual(client.normalizeReportPrompt({
    serverCode: 'ABC123', targetUser: 'Member', reason: ' abuse '
  }), { serverCode: 'ABC123', targetUser: 'Member', reason: 'abuse' });
  assert.deepEqual(client.normalizeReportPrompt({
    serverCode: 'ABC123', targetUser: 'Member', messageId: '507f1f77bcf86cd799439011', reason: ' spam '
  }), {
    serverCode: 'ABC123', targetUser: 'Member', messageId: '507f1f77bcf86cd799439011', reason: 'spam'
  });
  assert.equal(client.normalizeReportPrompt({ serverCode: 'ABC123', targetUser: 'Member', reason: '' }), null);
  client.dispatchModerationReport(reportSocket, {
    serverCode: 'ABC123', targetUser: 'Member', reason: ' user abuse '
  }, () => {});
  client.dispatchModerationReport(reportSocket, {
    serverCode: 'ABC123', targetUser: 'Member', messageId: 'message-1', reason: ' message spam '
  }, () => {});
  assert.deepEqual(reportSocket.calls.map(call => ({
    event: call.event,
    payload: structuredClone(call.payload)
  })), [
    {
      event: 'report_moderation_target',
      payload: { serverCode: 'ABC123', targetUser: 'Member', reason: 'user abuse' }
    },
    {
      event: 'report_moderation_target',
      payload: {
        serverCode: 'ABC123', targetUser: 'Member', messageId: 'message-1', reason: 'message spam'
      }
    }
  ]);

  assert.deepEqual(client.normalizeResolutionPrompt({
    serverCode: 'ABC123', reportId: '507f1f77bcf86cd799439012', status: 'dismissed', resolution: ' duplicate '
  }), {
    serverCode: 'ABC123', reportId: '507f1f77bcf86cd799439012', status: 'dismissed', resolution: 'duplicate'
  });
  assert.equal(client.normalizeResolutionPrompt({
    serverCode: 'ABC123', reportId: '507f1f77bcf86cd799439012', status: 'open', resolution: 'no'
  }), null);

  assert.deepEqual(client.normalizeAutoModPrompt({
    keywordsText: ' Spam\nspoilers ', mentionLimit: '4', repeatLimit: '5', repeatWindowSeconds: '60',
    messageLimit: '5', messageWindowSeconds: '5'
  }), {
    blockedKeywords: ['spam', 'spoilers'], mentionLimit: 4, repeatLimit: 5, repeatWindowSeconds: 60,
    messageLimit: 5, messageWindowSeconds: 5
  });
  for (const input of [
    { messageLimit: '0' }, { messageLimit: '21' },
    { messageWindowSeconds: '0' }, { messageWindowSeconds: '61' },
    { messageLimit: '1.5' }, { messageWindowSeconds: '2.5' },
    { messageLimit: undefined }, { messageWindowSeconds: undefined },
    { messageLimit: 'wat' }, { messageWindowSeconds: 'wat' }
  ]) {
    assert.equal(client.normalizeAutoModPrompt({
      keywordsText: 'spam', mentionLimit: '4', repeatLimit: '5', repeatWindowSeconds: '60',
      messageLimit: '5', messageWindowSeconds: '5', ...input
    }), null);
  }
  assert.equal(client.normalizeAutoModPrompt({
    keywordsText: 'spam', mentionLimit: '21', repeatLimit: '5', repeatWindowSeconds: '60',
    messageLimit: '5', messageWindowSeconds: '5'
  }), null);

  const elements = {
    keywords: { value: '' }, mentionLimit: { value: '' }, repeatLimit: { value: '' },
    repeatWindowSeconds: { value: '' }, messageLimit: { value: '' }, messageWindowSeconds: { value: '' }
  };
  client.applyAutoModForm(elements, {
    blockedKeywords: ['spam'], mentionLimit: 4, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 7, messageWindowSeconds: 12
  });
  assert.equal(elements.messageLimit.value, 7);
  assert.equal(elements.messageWindowSeconds.value, 12);
  elements.messageLimit.value = 5;
  elements.messageWindowSeconds.value = 9;
  const read = client.readAutoModForm(elements);
  assert.deepEqual(client.normalizeAutoModPrompt(read), {
    blockedKeywords: ['spam'], mentionLimit: 4, repeatLimit: 3, repeatWindowSeconds: 30,
    messageLimit: 5, messageWindowSeconds: 9
  });
});

test('behavioral moderation row renderer keeps hostile API text inert', () => {
  const client = loadHelpers();
  const doc = createTextOnlyDocument();
  const list = new doc.Element('div');
  const rendered = client.appendModerationItemRow(doc, list, 'report', {
    targetUsername: '<img src=x onerror=alert(1)>',
    reporterUsername: 'Reporter',
    status: 'open',
    reason: '<script>steal()</script>',
    createdAt: 1,
    internalSecret: 'must-not-render',
    storageSecret: 'also-private'
  }, value => `date:${value}`);

  assert.equal(list.children.length, 1);
  assert.equal(rendered.title.textContent, '@<img src=x onerror=alert(1)> — open');
  assert.equal(rendered.detail.textContent.includes('<script>steal()</script>'), true);
  assert.equal(rendered.detail.textContent.includes('must-not-render'), false);
  assert.equal(rendered.detail.textContent.includes('also-private'), false);
});

test('behavioral room access coordinator suppresses banned switches and applies unban events', () => {
  const client = loadHelpers();
  let currentRoom = 'ABC123';
  const switched = [];
  const rendered = [];
  const restrictions = [];
  let lobbyEntries = 0;
  const access = client.createRoomAccessCoordinator({
    getCurrentRoom: () => currentRoom,
    requestSwitch: code => switched.push(code),
    enterLobby: () => { lobbyEntries += 1; currentRoom = null; },
    renderAccess: rooms => rendered.push([...rooms]),
    applyRestriction: (data, room) => restrictions.push({ data, room })
  });

  access.replaceBannedRooms(['global']);
  assert.equal(access.requestRoom('global'), false);
  assert.equal(access.requestRoom('XYZ789'), true);
  assert.deepEqual(switched, ['XYZ789']);

  access.handleRestrictionUpdate({ serverCode: 'global', banned: false, bannedRooms: [] });
  assert.deepEqual(rendered.at(-1), []);
  assert.equal(access.requestRoom('global'), true);
  assert.deepEqual(switched, ['XYZ789', 'global']);

  access.handleAccessUpdate({ serverCode: null, bannedRooms: ['global'] });
  assert.equal(lobbyEntries, 1);
  assert.deepEqual([...access.bannedRooms()], ['global']);

  currentRoom = 'ABC123';
  access.handleRestrictionUpdate({
    serverCode: 'ABC123', banned: false, timedOut: true,
    timeoutUntil: '2026-08-08T22:00:00.000Z', bannedRooms: []
  });
  assert.equal(restrictions.length, 1);
  assert.equal(restrictions[0].room, 'ABC123');
});

test('behavioral lobby and restriction coordinators disable controls and reject stale expiry work', () => {
  const client = loadHelpers();
  let typingClears = 0;
  const discoveryActions = [{ disabled: true }, { disabled: true }];
  const elements = {
    messageInput: { disabled: false }, sendButton: { disabled: false },
    attachmentButton: { disabled: false }, emojiButton: { disabled: false },
    infoBar: { textContent: '' }, roomLabel: '',
    messageActions: [{ disabled: false }, { disabled: false }],
    roomDiscoveryActions: discoveryActions,
    typingState: { clear() { typingClears += 1; } }
  };
  client.applyLobbyState(elements, true);
  assert.equal(elements.messageActions.every(action => action.disabled), true);
  assert.equal(typingClears, 1);
  assert.equal(elements.messageInput.disabled, true);
  assert.equal(elements.sendButton.disabled, true);
  assert.equal(discoveryActions.every(action => !action.disabled), true, 'join/create remain available');

  let room = null;
  let handled = 0;
  assert.equal(client.dispatchRoomEvent(room, () => { handled += 1; }, {}), false);
  room = 'ABC123';
  assert.equal(client.dispatchRoomEvent(room, () => { handled += 1; }, {}), true);
  assert.equal(handled, 1);

  let now = 1_000;
  let nextTimerId = 0;
  const timers = new Map();
  const canceled = [];
  const states = [];
  const restrictions = client.createRestrictionCoordinator({
    schedule(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) { canceled.push(id); },
    now: () => now,
    getCurrentRoom: () => room,
    applyState: state => states.push({ ...state })
  });

  restrictions.apply({ timedOut: true, timeoutUntil: 1_100 }, 'ABC123');
  const staleTimer = timers.get(1);
  assert.equal(states.at(-1).timedOut, true);
  restrictions.apply({ timedOut: false, timeoutUntil: null }, 'ABC123');
  staleTimer.callback();
  assert.equal(states.at(-1).timedOut, false);
  assert.deepEqual(canceled, [1]);

  restrictions.apply({ timedOut: true, timeoutUntil: 1_200 }, 'ABC123');
  room = 'XYZ789';
  const roomScopedStateCount = states.length;
  timers.get(2).callback();
  assert.equal(states.length, roomScopedStateCount, 'old-room expiry cannot enable the new room');

  room = 'ABC123';
  restrictions.apply({ timedOut: true, timeoutUntil: 1_200 }, 'ABC123');
  now = 1_200;
  timers.get(3).callback();
  assert.equal(states.at(-1).timedOut, false);
});

test('moderator center rejects same-room close and reopen callbacks by epoch', () => {
  const client = loadHelpers();
  const socket = createDeferredSocket();
  const center = client.createModeratorCenterCoordinator();
  const applied = [];

  center.open('ABC123', 'reports');
  const oldRequest = client.moderatorCenterRequestFor({
    tab: 'reports', roomCode: 'ABC123', status: 'open'
  });
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: oldRequest,
    apply: response => applied.push(`old:${response.items[0]}`)
  });

  center.close();
  center.open('ABC123', 'reports');
  const newRequest = client.moderatorCenterRequestFor({
    tab: 'reports', roomCode: 'ABC123', status: 'open'
  });
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: newRequest,
    apply: response => applied.push(`new:${response.items[0]}`)
  });

  socket.calls[0].callback({ items: ['stale'] });
  assert.deepEqual(applied, []);
  socket.calls[1].callback({ items: ['fresh'] });
  assert.deepEqual(applied, ['new:fresh']);
});

test('moderator center rejects rapid report-filter and stale audit-cursor responses', () => {
  const client = loadHelpers();
  const socket = createDeferredSocket();
  const pending = new Map();
  const center = client.createModeratorCenterCoordinator({
    onPendingChange: (key, value) => pending.set(key, value)
  });
  const applied = [];
  center.open('ABC123', 'reports');

  for (const status of ['open', 'resolved']) {
    const request = client.moderatorCenterRequestFor({
      tab: 'reports', roomCode: 'ABC123', status
    });
    client.dispatchModeratorCenterRequest({
      coordinator: center, socket, request,
      apply: response => applied.push(`${status}:${response.items[0]}`)
    });
  }
  assert.deepEqual(socket.calls.map(call => call.payload.status), ['open', 'resolved']);
  socket.calls[0].callback({ items: ['stale-open'] });
  socket.calls[1].callback({ items: ['fresh-resolved'] });
  assert.deepEqual(applied, ['resolved:fresh-resolved']);

  center.selectView('audit');
  const cursorRequest = client.moderatorCenterRequestFor({
    tab: 'audit', roomCode: 'ABC123', before: 'cursor-1', append: true
  });
  const firstCursorToken = client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: cursorRequest, blockWhilePending: true,
    apply: response => applied.push(`cursor:${response.items[0]}`)
  });
  const duplicateCursorToken = client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: cursorRequest, blockWhilePending: true,
    apply: () => applied.push('duplicate')
  });
  assert.ok(firstCursorToken);
  assert.equal(duplicateCursorToken, null);
  assert.equal(pending.get('audit:list'), true, 'load-more is disabled while its request is pending');

  const refreshRequest = client.moderatorCenterRequestFor({
    tab: 'audit', roomCode: 'ABC123', append: false
  });
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: refreshRequest,
    apply: response => applied.push(`refresh:${response.items[0]}`)
  });
  assert.equal(socket.calls.at(-1).event, 'get_moderation_audit');
  assert.equal(Object.prototype.hasOwnProperty.call(socket.calls.at(-1).payload, 'before'), false);
  socket.calls[2].callback({ items: ['stale-page'] });
  socket.calls[3].callback({ items: ['fresh-page'] });
  assert.deepEqual(applied, ['resolved:fresh-resolved', 'refresh:fresh-page']);
  assert.equal(pending.get('audit:list'), false, 'latest response re-enables load-more');
});

test('moderator center request builders cover restrictions, audit, resolve, and AutoMod safely', () => {
  const client = loadHelpers();
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /function renderAutoModSettings[\s\S]*ChatClientHelpers\.applyAutoModForm\(autoModFormElements\(\), autoMod\)/);
  assert.match(source, /function saveAutoModSettings[\s\S]*ChatClientHelpers\.readAutoModForm\(autoModFormElements\(\)\)/);
  assert.match(source, /function autoModFormElements\(\)[\s\S]*automod-message-limit[\s\S]*automod-message-window/);
  assert.deepEqual(client.restrictionActionsFor({
    targetUsername: 'absent-from-roster', banned: true, timedOut: false
  }), ['unban']);
  assert.deepEqual(client.restrictionActionsFor({
    targetUsername: 'absent-from-roster', banned: true, timedOut: true
  }), ['unban', 'clear_timeout']);
  assert.deepEqual(client.moderatorCenterRequestFor({
    tab: 'restrictions', roomCode: 'ABC123', before: 'cursor-r'
  }).payload, { serverCode: 'ABC123', limit: 20, before: 'cursor-r' });
  assert.deepEqual(client.moderatorCenterRequestFor({
    tab: 'audit', roomCode: 'ABC123', before: 'cursor-a'
  }).payload, { serverCode: 'ABC123', limit: 20, before: 'cursor-a' });
  assert.deepEqual(client.moderatorCenterRequestFor({
    tab: 'automod', roomCode: 'ABC123'
  }).payload, { serverCode: 'ABC123' });

  const socket = createDeferredSocket();
  const center = client.createModeratorCenterCoordinator();
  const applied = [];
  center.open('ABC123', 'automod');
  const getRequest = client.moderatorCenterRequestFor({ tab: 'automod', roomCode: 'ABC123' });
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: getRequest,
    apply: response => applied.push(response.autoMod.mentionLimit)
  });
  center.close();
  center.open('ABC123', 'automod');
  socket.calls[0].callback({ autoMod: { mentionLimit: 99 } });
  assert.deepEqual(applied, []);

  const autoModPayload = {
    serverCode: 'ABC123', blockedKeywords: ['spam'], mentionLimit: 4,
    repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 7, messageWindowSeconds: 12
  };
  const autoModSave = client.moderatorCenterMutationRequestFor('automod', autoModPayload);
  assert.deepEqual({
    event: autoModSave.event, key: autoModSave.key, view: autoModSave.view, payload: autoModSave.payload
  }, {
    event: 'update_automod', key: 'automod:save', view: 'automod', payload: autoModPayload
  });
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: autoModSave,
    apply: () => applied.push('stale-save')
  });
  center.close();
  center.open('ABC123', 'automod');
  socket.calls[1].callback({ ok: true });
  assert.deepEqual(applied, []);

  center.selectView('restrictions');
  const restrictionRequest = client.moderatorCenterRequestFor({
    tab: 'restrictions', roomCode: 'ABC123'
  });
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: restrictionRequest,
    apply: () => applied.push('stale-restrictions')
  });
  center.selectView('audit');
  socket.calls[2].callback({ items: [{ targetUsername: 'private' }] });
  assert.deepEqual(applied, []);

  center.selectView('reports');
  for (const status of ['resolved', 'dismissed']) {
    const payload = client.normalizeResolutionPrompt({
      serverCode: 'ABC123', reportId: `report-${status}`, status, resolution: `${status} reason`
    });
    const mutation = client.moderatorCenterMutationRequestFor('resolve', payload);
    assert.equal(mutation.event, 'resolve_moderation_report');
    assert.deepEqual(mutation.payload, payload);
    client.dispatchModeratorCenterRequest({
      coordinator: center, socket, request: mutation, apply: () => {}
    });
  }
  assert.deepEqual(socket.calls.slice(-2).map(call => ({
    event: call.event,
    status: call.payload.status,
    resolution: call.payload.resolution
  })), [
    { event: 'resolve_moderation_report', status: 'resolved', resolution: 'resolved reason' },
    { event: 'resolve_moderation_report', status: 'dismissed', resolution: 'dismissed reason' }
  ]);
});

test('AutoMod save control resets on invalidation and stale acknowledgements cannot affect a newer save', () => {
  const client = loadHelpers();
  const socket = createDeferredSocket();
  const controls = {
    automodSave: { disabled: false },
    resolutionConfirm: { disabled: false }
  };
  const center = client.createModeratorCenterCoordinator({
    onPendingChange(key, pending) {
      client.applyModeratorPendingState(controls, key, pending);
    }
  });
  const applied = [];
  const request = value => client.moderatorCenterMutationRequestFor('automod', {
    serverCode: 'ABC123', blockedKeywords: [value], mentionLimit: 4,
    repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 7, messageWindowSeconds: 12
  });

  center.open('ABC123', 'automod');
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: request('old'),
    apply: () => applied.push('old')
  });
  assert.equal(controls.automodSave.disabled, true);

  center.close();
  assert.equal(controls.automodSave.disabled, false, 'close cleans up without an acknowledgement');
  center.open('ABC123', 'automod');
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: request('new'),
    apply: () => applied.push('new')
  });
  assert.equal(controls.automodSave.disabled, true);

  socket.calls[0].callback({ ok: true });
  assert.equal(controls.automodSave.disabled, true, 'old acknowledgement cannot enable a newer save');
  assert.deepEqual(applied, []);
  socket.calls[1].callback({ ok: true });
  assert.equal(controls.automodSave.disabled, false);
  assert.deepEqual(applied, ['new']);

  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: request('room-change'),
    apply: () => applied.push('wrong-room')
  });
  center.open('XYZ789', 'automod');
  assert.equal(controls.automodSave.disabled, false, 'room change cleans up immediately');
  socket.calls[2].callback({ ok: true });
  assert.deepEqual(applied, ['new']);
});

test('AutoMod save supersedes an older pending fetch without releasing the save control', () => {
  const client = loadHelpers();
  const socket = createDeferredSocket();
  const controls = { automodSave: { disabled: false } };
  const pendingChanges = [];
  const center = client.createModeratorCenterCoordinator({
    onPendingChange(key, pending) {
      pendingChanges.push([key, pending]);
      client.applyModeratorPendingState(controls, key, pending);
    }
  });
  const applied = [];

  center.open('ABC123', 'automod');
  client.dispatchModeratorCenterRequest({
    coordinator: center,
    socket,
    request: client.moderatorCenterRequestFor({ tab: 'automod', roomCode: 'ABC123' }),
    apply: () => applied.push('old-fetch')
  });
  const saveRequest = client.moderatorCenterMutationRequestFor('automod', {
    serverCode: 'ABC123', blockedKeywords: ['new'], mentionLimit: 4,
    repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 7, messageWindowSeconds: 12
  });
  assert.deepEqual(saveRequest.supersedes, ['automod:get']);
  client.dispatchModeratorCenterRequest({
    coordinator: center,
    socket,
    request: saveRequest,
    apply: () => applied.push('save')
  });

  assert.equal(center.isPending('automod:get'), false);
  assert.equal(center.isPending('automod:save'), true);
  assert.equal(controls.automodSave.disabled, true);
  socket.calls[0].callback({ autoMod: { blockedKeywords: ['old-fetch'] } });
  assert.deepEqual(applied, []);
  assert.equal(controls.automodSave.disabled, true, 'stale fetch cannot release the pending save');
  assert.equal(pendingChanges.filter(([key, pending]) => key === 'automod:get' && !pending).length, 1);

  socket.calls[1].callback({ autoMod: { blockedKeywords: ['new'] } });
  assert.deepEqual(applied, ['save']);
  assert.equal(controls.automodSave.disabled, false);
});

test('wrong-room AutoMod save does not supersede the current room fetch', () => {
  const client = loadHelpers();
  const socket = createDeferredSocket();
  const center = client.createModeratorCenterCoordinator();
  const applied = [];

  center.open('ABC123', 'automod');
  client.dispatchModeratorCenterRequest({
    coordinator: center,
    socket,
    request: client.moderatorCenterRequestFor({ tab: 'automod', roomCode: 'ABC123' }),
    apply: () => applied.push('current-fetch')
  });
  const wrongRoomToken = client.dispatchModeratorCenterRequest({
    coordinator: center,
    socket,
    request: client.moderatorCenterMutationRequestFor('automod', {
      serverCode: 'XYZ789', blockedKeywords: [], mentionLimit: 4,
      repeatLimit: 3, repeatWindowSeconds: 30, messageLimit: 7, messageWindowSeconds: 12
    }),
    apply: () => applied.push('wrong-room-save')
  });

  assert.equal(wrongRoomToken, null);
  assert.equal(center.isPending('automod:get'), true);
  assert.equal(socket.calls.length, 1);
  socket.calls[0].callback({ autoMod: { blockedKeywords: [] } });
  assert.deepEqual(applied, ['current-fetch']);
});

test('resolve and dismiss controls reset across same-room reopen and view invalidation', () => {
  const client = loadHelpers();
  const socket = createDeferredSocket();
  const controls = {
    automodSave: { disabled: false },
    resolutionConfirm: { disabled: false }
  };
  const center = client.createModeratorCenterCoordinator({
    onPendingChange(key, pending) {
      client.applyModeratorPendingState(controls, key, pending);
    }
  });
  const applied = [];
  const request = status => client.moderatorCenterMutationRequestFor('resolve', {
    serverCode: 'ABC123', reportId: `report-${status}`, status, resolution: `${status} reason`
  });

  center.open('ABC123', 'reports');
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: request('resolved'),
    apply: () => applied.push('old-resolve')
  });
  assert.equal(controls.resolutionConfirm.disabled, true);
  center.close();
  assert.equal(controls.resolutionConfirm.disabled, false);

  center.open('ABC123', 'reports');
  client.dispatchModeratorCenterRequest({
    coordinator: center, socket, request: request('dismissed'),
    apply: () => applied.push('new-dismiss')
  });
  socket.calls[0].callback({ ok: true });
  assert.equal(controls.resolutionConfirm.disabled, true, 'stale resolve cannot enable the new dismiss');
  assert.deepEqual(applied, []);

  center.selectView('audit');
  assert.equal(controls.resolutionConfirm.disabled, false, 'tab change cleans up immediately');
  socket.calls[1].callback({ ok: true });
  assert.deepEqual(applied, [], 'dismiss acknowledgement cannot mutate the audit view');
});

test('dialog request epochs reset lost controls and reject late close-reopen acknowledgements', () => {
  const client = loadHelpers();
  const pending = [];
  const dialog = client.createDialogRequestCoordinator({
    onPendingChange(value) { pending.push(value); }
  });

  dialog.open('moderate:ABC123:Alice');
  const oldToken = dialog.begin('moderate:ABC123:Alice');
  assert.ok(oldToken);
  assert.equal(pending.at(-1), true);

  dialog.close();
  assert.equal(pending.at(-1), false, 'closing resets a request whose ack never arrived');
  dialog.open('moderate:ABC123:Bob');
  const newToken = dialog.begin('moderate:ABC123:Bob');
  assert.ok(newToken);
  assert.equal(dialog.finish(oldToken), false, 'late acknowledgement cannot target the reopened prompt');
  assert.equal(pending.at(-1), true, 'late acknowledgement cannot enable the new prompt');
  assert.equal(dialog.finish(newToken), true);
  assert.equal(pending.at(-1), false);

  dialog.open('report:ABC123:Bob');
  dialog.begin('report:ABC123:Bob');
  dialog.invalidate();
  assert.equal(pending.at(-1), false, 'room/access/socket invalidation resets pending state');
});

test('composition context binds sends to the visible room and invalidates revoked drafts', () => {
  const client = loadHelpers();
  const context = client.createCompositionContextCoordinator();

  context.activate('ABC123');
  const privatePayload = context.payload({ text: 'private draft' });
  assert.deepEqual({ ...privatePayload }, {
    text: 'private draft', serverCode: 'ABC123', clientContextId: 1
  });
  assert.equal(context.matches({ serverCode: 'ABC123', clientContextId: 1 }), true);

  context.invalidate();
  context.activate('global');
  assert.equal(context.matches({ serverCode: 'ABC123', clientContextId: 1 }), false);
  assert.equal(context.payload({ text: 'new draft' }).serverCode, 'global');
  assert.equal(context.payload({ text: 'new draft' }).clientContextId, 3);
});

test('room rail disables kicked and unbanned nonmembers but preserves admin ghost rooms', () => {
  const client = loadHelpers();
  const ordinary = {
    serverCode: 'ABC123', role: 'user', joinedServers: ['global'], bannedRooms: []
  };
  assert.equal(client.isRoomRailAccessible(ordinary), false);
  assert.equal(client.isRoomRailAccessible({ ...ordinary, bannedRooms: ['ABC123'] }), false);
  assert.equal(client.isRoomRailAccessible({ ...ordinary, role: 'admin' }), true);
  assert.equal(client.isRoomRailAccessible({
    serverCode: 'global', role: 'user', joinedServers: ['global'], bannedRooms: []
  }), true);
});

test('privilege revocation immediately closes and clears every privileged surface', () => {
  const client = loadHelpers();
  const calls = [];
  client.applyPrivilegeRevocation({
    closeCenter: () => calls.push('center'),
    closeModeration: () => calls.push('moderation'),
    closeResolution: () => calls.push('resolution'),
    clearRows: () => calls.push('rows'),
    updateAccess: () => calls.push('access')
  });
  assert.deepEqual(calls, ['moderation', 'resolution', 'center', 'rows', 'access']);
});

test('room-scoped confirmation and blocked-message helpers retain exact context', () => {
  const client = loadHelpers();
  assert.equal(client.roomScopedConfirmation({
    verb: 'Resolve', targetUsername: 'Bob', roomName: 'Private Room', roomCode: 'ABC123'
  }), 'Resolve the report for @Bob in Private Room (ABC123)');
  assert.equal(client.shouldDisplayMessageBlocked({
    data: { serverCode: 'ABC123', clientContextId: 5 },
    currentServerCode: 'ABC123', clientContextId: 5
  }), true);
  assert.equal(client.shouldDisplayMessageBlocked({
    data: { serverCode: 'ABC123', clientContextId: 5 },
    currentServerCode: 'global', clientContextId: 6
  }), false);
});

test('production client invalidates revoked access and sends every room mutation with context', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /authenticatedEventTarget\.on\(['"]room_access_updated['"][\s\S]*invalidateRevokedRoomState/);
  assert.match(source, /authenticatedEventTarget\.on\(['"]room_access_updated['"][\s\S]{0,500}closeModerationPrompt\(\)[\s\S]{0,200}closeReportPrompt\(\)[\s\S]{0,200}closeResolutionPrompt\(\)/);
  assert.match(source, /authenticatedEventTarget\.on\(['"]global_role_updated['"][\s\S]*invalidatePrivilegedAccess/);
  assert.match(source, /authenticatedEventTarget\.on\(['"]room_role_updated['"][\s\S]*invalidatePrivilegedAccess/);
  for (const event of ['chat_message', 'edit_message', 'toggle_reaction', 'delete_message', 'typing']) {
    assert.match(source, new RegExp(`compositionContextCoordinator\\.payload\\([\\s\\S]{0,240}socket\\.emit\\(['"]${event}['"]`), event);
  }
});

function pngAttachmentHeader(width = 2, height = 3) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

function jpegAttachmentHeader(width = 2, height = 3) {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  new DataView(bytes.buffer).setUint16(7, height, false);
  new DataView(bytes.buffer).setUint16(9, width, false);
  bytes.set([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 11);
  return bytes;
}

function jpegAttachmentHeaderAfterMetadata(width = 2, height = 3) {
  const segmentCount = 5;
  const segmentLength = 60000;
  const frame = jpegAttachmentHeader(width, height).slice(2);
  const bytes = new Uint8Array(2 + segmentCount * (segmentLength + 2) + frame.length);
  bytes.set([0xff, 0xd8]);
  let offset = 2;
  for (let index = 0; index < segmentCount; index += 1) {
    bytes.set([0xff, 0xe1], offset);
    new DataView(bytes.buffer).setUint16(offset + 2, segmentLength, false);
    offset += segmentLength + 2;
  }
  bytes.set(frame, offset);
  return bytes;
}

function webpAttachmentHeader(kind = 'VP8X', width = 2, height = 3) {
  const payloadLength = kind === 'VP8L' ? 5 : 10;
  const paddedLength = payloadLength + (payloadLength % 2);
  const bytes = new Uint8Array(20 + paddedLength);
  bytes.set([82, 73, 70, 70], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set([87, 69, 66, 80], 8);
  bytes.set([...kind.padEnd(4, ' ')].map(character => character.charCodeAt(0)), 12);
  new DataView(bytes.buffer).setUint32(16, payloadLength, true);
  if (kind === 'VP8X') {
    const write24 = (offset, value) => {
      bytes[offset] = value & 0xff;
      bytes[offset + 1] = (value >>> 8) & 0xff;
      bytes[offset + 2] = (value >>> 16) & 0xff;
    };
    write24(24, width - 1);
    write24(27, height - 1);
  } else if (kind === 'VP8L') {
    bytes[20] = 0x2f;
    new DataView(bytes.buffer).setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
    new DataView(bytes.buffer).setUint16(26, width, true);
    new DataView(bytes.buffer).setUint16(28, height, true);
  }
  return bytes;
}

function attachmentFile(type = 'image/png', bytes = pngAttachmentHeader(), overrides = {}) {
  return { name: 'image.bin', type, size: bytes.byteLength, bytes, ...overrides };
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

function attachmentControllerHarness(overrides = {}) {
  const helpers = loadHelpers();
  const socket = {};
  const state = {
    session: Object.freeze({ socketReference: socket, generation: 4, connected: true, authenticated: true }),
    composition: Object.freeze({ roomCode: 'global', clientContextId: 7 }),
    enabled: true,
    processing: [], accepted: [], cleared: [], errors: [], calls: [],
    canvasRequests: [], canvases: [], contextTypes: [], draws: [], encodes: []
  };
  const dependencies = {
    getSessionContext: () => state.session,
    getCompositionContext: () => state.composition,
    isCompositionEnabled: () => state.enabled,
    readArrayBuffer: async file => {
      state.calls.push('read');
      return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
    },
    decodeImageBytes: async (bytes, mimeType) => {
      state.calls.push('decode');
      const dimensions = helpers.readAttachmentHeaderDimensions(bytes, mimeType);
      return { image: { marker: 'decoded' }, width: dimensions.width, height: dimensions.height };
    },
    createCanvas: (width, height) => {
      state.calls.push('canvas');
      state.canvasRequests.push({ width, height });
      const canvas = {
        width: 0,
        height: 0,
        getContext: type => {
          state.contextTypes.push(type);
          return { drawImage: (...args) => state.draws.push(args) };
        },
        toDataURL: (mimeType, quality) => {
          state.encodes.push({ mimeType, quality });
          return 'data:image/jpeg;base64,AAAA';
        }
      };
      state.canvases.push(canvas);
      return canvas;
    },
    sanitizeAttachment: value => helpers.sanitizeAttachment(value),
    onProcessing: (...args) => state.processing.push(args),
    onAccepted: (...args) => state.accepted.push(args),
    onCleared: (...args) => state.cleared.push(args),
    onError: (...args) => state.errors.push(args),
    ...overrides
  };
  return { helpers, state, controller: helpers.createAttachmentIntakeController(dependencies), dependencies };
}

class ControlledEventTarget {
  constructor() {
    this.listeners = new Map();
    this.files = [];
    this.value = '';
    this.classNames = new Set();
    this.classList = {
      add: value => this.classNames.add(value),
      remove: value => this.classNames.delete(value),
      contains: value => this.classNames.has(value)
    };
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(candidate => candidate !== handler));
  }
  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...values
    };
    for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    return event;
  }
}

const settleAttachmentWork = () => new Promise(resolve => setImmediate(resolve));

test('attachment candidate accepts only JPEG PNG and WebP at most ten MiB', () => {
  const helpers = loadHelpers();
  const limit = 10 * 1024 * 1024;
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    const accepted = helpers.selectAttachmentCandidate([attachmentFile(type, pngAttachmentHeader(), { size: limit })]);
    assert.equal(accepted.file.type, type);
    assert.equal(accepted.suppliedCount, 1);
    assert.equal(accepted.supportedCount, 1);
  }
  for (const type of ['image/gif', 'image/svg+xml', 'image/jpg', 'text/plain', '', 'IMAGE/PNG']) {
    assert.equal(helpers.selectAttachmentCandidate([attachmentFile(type)]).file, null, type);
  }
  assert.equal(helpers.selectAttachmentCandidate([
    attachmentFile('image/png', pngAttachmentHeader(), { size: limit + 1 })
  ]).file, null);
  assert.equal(helpers.selectAttachmentCandidate([
    attachmentFile('image/png', pngAttachmentHeader(), { size: 0 })
  ]).file.size, 0);
  for (const size of [-1, NaN, Infinity, -Infinity, 0.5, 1.25]) {
    assert.equal(helpers.selectAttachmentCandidate([
      attachmentFile('image/png', pngAttachmentHeader(), { size })
    ]).file, null, `size ${size}`);
  }
});

test('attachment header parser rejects truncated deceptive and malformed JPEG PNG and WebP', () => {
  const helpers = loadHelpers();
  assert.deepEqual({ ...helpers.readAttachmentHeaderDimensions(pngAttachmentHeader(), 'image/png') }, { width: 2, height: 3 });
  assert.deepEqual({ ...helpers.readAttachmentHeaderDimensions(jpegAttachmentHeader(), 'image/jpeg') }, { width: 2, height: 3 });
  for (const kind of ['VP8X', 'VP8L', 'VP8']) {
    assert.deepEqual({ ...helpers.readAttachmentHeaderDimensions(webpAttachmentHeader(kind), 'image/webp') }, { width: 2, height: 3 });
  }
  assert.deepEqual({ ...helpers.readAttachmentHeaderDimensions(jpegAttachmentHeaderAfterMetadata(), 'image/jpeg') },
    { width: 2, height: 3 });
  const largeWebp = new Uint8Array(300000);
  largeWebp.set(webpAttachmentHeader('VP8X'));
  new DataView(largeWebp.buffer).setUint32(4, largeWebp.length - 8, true);
  assert.deepEqual({ ...helpers.readAttachmentHeaderDimensions(largeWebp, 'image/webp') }, { width: 2, height: 3 });

  const deceptivePng = pngAttachmentHeader();
  deceptivePng[0] = 0;
  const wrongFirstPngChunk = pngAttachmentHeader();
  wrongFirstPngChunk.set([73, 68, 65, 84], 12);
  const deceptiveJpeg = jpegAttachmentHeader();
  deceptiveJpeg[1] = 0;
  const deceptiveWebp = webpAttachmentHeader();
  deceptiveWebp[8] = 0;
  const trailingWebp = new Uint8Array(webpAttachmentHeader().length + 1);
  trailingWebp.set(webpAttachmentHeader());
  const malformedJpeg = jpegAttachmentHeader();
  malformedJpeg[4] = 0xff;
  malformedJpeg[5] = 0xff;
  const zeroComponentJpeg = jpegAttachmentHeader();
  zeroComponentJpeg[11] = 0;
  const mismatchedComponentJpeg = jpegAttachmentHeader();
  mismatchedComponentJpeg[11] = 1;
  const malformedWebp = webpAttachmentHeader();
  new DataView(malformedWebp.buffer).setUint32(16, 0x7fffffff, true);
  const longVp8x = new Uint8Array(webpAttachmentHeader('VP8X').length + 2);
  longVp8x.set(webpAttachmentHeader('VP8X'));
  new DataView(longVp8x.buffer).setUint32(4, longVp8x.length - 8, true);
  new DataView(longVp8x.buffer).setUint32(16, 11, true);
  const reservedVp8xFlag = webpAttachmentHeader('VP8X');
  reservedVp8xFlag[20] = 0x01;
  const reservedVp8xByte = webpAttachmentHeader('VP8X');
  reservedVp8xByte[21] = 0x01;
  const interframeVp8 = webpAttachmentHeader('VP8');
  interframeVp8[20] |= 0x01;
  const versionedVp8l = webpAttachmentHeader('VP8L');
  new DataView(versionedVp8l.buffer).setUint32(21,
    new DataView(versionedVp8l.buffer).getUint32(21, true) | (1 << 29), true);
  for (const [bytes, type] of [
    [pngAttachmentHeader().slice(0, 23), 'image/png'],
    [jpegAttachmentHeader().slice(0, 10), 'image/jpeg'],
    [webpAttachmentHeader().slice(0, 25), 'image/webp'],
    [deceptivePng, 'image/png'], [deceptiveJpeg, 'image/jpeg'], [deceptiveWebp, 'image/webp'],
    [trailingWebp, 'image/webp'],
    [wrongFirstPngChunk, 'image/png'],
    [new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]), 'image/jpeg'],
    [malformedJpeg, 'image/jpeg'], [zeroComponentJpeg, 'image/jpeg'],
    [mismatchedComponentJpeg, 'image/jpeg'], [malformedWebp, 'image/webp'],
    [longVp8x, 'image/webp'], [reservedVp8xFlag, 'image/webp'],
    [reservedVp8xByte, 'image/webp'], [interframeVp8, 'image/webp'],
    [versionedVp8l, 'image/webp'],
    [webpAttachmentHeader('ANIM'), 'image/webp'],
    [pngAttachmentHeader(), 'image/webp']
  ]) assert.equal(helpers.readAttachmentHeaderDimensions(bytes, type), null);
});

test('attachment header parser rejects dimensions and pixels before browser decode', async () => {
  const helpers = loadHelpers();
  assert.deepEqual({ ...helpers.readAttachmentHeaderDimensions(pngAttachmentHeader(16384, 1), 'image/png') },
    { width: 16384, height: 1 });
  assert.equal(helpers.readAttachmentHeaderDimensions(pngAttachmentHeader(16385, 1), 'image/png'), null);
  assert.equal(helpers.readAttachmentHeaderDimensions(pngAttachmentHeader(8000, 5001), 'image/png'), null);
  assert.equal(helpers.readAttachmentHeaderDimensions(jpegAttachmentHeader(8000, 5001), 'image/jpeg'), null);
  assert.equal(helpers.readAttachmentHeaderDimensions(webpAttachmentHeader('VP8X', 8000, 5001), 'image/webp'), null);
  assert.equal(helpers.readAttachmentHeaderDimensions(pngAttachmentHeader(0, 3), 'image/png'), null);

  const order = [];
  const { controller } = attachmentControllerHarness({
    readArrayBuffer: async file => { order.push('read'); return file.bytes.buffer; },
    decodeImageBytes: async () => { order.push('decode'); throw new Error('must not decode'); }
  });
  await controller.intake(attachmentFile('image/png', pngAttachmentHeader(8000, 5001)), 'picker');
  assert.deepEqual(order, ['read']);
});

test('attachment intake rejects a decoder dimension mismatch before canvas allocation', async () => {
  let canvasAllocations = 0;
  const { controller, state } = attachmentControllerHarness({
    decodeImageBytes: async () => ({ image: {}, width: 10, height: 11 }),
    createCanvas: () => { canvasAllocations += 1; return {}; }
  });
  await controller.intake(attachmentFile(), 'picker');
  assert.equal(canvasAllocations, 0);
  assert.equal(state.accepted.length, 0);
  assert.equal(state.errors.at(-1)[0], 'Could not process that image.');

  const cases = [
    {
      label: 'landscape',
      file: attachmentFile('image/png', pngAttachmentHeader(1600, 800)),
      expected: { width: 800, height: 400, marker: 'decoded' }
    },
    {
      label: 'portrait',
      file: attachmentFile('image/png', pngAttachmentHeader(400, 1200)),
      expected: { width: 267, height: 800, marker: 'decoded' }
    },
    {
      label: 'oriented JPEG portrait',
      file: attachmentFile('image/jpeg', jpegAttachmentHeader(1200, 400)),
      decodeImageBytes: async () => ({ image: { marker: 'oriented' }, width: 400, height: 1200 }),
      expected: { width: 267, height: 800, marker: 'oriented' }
    }
  ];
  for (const probeCase of cases) {
    const probe = attachmentControllerHarness(probeCase.decodeImageBytes
      ? { decodeImageBytes: probeCase.decodeImageBytes }
      : {});
    await probe.controller.intake(probeCase.file, 'picker');
    assert.equal(probe.state.accepted.length, 1, probeCase.label);
    assert.equal(probe.state.canvases.length, 1, probeCase.label);
    assert.equal(probe.state.canvases[0].width, probeCase.expected.width, probeCase.label);
    assert.equal(probe.state.canvases[0].height, probeCase.expected.height, probeCase.label);
    assert.deepEqual(probe.state.canvasRequests,
      [{ width: probeCase.expected.width, height: probeCase.expected.height }], probeCase.label);
    assert.ok(Math.max(probe.state.canvases[0].width, probe.state.canvases[0].height) <= 800,
      probeCase.label);
    assert.deepEqual(probe.state.contextTypes, ['2d'], probeCase.label);
    assert.equal(probe.state.draws.length, 1, probeCase.label);
    assert.equal(probe.state.draws[0][0].marker, probeCase.expected.marker, probeCase.label);
    assert.deepEqual(probe.state.draws[0].slice(1),
      [0, 0, probeCase.expected.width, probeCase.expected.height], probeCase.label);
    assert.deepEqual(probe.state.encodes, [{ mimeType: 'image/jpeg', quality: 0.8 }], probeCase.label);
  }
});

test('attachment decoder revokes its object URL exactly once on every terminal path', async () => {
  const helpers = loadHelpers();
  const revoked = [];
  let nextUrl = 0;
  const adapters = imageFactory => ({
    BlobCtor: class BlobDouble { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
    createObjectURL: () => `blob:attachment-${++nextUrl}`,
    revokeObjectURL: url => revoked.push(url),
    imageFactory
  });
  const loads = () => {
    const image = { naturalWidth: 2, naturalHeight: 3 };
    Object.defineProperty(image, 'src', { set() { image.onload(); } });
    return image;
  };
  const errors = () => {
    const image = {};
    Object.defineProperty(image, 'src', { set() { image.onerror(new Error('DECODER_SECRET_SENTINEL')); } });
    return image;
  };
  const throwsFromCallback = () => {
    const image = {};
    Object.defineProperty(image, 'naturalWidth', { get() { throw new Error('DECODER_SECRET_SENTINEL'); } });
    Object.defineProperty(image, 'src', { set() { image.onload(); } });
    return image;
  };
  const loaded = await helpers.decodeAttachmentBytes(pngAttachmentHeader(), 'image/png', adapters(loads));
  assert.equal(loaded.width, 2);
  assert.equal(loaded.height, 3);
  await assert.rejects(helpers.decodeAttachmentBytes(pngAttachmentHeader(), 'image/png', adapters(errors)));
  await assert.rejects(helpers.decodeAttachmentBytes(pngAttachmentHeader(), 'image/png', adapters(throwsFromCallback)));

  let pendingImage;
  let pendingImageSource = null;
  const pendingImageCreated = deferred();
  const pendingAdapters = adapters(() => {
    pendingImage = { naturalWidth: 2, naturalHeight: 3 };
    Object.defineProperty(pendingImage, 'src', { set(value) { pendingImageSource = value; } });
    pendingImageCreated.resolve();
    return pendingImage;
  });
  const { controller, state } = attachmentControllerHarness({
    decodeImageBytes: (bytes, mimeType, control) => helpers.decodeAttachmentBytes(
      bytes, mimeType, { ...pendingAdapters, ...control })
  });
  const invalidated = controller.intake(attachmentFile(), 'picker');
  await pendingImageCreated.promise;
  controller.invalidate('room switch');
  const terminal = await Promise.race([
    invalidated.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('still pending'), 25))
  ]);
  assert.equal(terminal, 'settled');
  assert.equal(pendingImageSource, '');
  assert.equal(state.accepted.length, 0);
  assert.deepEqual(revoked, [
    'blob:attachment-1', 'blob:attachment-2', 'blob:attachment-3', 'blob:attachment-4'
  ]);
  assert.equal(revoked.includes('blob:unrelated'), false);
});

test('attachment dimensions enforce positive bounded pixels and fit within eight hundred pixels', () => {
  const helpers = loadHelpers();
  for (const values of [[0, 1], [-1, 1], [1, Infinity], [NaN, 1], [16385, 1], [8000, 5001]]) {
    assert.equal(helpers.fitAttachmentDimensions(...values), null);
  }
  assert.deepEqual({ ...helpers.fitAttachmentDimensions(1600, 800) }, { width: 800, height: 400 });
  assert.deepEqual({ ...helpers.fitAttachmentDimensions(400, 1200) }, { width: 267, height: 800 });
  assert.deepEqual({ ...helpers.fitAttachmentDimensions(1, 1) }, { width: 1, height: 1 });
});

test('attachment intake permits one file and the newest intake supersedes older work', async () => {
  const firstRead = deferred();
  const { controller, state } = attachmentControllerHarness({
    readArrayBuffer: file => file.name === 'older.png' ? firstRead.promise : Promise.resolve(file.bytes.buffer)
  });
  const older = controller.intake(attachmentFile('image/png', pngAttachmentHeader(), { name: 'older.png' }), 'picker');
  const activeToken = controller.current().token;
  assert.equal(Object.isFrozen(activeToken), true);
  assert.equal(activeToken.generation, 4);
  assert.equal(activeToken.socketReference, state.session.socketReference);
  assert.equal(activeToken.serverCode, 'global');
  assert.equal(activeToken.clientContextId, 7);
  const newer = controller.intake(attachmentFile('image/png', pngAttachmentHeader(4, 5), { name: 'newer.png' }), 'drop');
  await newer;
  firstRead.resolve(pngAttachmentHeader().buffer);
  await older;
  assert.equal(state.accepted.length, 1);
  assert.equal(state.accepted[0][1].source, 'drop');
  assert.equal(controller.current().active, false);

  const invalidatedRead = deferred();
  const invalidatedHarness = attachmentControllerHarness({ readArrayBuffer: () => invalidatedRead.promise });
  const invalidatedWork = invalidatedHarness.controller.intake(attachmentFile(), 'picker');
  await Promise.resolve();
  await invalidatedHarness.controller.intake(
    attachmentFile('image/png', pngAttachmentHeader(), { size: 10 * 1024 * 1024 + 1 }), 'drop');
  invalidatedRead.resolve(pngAttachmentHeader().buffer);
  await invalidatedWork;
  assert.equal(invalidatedHarness.state.accepted.length, 0);
  assert.equal(invalidatedHarness.state.cleared.length, 1);
  assert.deepEqual(invalidatedHarness.state.errors.map(args => args[0]),
    ['Only JPEG, PNG, and WebP images up to 10 MiB are supported.']);
});

test('text paste remains native while focused image paste enters the shared pipeline', async () => {
  const { helpers, controller, state } = attachmentControllerHarness();
  const fileInput = new ControlledEventTarget();
  const dropTarget = new ControlledEventTarget();
  const messageInput = new ControlledEventTarget();
  const binding = helpers.bindAttachmentInputs({
    fileInput, dropTarget, messageInput, intakeAttachment: controller.intake
  });
  const textPaste = messageInput.dispatch('paste', {
    clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }
  });
  assert.equal(textPaste.defaultPrevented, false);
  const image = attachmentFile('image/png');
  const imagePaste = messageInput.dispatch('paste', {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] }
  });
  assert.equal(imagePaste.defaultPrevented, true);
  await settleAttachmentWork();
  assert.equal(state.accepted.at(-1)[1].source, 'paste');
  binding.unbind();
});

test('file picker drag drop and paste execute the same intake function', async () => {
  const { helpers, controller, state } = attachmentControllerHarness();
  const fileInput = new ControlledEventTarget();
  const dropTarget = new ControlledEventTarget();
  const messageInput = new ControlledEventTarget();
  const binding = helpers.bindAttachmentInputs({
    fileInput, dropTarget, messageInput, intakeAttachment: controller.intake
  });
  const file = attachmentFile();
  const textDrag = dropTarget.dispatch('dragenter', { dataTransfer: { types: ['text/plain'], files: [] } });
  assert.equal(textDrag.defaultPrevented, false);
  assert.equal(dropTarget.classList.contains('attachment-drag-active'), false);
  assert.equal(dropTarget.dispatch('dragenter', { dataTransfer: { types: ['Files'], files: [file] } }).defaultPrevented, true);
  dropTarget.dispatch('dragenter', { dataTransfer: { types: ['Files'], files: [file] } });
  dropTarget.dispatch('dragleave', { dataTransfer: { types: ['Files'], files: [file] } });
  assert.equal(dropTarget.classList.contains('attachment-drag-active'), true);
  dropTarget.dispatch('dragleave', { dataTransfer: { types: ['Files'], files: [file] } });
  assert.equal(dropTarget.classList.contains('attachment-drag-active'), false);
  fileInput.files = [file];
  fileInput.dispatch('change');
  dropTarget.dispatch('drop', { dataTransfer: { types: ['Files'], files: [file] } });
  messageInput.dispatch('paste', {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] }
  });
  await settleAttachmentWork();
  assert.deepEqual(state.accepted.map(args => args[1].source), ['paste']);
  assert.ok(state.processing.some(args => args[1] === 'picker'));
  assert.ok(state.processing.some(args => args[1] === 'drop'));
  assert.ok(state.processing.some(args => args[1] === 'paste'));
  const processingCount = state.processing.length;
  binding.unbind();
  fileInput.dispatch('change');
  assert.equal(state.processing.length, processingCount);
});

test('attachment processing invalidates on room switch socket replacement clear and send', async () => {
  const cases = [
    ['room switch', 'read'], ['socket replacement', 'decode'],
    ['clear', 'read'], ['send', 'decode']
  ];
  for (const [invalidation, stage] of cases) {
    const boundary = deferred();
    const boundaryStarted = deferred();
    const overrides = stage === 'read'
      ? { readArrayBuffer: () => { boundaryStarted.resolve(); return boundary.promise; } }
      : { decodeImageBytes: () => { boundaryStarted.resolve(); return boundary.promise; } };
    const { controller, state } = attachmentControllerHarness(overrides);
    const work = controller.intake(attachmentFile(), 'picker');
    await boundaryStarted.promise;
    if (invalidation === 'room switch') {
      state.composition = Object.freeze({ roomCode: 'ABC123', clientContextId: 8 });
    } else if (invalidation === 'socket replacement') {
      state.session = Object.freeze({ ...state.session, socketReference: {}, generation: 5 });
    }
    if (invalidation === 'clear') controller.clear();
    else controller.invalidate(invalidation);
    const callbackCount = state.processing.length + state.accepted.length + state.cleared.length + state.errors.length;
    boundary.resolve(stage === 'read'
      ? pngAttachmentHeader().buffer
      : { image: {}, width: 2, height: 3 });
    await work;
    assert.equal(state.processing.length + state.accepted.length + state.cleared.length + state.errors.length,
      callbackCount, invalidation);
    assert.equal(state.accepted.length, 0, invalidation);
  }

  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /async function intakeAttachment\(file, source\)[\s\S]{0,220}attachmentIntakeController\.intake\(file, source\)/);
  assert.match(source, /ChatClientHelpers\.bindAttachmentInputs\(\{[\s\S]{0,260}intakeAttachment,/);
  assert.match(source, /function clearAttachment\(\)[\s\S]{0,180}attachmentIntakeController\.clear\(\)/);
  assert.match(source, /resetAttachment:\s*clearAttachment/);
  const switchBlock = source.slice(source.indexOf('function handleSwitchResult'), source.indexOf('async function leaveServer'));
  assert.match(switchBlock, /compositionContextCoordinator\.activate\(targetServerCode\)[\s\S]*cancelAction\(\)/);
  const submitBlock = source.slice(source.indexOf("document.getElementById('compose').addEventListener('submit'"),
    source.indexOf("msgInput.addEventListener('input'"));
  assert.match(submitBlock, /socket\.emit\('chat_message'[\s\S]*cancelAction\(\)/);
});

test('same-object reconnect cannot complete or send an older attachment intake', async () => {
  const decode = deferred();
  const decodeStarted = deferred();
  const { controller, state } = attachmentControllerHarness({
    decodeImageBytes: () => { decodeStarted.resolve(); return decode.promise; }
  });
  const work = controller.intake(attachmentFile(), 'picker');
  await decodeStarted.promise;
  state.session = Object.freeze({ ...state.session, generation: state.session.generation + 2 });
  decode.resolve({ image: {}, width: 2, height: 3 });
  await work;
  assert.equal(state.accepted.length, 0);
  assert.equal(state.errors.length, 0);
});

test('failed decode canvas and output validation clear only the current intake', async () => {
  const badOutputs = [
    'data:image/png;base64,AAAA',
    'data:image/gif;base64,AAAA',
    'data:image/webp;base64,AAAA',
    'data:image/jpeg;base64,%%%%',
    'data:image/jpeg;base64,A=A=',
    `data:image/jpeg;base64,${'A'.repeat(8000000)}`
  ];
  const mutations = [
    { decodeImageBytes: async () => { throw new Error('DECODER_SECRET_SENTINEL'); } },
    { createCanvas: () => { throw new Error('canvas'); } },
    { createCanvas: () => ({ getContext: () => null, toDataURL: () => 'data:image/jpeg;base64,AAAA' }) },
    ...badOutputs.map(output => ({
      createCanvas: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => output })
    }))
  ];
  for (const mutation of mutations) {
    const { controller, state } = attachmentControllerHarness(mutation);
    await controller.intake(attachmentFile(), 'picker');
    assert.equal(state.accepted.length, 0);
    assert.equal(state.cleared.length, 1);
    assert.deepEqual(state.errors.map(args => args[0]), ['Could not process that image.']);
  }

  const olderDecode = deferred();
  const olderDecodeStarted = deferred();
  let decodeCalls = 0;
  const { controller, state } = attachmentControllerHarness({
    decodeImageBytes: async () => {
      decodeCalls += 1;
      if (decodeCalls === 1) {
        olderDecodeStarted.resolve();
        return olderDecode.promise;
      }
      return { image: {}, width: 2, height: 3 };
    }
  });
  const older = controller.intake(attachmentFile(), 'picker');
  await olderDecodeStarted.promise;
  await controller.intake(attachmentFile(), 'drop');
  olderDecode.reject(new Error('DECODER_SECRET_SENTINEL'));
  await older;
  assert.equal(state.accepted.length, 1);
  assert.equal(state.cleared.length, 0);
});

test('drop target and attachment status are accessible and motion aware', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /id="attachment-selection-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /id="attachment-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /id="preview-img"[^>]*alt="Attached image preview"/);
  assert.match(source, /id="clear-attachment-btn"[^>]*aria-label="Remove attachment"/);
  assert.match(source, /#clear-attachment-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(source, /id="compose-drop-target"[^>]*role="group"[^>]*aria-label="Message composer and image drop target"[^>]*aria-describedby="attachment-drop-instructions"/);
  assert.match(source, /id="attachment-drop-instructions"[^>]*class="visually-hidden"[^>]*>Drop one JPEG, PNG, or WebP image here\.</);
  assert.match(source, /#compose-drop-target\.attachment-drag-active/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*#compose-drop-target/);
});

test('attachment errors redact hostile filenames clipboard data and decoder messages', async () => {
  const secretBytes = new TextEncoder().encode('CLIPBOARD_SECRET_SENTINEL');
  const { helpers, controller, state } = attachmentControllerHarness({
    decodeImageBytes: async () => { throw new Error('DECODER_SECRET_SENTINEL'); }
  });
  const hostile = attachmentFile('image/png', pngAttachmentHeader(), { name: 'PRIVATE_FILENAME_SENTINEL.png' });
  await controller.intake(hostile, 'picker');
  const fileInput = new ControlledEventTarget();
  const dropTarget = new ControlledEventTarget();
  const messageInput = new ControlledEventTarget();
  const statuses = [];
  helpers.bindAttachmentInputs({
    fileInput, dropTarget, messageInput, intakeAttachment: controller.intake,
    onStatus: message => statuses.push(message)
  });
  messageInput.dispatch('paste', {
    clipboardData: {
      marker: secretBytes,
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => hostile }]
    }
  });
  await settleAttachmentWork();
  const exposed = JSON.stringify({ processing: state.processing, accepted: state.accepted,
    cleared: state.cleared, errors: state.errors, statuses });
  assert.doesNotMatch(exposed, /PRIVATE_FILENAME_SENTINEL|CLIPBOARD_SECRET_SENTINEL|DECODER_SECRET_SENTINEL/);
  assert.match(exposed, /Could not process that image\./);
});

test('multiple files report the one-attachment rule and select the first supported image', async () => {
  const { helpers, controller, state } = attachmentControllerHarness();
  const fileInput = new ControlledEventTarget();
  const dropTarget = new ControlledEventTarget();
  const messageInput = new ControlledEventTarget();
  const statuses = [];
  helpers.bindAttachmentInputs({
    fileInput, dropTarget, messageInput, intakeAttachment: controller.intake,
    onStatus: message => statuses.push(message)
  });
  const unsupported = attachmentFile('image/gif', pngAttachmentHeader(), { name: 'first.gif' });
  const firstSupported = attachmentFile('image/jpeg', jpegAttachmentHeader(), { name: 'second.jpg' });
  const laterSupported = attachmentFile('image/png', pngAttachmentHeader(), { name: 'third.png' });
  const dropped = dropTarget.dispatch('drop', {
    dataTransfer: { types: ['Files'], files: [unsupported, firstSupported, laterSupported] }
  });
  assert.equal(dropped.defaultPrevented, true);
  await settleAttachmentWork();
  assert.equal(statuses[0], 'Only one image can be attached; using the first supported image.');
  assert.equal(state.accepted.length, 1);
  assert.equal(state.accepted[0][1].source, 'drop');
  assert.equal(state.accepted[0][1].mimeType, 'image/jpeg');

  const olderRead = deferred();
  const second = attachmentControllerHarness({ readArrayBuffer: () => olderRead.promise });
  const secondFileInput = new ControlledEventTarget();
  const secondDropTarget = new ControlledEventTarget();
  const secondMessageInput = new ControlledEventTarget();
  second.helpers.bindAttachmentInputs({
    fileInput: secondFileInput,
    dropTarget: secondDropTarget,
    messageInput: secondMessageInput,
    intakeAttachment: second.controller.intake
  });
  const olderWork = second.controller.intake(attachmentFile(), 'picker');
  secondDropTarget.dispatch('drop', {
    dataTransfer: { types: ['Files'], files: [attachmentFile('image/gif')] }
  });
  olderRead.resolve(pngAttachmentHeader().buffer);
  await olderWork;
  assert.equal(second.state.accepted.length, 0);

  const selectionStatus = { textContent: '' };
  const phaseStatus = { textContent: '' };
  const liveStatus = helpers.createAttachmentStatusController({ selectionStatus, phaseStatus });
  const statusRead = deferred();
  const statusHarness = attachmentControllerHarness({
    readArrayBuffer: () => statusRead.promise,
    onProcessing: message => liveStatus.processing(message),
    onAccepted: () => liveStatus.accepted(),
    onCleared: () => liveStatus.clear(),
    onError: message => liveStatus.error(message)
  });
  const statusFileInput = new ControlledEventTarget();
  const statusDropTarget = new ControlledEventTarget();
  const statusMessageInput = new ControlledEventTarget();
  statusHarness.helpers.bindAttachmentInputs({
    fileInput: statusFileInput,
    dropTarget: statusDropTarget,
    messageInput: statusMessageInput,
    intakeAttachment: statusHarness.controller.intake,
    onStatus: message => liveStatus.selection(message)
  });
  const statusFile = attachmentFile('image/jpeg', jpegAttachmentHeader());
  statusDropTarget.dispatch('drop', {
    dataTransfer: { types: ['Files'], files: [statusFile, attachmentFile('image/png')] }
  });
  assert.equal(selectionStatus.textContent,
    'Only one image can be attached; using the first supported image.');
  assert.equal(phaseStatus.textContent, 'Processing image…');
  statusRead.resolve(jpegAttachmentHeader().buffer);
  await settleAttachmentWork();
  assert.equal(selectionStatus.textContent,
    'Only one image can be attached; using the first supported image.');
  assert.equal(phaseStatus.textContent, 'Image attached.');

  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /createAttachmentStatusController\(\{[\s\S]{0,220}attachment-selection-status[\s\S]{0,120}attachment-status/);
  assert.match(source, /onProcessing\(message\)[\s\S]{0,100}attachmentStatusController\.processing\(message\)/);
  assert.match(source, /onStatus\(message\)[\s\S]{0,100}attachmentStatusController\.selection\(message\)/);
});
