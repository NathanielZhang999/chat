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
        if (property === 'moderationActionsFor') return [...result];
        if (property === 'normalizeModerationPrompt' && result) return { ...result };
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

test('Global context and private menu contracts include reports without granting authority', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const roleManagerStart = source.indexOf('function openRoleManager');
  const roleManagerEnd = source.indexOf('// --- REACTION UI ENGINE ---', roleManagerStart);
  const roleManager = source.slice(roleManagerStart, roleManagerEnd);

  assert.notEqual(roleManagerStart, -1);
  assert.match(roleManager, /list_room_restrictions/);
  assert.match(roleManager, /moderationActionsFor/);
  assert.match(roleManager, /Report User/);
  assert.match(source, /Report Message/);
  assert.match(source, /report_moderation_target/);
  assert.doesNotMatch(
    roleManager,
    /currentServerCode\s*===\s*['"]global['"][\s\S]{0,500}(?:Kick|action:\s*['"]kick['"])/
  );
});

test('reports restrictions and audit rows render API text with textContent', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const [functionName, nextFunction] of [
    ['renderModerationReports', 'renderRoomRestrictions'],
    ['renderRoomRestrictions', 'renderModerationAudit'],
    ['renderModerationAudit', 'loadAutoModSettings']
  ]) {
    const start = source.indexOf(`function ${functionName}`);
    const end = source.indexOf(`function ${nextFunction}`, start);
    const body = source.slice(start, end);
    assert.notEqual(start, -1, `${functionName} exists`);
    assert.notEqual(end, -1, `${functionName} has a bounded source region`);
    assert.match(body, /textContent/, `${functionName} uses inert text nodes`);
    assert.doesNotMatch(body, /innerHTML/, `${functionName} never interprets API text as markup`);
  }
});

test('direct event handlers and defaultServerCode drive room access updates', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const event of [
    'room_access_updated', 'room_restriction_updated', 'moderation_queue_updated', 'message_blocked'
  ]) {
    assert.match(source, new RegExp(`activeSocket\\.on\\(['"]${event}['"]`), event);
  }
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(res,\s*['"]defaultServerCode['"]\)/);
  assert.match(source, /if\s*\(initialCode\)\s*switchServer\(initialCode\);\s*else\s*enterLobby\(\);/s);
  assert.doesNotMatch(source, /renderServers\(res\.servers\s*\|\|\s*\[\]\);\s*switchServer\(['"]global['"]\)/s);
  assert.match(source, /Your message was blocked by this room's content policy\./);
});

test('Lobby state disables composition and leaves room discovery controls enabled', () => {
  const client = loadHelpers();
  const elements = {
    messageInput: { disabled: false },
    sendButton: { disabled: false },
    attachmentButton: { disabled: false },
    emojiButton: { disabled: false },
    infoBar: { textContent: '' },
    roomLabel: ''
  };

  client.applyLobbyState(elements, true);
  assert.equal(elements.messageInput.disabled, true);
  assert.equal(elements.sendButton.disabled, true);
  assert.equal(elements.attachmentButton.disabled, true);
  assert.equal(elements.emojiButton.disabled, true);
  assert.equal(elements.infoBar.textContent, 'Lobby — join or create a room to chat');

  const source = fs.readFileSync(chatPath, 'utf8');
  const enterLobbyStart = source.indexOf('function enterLobby');
  const enterLobbyEnd = source.indexOf('function applyRestrictionState', enterLobbyStart);
  const enterLobby = source.slice(enterLobbyStart, enterLobbyEnd);
  assert.match(enterLobby, /typingUsers\.clear\(\)/);
  assert.match(enterLobby, /applyLobbyState/);
  assert.doesNotMatch(enterLobby, /submit-(?:join|create)-btn[^\n]*disabled\s*=\s*true/);
});

test('Lobby state ignores late room traffic after transport eviction', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const event of ['chat_message', 'system_message', 'online_users', 'typing']) {
    const start = source.indexOf(`activeSocket.on('${event}'`);
    const end = source.indexOf('activeSocket.on(', start + 20);
    const handler = source.slice(start, end);
    assert.notEqual(start, -1, `${event} handler exists`);
    assert.match(handler, /if\s*\(!currentServerCode\)\s*return/, `${event} ignores lobby traffic`);
  }
});

test('banned client suppresses rail switches and restores Global after unban', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /myBannedRooms\s*=\s*new Set\(res\.bannedRooms\s*\|\|\s*\[\]\)/);
  assert.match(source, /aria-disabled/);
  assert.match(source, /myBannedRooms\.has\(code\)[\s\S]{0,120}return/);
  assert.match(source, /room_restriction_updated[\s\S]{0,1000}myBannedRooms\s*=\s*new Set/s);
  assert.match(source, /room_restriction_updated[\s\S]{0,1400}renderServerAccess/s);
  assert.match(source, /if\s*\(data\.serverCode\s*===\s*currentServerCode\)[\s\S]{0,300}applyRestrictionState/s);
});

test('current-room timeout expiry is guarded by room and restriction version', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const applyStart = source.indexOf('function applyRestrictionState');
  const applyEnd = source.indexOf('function renderServerAccess', applyStart);
  const applyRestriction = source.slice(applyStart, applyEnd);
  assert.notEqual(applyStart, -1);
  assert.match(applyRestriction, /clearTimeout\(restrictionExpiryTimer\)/);
  assert.match(applyRestriction, /restrictionVersion\s*\+=\s*1/);
  assert.match(applyRestriction, /capturedRoom/);
  assert.match(applyRestriction, /capturedVersion/);
  assert.match(applyRestriction, /currentServerCode\s*!==\s*capturedRoom/);
  assert.match(applyRestriction, /restrictionVersion\s*!==\s*capturedVersion/);
  assert.match(source, /applyRestrictionState\(res\.restriction/);
  assert.match(source, /applyRestrictionState\(response\.restriction/);
});

test('moderation center supports absent-roster unban and clears room data on reopen', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const openStart = source.indexOf('function openModeratorCenter');
  const openEnd = source.indexOf('function closeModeratorCenter', openStart);
  const openCenter = source.slice(openStart, openEnd);
  const restrictionsStart = source.indexOf('function renderRoomRestrictions');
  const restrictionsEnd = source.indexOf('function renderModerationAudit', restrictionsStart);
  const restrictions = source.slice(restrictionsStart, restrictionsEnd);

  assert.match(openCenter, /clearModeratorRows\(\)/);
  assert.match(openCenter, /moderatorCenterRoom\s*=\s*currentServerCode/);
  assert.match(restrictions, /targetUsername/);
  assert.match(restrictions, /Unban/);
  assert.match(restrictions, /Clear Timeout/);
  assert.match(restrictions, /openModerationPrompt/);
  assert.match(source, /resolve_moderation_report/);
  assert.match(source, /['"]resolved['"]/);
  assert.match(source, /['"]dismissed['"]/);
});

test('stale restriction and moderator-center callbacks stay scoped to their room', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const roleManagerStart = source.indexOf('function openRoleManager');
  const roleManagerEnd = source.indexOf('// --- REACTION UI ENGINE ---', roleManagerStart);
  const roleManager = source.slice(roleManagerStart, roleManagerEnd);
  assert.match(roleManager, /requestedRoom/);
  assert.match(roleManager, /currentServerCode\s*!==\s*requestedRoom/);

  const centerStart = source.indexOf('function loadModeratorCenterTab');
  const centerEnd = source.indexOf('function renderModerationReports', centerStart);
  const centerLoader = source.slice(centerStart, centerEnd);
  assert.match(centerLoader, /moderatorCenterRoom/);
  assert.match(centerLoader, /currentServerCode\s*!==\s*requestedRoom/);
  assert.match(centerLoader, /moderator-center-modal[^\n]*active|classList\.contains\(['"]active['"]\)/);
});

test('moderator center keeps API projections private and validates AutoMod bounds', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /get_automod/);
  assert.match(source, /update_automod/);
  assert.match(source, /blockedKeywords/);
  assert.match(source, /\.slice\(0,\s*50\)/);
  assert.match(source, /mentionLimit[\s\S]{0,500}(?:1[^\d]+20|value\s*>\s*20)/);
  assert.match(source, /repeatLimit[\s\S]{0,500}(?:2[^\d]+10|value\s*>\s*10)/);
  assert.match(source, /repeatWindowSeconds[\s\S]{0,500}(?:5[^\d]+300|value\s*>\s*300)/);
  assert.doesNotMatch(source, /internalSecret|storageSecret/);
});
