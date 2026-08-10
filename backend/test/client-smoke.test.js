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

test('room switch coordinator cancels replaced and coalesced queued requests', () => {
  const helpers = loadHelpers();
  const acknowledgements = [];
  const cancellations = [];
  const activeContexts = [];
  const coordinator = helpers.createSwitchCoordinator(
    (_target, callback) => acknowledgements.push(callback),
    () => {}
  );

  const activeToken = coordinator.request('AAAAAA', { forceRefresh: true });
  coordinator.request('BBBBBB', {
    onCancel(reason, _token, activeRequest) {
      cancellations.push(`BBBBBB:${reason}`);
      activeContexts.push(activeRequest);
    }
  });
  coordinator.request('AAAAAA', {
    onCancel(reason, _token, activeRequest) {
      cancellations.push(`AAAAAA:${reason}`);
      activeContexts.push(activeRequest);
    }
  });

  assert.deepEqual(cancellations, ['BBBBBB:replaced']);
  assert.ok(activeContexts[0], 'replacement cancellation receives the active request context');
  assert.equal(Object.isFrozen(activeContexts[0]), true);
  assert.equal(activeContexts[0].target, 'AAAAAA');
  assert.equal(activeContexts[0].token, activeToken);
  assert.equal(activeContexts[0].forceRefresh, true);
  acknowledgements[0]({ history: [] });
  assert.deepEqual(cancellations, ['BBBBBB:replaced', 'AAAAAA:coalesced']);
  assert.equal(activeContexts[1], null);
  assert.equal(acknowledgements.length, 1);
  assert.equal(coordinator.isPending(), false);
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
    assert.match(source, new RegExp(`activeSocket\\.on\\(['"]${event}['"]`), event);
  }
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

  assert.match(source, /if \(socket !== previousSocket\)[\s\S]{0,400}closeModerationPrompt\(\)[\s\S]{0,200}closeReportPrompt\(\)[\s\S]{0,200}invalidatePrivilegedAccess\(\)/);
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
  assert.match(source, /activeSocket\.on\(['"]room_access_updated['"][\s\S]*invalidateRevokedRoomState/);
  assert.match(source, /activeSocket\.on\(['"]room_access_updated['"][\s\S]{0,500}closeModerationPrompt\(\)[\s\S]{0,200}closeReportPrompt\(\)[\s\S]{0,200}closeResolutionPrompt\(\)/);
  assert.match(source, /activeSocket\.on\(['"]global_role_updated['"][\s\S]*invalidatePrivilegedAccess/);
  assert.match(source, /activeSocket\.on\(['"]room_role_updated['"][\s\S]*invalidatePrivilegedAccess/);
  for (const event of ['chat_message', 'edit_message', 'toggle_reaction', 'delete_message', 'typing']) {
    assert.match(source, new RegExp(`compositionContextCoordinator\\.payload\\([\\s\\S]{0,240}socket\\.emit\\(['"]${event}['"]`), event);
  }
});

test('production image uploads cannot complete into a replaced room composition context', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const start = source.indexOf("document.getElementById('file-upload').addEventListener('change'");
  const end = source.indexOf('// --- SETTINGS LOGIC ---', start);
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const uploadBlock = source.slice(start, end);

  assert.match(uploadBlock, /const uploadContext = compositionContextCoordinator\.payload\(\)/);
  assert.match(uploadBlock, /const uploadEpoch = \+\+attachmentLoadEpoch/);
  assert.match(uploadBlock, /const isCurrentUpload[\s\S]*compositionContextCoordinator\.matches\(uploadContext\)/);
  assert.equal((uploadBlock.match(/if \(!isCurrentUpload\(\)\) return/g) || []).length, 2);
  assert.match(uploadBlock, /uploadEpoch === attachmentLoadEpoch/);
});

test('version acceptance is strict for metadata pins and blocks and identical-idempotent for room state', () => {
  const client = loadHelpers();
  const details = {
    serverCode: 'ABC123', description: 'old', rules: 'old rules', metadataVersion: 2, canEdit: false
  };
  assert.equal(client.acceptVersionedState(details, { ...details, description: 'different' }, 'metadata'), details);
  assert.equal(client.acceptVersionedState(details, { ...details, metadataVersion: 1 }, 'metadata'), details);
  assert.equal(client.acceptVersionedState(details, { ...details, metadataVersion: -1 }, 'metadata'), details);
  const newerDetails = client.acceptVersionedState(
    details,
    { ...details, description: 'new', metadataVersion: 3 },
    'metadata'
  );
  assert.equal(newerDetails.description, 'new');
  assert.equal(newerDetails.metadataVersion, 3);

  const pin = { serverCode: 'ABC123', pinCount: 1, pinVersion: 5, blockVersion: 4 };
  assert.equal(client.acceptVersionedState(pin, { ...pin, pinCount: 2 }, 'pins'), pin);
  assert.equal(client.acceptVersionedState(pin, { ...pin, pinVersion: 4 }, 'pins'), pin);
  assert.equal(client.acceptVersionedState(pin, { ...pin }, 'pins'), pin);

  const blocks = { blockedUsers: [{ usernameKey: 'bob', username: 'Bob' }], blockVersion: 7 };
  assert.equal(client.acceptVersionedState(blocks, { blockedUsers: [], blockVersion: 7 }, 'blocks'), blocks);
  const newerBlocks = client.acceptVersionedState(
    blocks,
    { blockedUsers: [], blockVersion: 8 },
    'blocks'
  );
  assert.equal(newerBlocks.blockVersion, 8);
  assert.deepEqual([...newerBlocks.blockedUsers], []);

  const roomState = {
    serverCode: 'ABC123', usernameKey: 'alice', notificationLevel: 'all',
    lastReadAt: '2026-08-10T10:00:00.000Z', lastReadMessageId: '000002',
    unreadCount: 3, mentionCount: 1, version: 9, blockVersion: 7
  };
  assert.equal(client.acceptVersionedState(roomState, { ...roomState }, 'room-state'), roomState);
  assert.equal(client.acceptVersionedState(
    roomState,
    { ...roomState, unreadCount: 4 },
    'room-state'
  ), roomState, 'equal-but-different state is rejected');
});

test('pin body hydration accepts only the current unloaded pin and block version', () => {
  const client = loadHelpers();
  const current = {
    serverCode: 'ABC123', pinCount: 1, pinVersion: 5, blockVersion: 4,
    pinsLoaded: false, pins: []
  };
  const pin = {
    messageId: '507f1f77bcf86cd799439001', username: 'Alice', text: 'Safe body'
  };
  for (const stale of [
    { ...current, pinVersion: 4, pins: [pin], requestTokenCurrent: true },
    { ...current, blockVersion: 3, pins: [pin], requestTokenCurrent: true },
    { ...current, pinCount: 2, pins: [pin], requestTokenCurrent: true },
    { ...current, pins: [pin], requestTokenCurrent: false }
  ]) {
    assert.equal(client.acceptPinBodies(current, stale), current);
  }
  const hydrated = client.acceptPinBodies(current, {
    ...current, pins: [pin], requestTokenCurrent: true
  });
  assert.notEqual(hydrated, current);
  assert.equal(hydrated.pinsLoaded, true);
  assert.equal(hydrated.pins[0].text, 'Safe body');
  assert.equal(client.acceptPinBodies(hydrated, {
    ...current, pins: [pin], requestTokenCurrent: true
  }), hydrated, 'already-loaded bodies are not overwritten');
});

test('a greater accepted block version replaces an equal pin version visible count', () => {
  const client = loadHelpers();
  const current = { serverCode: 'ABC123', pinCount: 4, pinVersion: 8, blockVersion: 2 };
  const replacement = client.acceptVersionedState(current, {
    serverCode: 'ABC123', pinCount: 1, pinVersion: 8, blockVersion: 3
  }, 'pins');
  assert.notEqual(replacement, current);
  assert.deepEqual({
    pinCount: replacement.pinCount,
    pinVersion: replacement.pinVersion,
    blockVersion: replacement.blockVersion
  }, { pinCount: 1, pinVersion: 8, blockVersion: 3 });
  assert.equal(client.acceptVersionedState(current, {
    serverCode: 'ABC123', pinCount: 1, pinVersion: 7, blockVersion: 3
  }, 'pins'), current, 'a block replacement cannot roll the owning pin version back');
});

test('scoped feature generations reject late close reopen room switch and account callbacks before inspection', () => {
  const client = loadHelpers();
  const coordinator = client.createScopedGenerationCoordinator();
  const firstOpen = coordinator.begin('room-info', 'ABC123');
  assert.equal(Object.isFrozen(firstOpen), true);
  assert.equal(coordinator.isCurrent(firstOpen, 'ABC123'), true);
  coordinator.invalidate('room-info');
  const reopened = coordinator.begin('room-info', 'ABC123');
  assert.equal(coordinator.isCurrent(firstOpen, 'ABC123'), false);
  assert.equal(coordinator.isCurrent(reopened, 'ABC123'), true);
  assert.equal(coordinator.isCurrent(reopened, 'XYZ789'), false);

  const roomSwitch = coordinator.begin('room-switch', 'ABC123');
  coordinator.begin('room-switch', 'XYZ789');
  assert.equal(coordinator.isCurrent(roomSwitch, 'ABC123'), false);
  const account = coordinator.begin('account', 'alice');
  coordinator.invalidateAll();
  assert.equal(coordinator.isCurrent(account, 'alice'), false);
});

test('socket replacement clears every feature map and old-socket listeners are inert', () => {
  const client = loadHelpers();
  const coordinator = client.createScopedGenerationCoordinator();
  const oldSocketWork = coordinator.begin('pins', 'ABC123');
  coordinator.invalidateAll();
  assert.equal(coordinator.isCurrent(oldSocketWork, 'ABC123'), false);

  const source = fs.readFileSync(chatPath, 'utf8');
  for (const mapName of [
    'roomDetailsByCode', 'pinsByRoom', 'roomStateByCode', 'attentionByRoom',
    'recentActivityIdsByRoom', 'blockedUsersByKey'
  ]) {
    assert.match(source, new RegExp(`const ${mapName} = new Map\\(\\)`), mapName);
    assert.match(source, new RegExp(`${mapName}\\.clear\\(\\)`), `${mapName} clears on replacement`);
  }
  assert.match(source, /function clearFeatureStateForSocketReplacement\(\)[\s\S]*featureGenerations\.invalidateAll\(\)/);
  for (const event of [
    'room_details_updated', 'message_pin_updated', 'room_notification_updated',
    'room_read_updated', 'room_activity', 'user_block_updated', 'room_refresh_required'
  ]) {
    assert.match(
      source,
      new RegExp(`activeSocket\\.on\\(['"]${event}['"][\\s\\S]{0,180}if \\(activeSocket !== socket\\) return`),
      `${event} ignores an old socket`
    );
  }
});

test('room activity ignores old block versions cursor-covered tuples and bounded duplicate IDs', () => {
  const client = loadHelpers();
  const recentIds = client.createRecentIdSet();
  let state = {
    serverCode: 'ABC123', notificationLevel: 'all', unreadCount: 0, mentionCount: 0,
    lastReadAt: '2026-08-10T10:00:00.000Z', lastReadMessageId: '000010',
    version: 4, blockVersion: 4
  };
  const apply = activity => { state = client.applyRoomActivity(state, activity, recentIds); };
  apply({
    serverCode: 'ABC123', messageId: '000011', timestamp: '2026-08-10T10:00:01.000Z',
    mentioned: true, blockVersion: 4
  });
  apply({
    serverCode: 'ABC123', messageId: '000012', timestamp: '2026-08-10T10:00:02.000Z',
    mentioned: true, blockVersion: 3
  });
  apply({
    serverCode: 'ABC123', messageId: '000011', timestamp: '2026-08-10T10:00:01.000Z',
    mentioned: true, blockVersion: 4
  });
  apply({
    serverCode: 'ABC123', messageId: '000010', timestamp: '2026-08-10T10:00:00.000Z',
    mentioned: true, blockVersion: 4
  });
  for (let index = 0; index < 300; index += 1) {
    apply({
      serverCode: 'ABC123', messageId: `message-${String(index).padStart(3, '0')}`,
      timestamp: new Date(Date.UTC(2026, 7, 10, 10, 1, index)).toISOString(),
      mentioned: index % 2 === 0, blockVersion: 4
    });
  }
  assert.equal(state.unreadCount, 301);
  assert.equal(state.mentionCount, 151);
  assert.equal(recentIds.size, 256);
  assert.equal(recentIds.has('000011'), false, 'FIFO eviction removes the oldest accepted ID');
  assert.equal(recentIds.has('message-299'), true);
});

test('exact read snapshots replace speculative counts across tabs and devices', () => {
  const client = loadHelpers();
  const speculative = {
    serverCode: 'ABC123', usernameKey: 'alice', notificationLevel: 'all',
    lastReadAt: '2026-08-10T10:00:00.000Z', lastReadMessageId: '000010',
    unreadCount: 8, mentionCount: 3, version: 4, blockVersion: 2
  };
  const exact = client.acceptVersionedState(speculative, {
    ...speculative,
    lastReadAt: '2026-08-10T10:05:00.000Z', lastReadMessageId: '000099',
    unreadCount: 1, mentionCount: 0, version: 5
  }, 'room-state');
  assert.deepEqual({
    unreadCount: exact.unreadCount,
    mentionCount: exact.mentionCount,
    version: exact.version,
    lastReadMessageId: exact.lastReadMessageId
  }, { unreadCount: 1, mentionCount: 0, version: 5, lastReadMessageId: '000099' });

  const recentIds = client.createRecentIdSet();
  recentIds.add('000050', { timestamp: '2026-08-10T10:02:00.000Z', messageId: '000050' });
  recentIds.add('000100', { timestamp: '2026-08-10T10:06:00.000Z', messageId: '000100' });
  recentIds.clearAtOrBefore({
    timestamp: exact.lastReadAt,
    messageId: exact.lastReadMessageId
  });
  assert.equal(recentIds.has('000050'), false);
  assert.equal(recentIds.has('000100'), true);
});

test('a greater accepted block version authoritatively replaces equal-version room counts', () => {
  const client = loadHelpers();
  const current = {
    serverCode: 'ABC123', usernameKey: 'alice', notificationLevel: 'mentions',
    lastReadAt: null, lastReadMessageId: null,
    unreadCount: 7, mentionCount: 2, version: 6, blockVersion: 3
  };
  const replacement = client.acceptVersionedState(current, {
    ...current, unreadCount: 2, mentionCount: 0, blockVersion: 4
  }, 'room-state');
  assert.notEqual(replacement, current);
  assert.deepEqual({
    unreadCount: replacement.unreadCount,
    mentionCount: replacement.mentionCount,
    version: replacement.version,
    blockVersion: replacement.blockVersion
  }, { unreadCount: 2, mentionCount: 0, version: 6, blockVersion: 4 });
  assert.equal(client.acceptVersionedState(current, {
    ...current, version: 5, blockVersion: 4
  }, 'room-state'), current);
});

test('attention presentation follows all mentions none and caps visible counts at 99+', () => {
  const client = loadHelpers();
  assert.deepEqual({ ...client.attentionPresentation({
    notificationLevel: 'all', unreadCount: 42, mentionCount: 2
  }) }, { badgeText: '@2', ariaLabel: '2 mentions', title: '2 mentions, 42 unread messages', visible: true });
  assert.deepEqual({ ...client.attentionPresentation({
    notificationLevel: 'all', unreadCount: 120, mentionCount: 0
  }) }, { badgeText: '99+', ariaLabel: '120 unread messages', title: '120 unread messages', visible: true });
  assert.deepEqual({ ...client.attentionPresentation({
    notificationLevel: 'mentions', unreadCount: 120, mentionCount: 100
  }) }, { badgeText: '@99+', ariaLabel: '100 mentions', title: '100 mentions', visible: true });
  assert.deepEqual({ ...client.attentionPresentation({
    notificationLevel: 'mentions', unreadCount: 8, mentionCount: 0
  }) }, { badgeText: '', ariaLabel: '', title: '', visible: false });
  assert.deepEqual({ ...client.attentionPresentation({
    notificationLevel: 'none', unreadCount: 8, mentionCount: 4
  }) }, { badgeText: '', ariaLabel: '', title: '', visible: false });
});

test('sound policy permits all traffic for all mentions only for mentions and none for none', () => {
  const client = loadHelpers();
  assert.equal(client.soundPolicy('all', false), 'msg');
  assert.equal(client.soundPolicy('all', true), 'ping');
  assert.equal(client.soundPolicy('mentions', true), 'ping');
  assert.equal(client.soundPolicy('mentions', false), null);
  assert.equal(client.soundPolicy('none', true), null);
  assert.equal(client.soundPolicy('unknown', true), null);
});

test('blocked placeholders are silent at every notification level', () => {
  const client = loadHelpers();
  for (const level of ['all', 'mentions', 'none']) {
    assert.equal(client.soundPolicy(level, false, true), null);
    assert.equal(client.soundPolicy(level, true, true), null);
  }
});

test('mark-read policy requires active room visible document and bottom scroll', () => {
  const client = loadHelpers();
  const eligible = {
    currentRoom: 'ABC123', roomCode: 'ABC123', visibilityState: 'visible',
    nearBottom: true, roomGeneration: 12, suppressionToken: null
  };
  assert.equal(client.isMarkReadEligible(eligible), true);
  assert.equal(client.isMarkReadEligible({ ...eligible, currentRoom: 'XYZ789' }), false);
  assert.equal(client.isMarkReadEligible({ ...eligible, visibilityState: 'hidden' }), false);
  assert.equal(client.isMarkReadEligible({ ...eligible, nearBottom: false }), false);
  assert.equal(client.isMarkReadEligible({
    ...eligible,
    suppressionToken: Object.freeze({ roomCode: 'ABC123', roomGeneration: 12 })
  }), false);
  assert.equal(client.isMarkReadEligible({
    ...eligible,
    suppressionToken: Object.freeze({ roomCode: 'ABC123', roomGeneration: 11 })
  }), true, 'suppression is scoped to the exact room generation');
});

test('block update invalidates pin cache typing history replies and reactions before refetch', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const start = source.indexOf('function applyAcceptedBlockState(');
  const end = source.indexOf('\n    function ', start + 1);
  assert.notEqual(start, -1, 'block replacement handler exists');
  const block = source.slice(start, end === -1 ? source.length : end);
  assert.match(block, /pinsByRoom\.clear\(\)/);
  assert.match(block, /recentActivityIdsByRoom\.clear\(\)/);
  assert.match(block, /typingUsers\.clear\(\)/);
  assert.match(block, /invalidateAllFeatureCallbacksExceptBlock/);
  assert.match(block, /replaceActiveMessagesWithBlockRefreshState\(\)/);
  assert.ok(
    block.indexOf('replaceActiveMessagesWithBlockRefreshState()') < block.indexOf('renderBlockedUsers()'),
    'message, reply, and reaction content is removed before subsequent UI work'
  );
});

test('event before acknowledgement still settles the current metadata pin and block controls', () => {
  const client = loadHelpers();
  const receipts = client.createOperationReceiptCoordinator();
  for (const kind of ['metadata', 'pin', 'block']) {
    const identity = `${kind}:ABC123:1`;
    const token = receipts.begin(kind, identity);
    assert.equal(receipts.canFinish(token, identity), true);
    assert.equal(receipts.settleFromEvent(token, identity), true);
    assert.equal(receipts.canFinish(token, identity), true, `${kind} ack remains idempotently finishable`);
    assert.equal(receipts.finish(token, identity), true);

    const stale = receipts.begin(kind, `${identity}:stale`);
    const current = receipts.begin(kind, `${identity}:new`);
    assert.equal(receipts.settleFromEvent(stale, `${identity}:stale`), false);
    assert.equal(receipts.canFinish(stale, `${identity}:stale`), false);
    assert.equal(receipts.canFinish(current, `${identity}:new`), true);
  }
});

test('block refresh suppresses only its programmatic mark-read and later live messages resume normal reads', () => {
  const client = loadHelpers();
  const context = {
    currentRoom: 'ABC123', roomCode: 'ABC123', visibilityState: 'visible',
    nearBottom: true, roomGeneration: 14,
    suppressionToken: Object.freeze({ roomCode: 'ABC123', roomGeneration: 14 })
  };
  assert.equal(client.isMarkReadEligible(context), false);
  assert.equal(client.isMarkReadEligible({ ...context, suppressionToken: null }), true);
  assert.equal(client.isMarkReadEligible({
    ...context,
    currentRoom: 'XYZ789', roomCode: 'XYZ789', roomGeneration: 15
  }), true, 'another room cannot inherit the active room suppression token');

  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /function handleRoomRefreshRequired[\s\S]*suppressAutoRead:\s*true/);
  assert.match(source, /function disarmReadSuppression[\s\S]*ChatClientHelpers\.releaseExactToken/);
  assert.match(source, /function scheduleMaybeMarkCurrentRoomRead/);
});

function createFakeEventTarget() {
  const listeners = new Map();
  return {
    activeElement: null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener({ type, ...event });
    }
  };
}

function createFakeElement(owner, { disabled = false, hidden = false } = {}) {
  const attributes = new Map();
  const classes = new Set();
  return {
    ownerDocument: owner,
    disabled,
    hidden,
    isConnected: true,
    children: [],
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    appendChild(child) { this.children.push(child); return child; },
    contains(candidate) { return candidate === this || this.children.includes(candidate); },
    focus() { owner.activeElement = this; },
    querySelectorAll() { return this.children; }
  };
}

test('room rail entries are semantic buttons with notification-aware labels and silent badges', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /<button[^>]*class="server-icon active"[^>]*id="srv-global"[^>]*type="button"/);
  assert.match(source, /<button[^>]*class="server-icon add-btn"[^>]*type="button"/);
  const addStart = source.indexOf('function addServerToList(');
  const addEnd = source.indexOf('\n    function ', addStart + 1);
  const addBlock = source.slice(addStart, addEnd);
  assert.match(addBlock, /document\.createElement\('button'\)/);
  assert.match(addBlock, /icon\.type\s*=\s*'button'/);
  assert.match(addBlock, /aria-label/);
  assert.match(source, /className\s*=\s*'room-attention-badge'/);
  assert.doesNotMatch(source, /room-attention-badge[^>\n]*aria-live/);
});

test('Room Info and Pins dialogs have labelled modal semantics initial focus Escape and focus restoration', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const [id, label] of [
    ['room-info-modal', 'room-info-title'],
    ['pins-modal', 'pins-title']
  ]) {
    assert.match(
      source,
      new RegExp(`id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="${label}"`)
    );
  }

  const client = loadHelpers();
  const doc = createFakeEventTarget();
  const dialog = createFakeElement(doc);
  const trigger = createFakeElement(doc);
  const initial = createFakeElement(doc);
  const controller = client.createFocusDialogController({
    dialog,
    documentTarget: doc,
    getInitialFocus: () => initial
  });
  controller.open(trigger);
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.classList.contains('active'), true);
  assert.equal(doc.activeElement, initial);
  doc.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(dialog.hidden, true);
  assert.equal(dialog.classList.contains('active'), false);
  assert.equal(doc.activeElement, trigger);
});

test('Room Info exposes read content edit save and notification controls by exact policy', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const id of [
    'room-info-btn', 'room-info-title', 'room-description', 'room-rules',
    'room-notification-level', 'room-info-edit', 'room-info-save'
  ]) assert.equal((source.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  assert.match(source, /id="room-notification-level"[\s\S]*<option value="all">[\s\S]*<option value="mentions">[\s\S]*<option value="none">/);
  const renderStart = source.indexOf('function renderRoomInfo(');
  const renderEnd = source.indexOf('\n    function ', renderStart + 1);
  const renderBlock = source.slice(renderStart, renderEnd);
  assert.match(renderBlock, /details\.canEdit/);
  assert.match(renderBlock, /roomInfoEdit\.hidden/);
  assert.match(renderBlock, /roomInfoSave\.hidden/);
  assert.match(renderBlock, /textContent/);
});

test('newly joined rooms open Room Info once after a successful join', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const joinCalls = source.match(/queueJoinedRoomInfoIntent\(res\.server\.code,[^)]+\)/g) || [];
  assert.equal(joinCalls.length, 3, 'join, create, and admin-visible join share the exact intent path');
  assert.match(source, /function consumeJoinedRoomInfoIntent[\s\S]*openRoomInfo\(intent\.trigger/);
});

test('pending joined Room Info intent is consumed only by the exact accepted room switch generation', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /pendingJoinedRoomInfoIntent\s*=\s*Object\.freeze\(\{[\s\S]*roomCode[\s\S]*switchToken/);
  assert.match(source, /function consumeJoinedRoomInfoIntent\(roomCode, switchToken\)[\s\S]*intent\.roomCode !== roomCode[\s\S]*intent\.switchToken !== switchToken/);
  assert.match(source, /function handleSwitchResult\(code, res, switchToken[\s\S]*consumeJoinedRoomInfoIntent\(targetServerCode, switchToken\)/);
});

test('older in-flight switch completion cannot cancel a queued joined-room info intent', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const consumeStart = source.indexOf('function consumeJoinedRoomInfoIntent(');
  const consumeEnd = source.indexOf('\n    function ', consumeStart + 1);
  const consumeBlock = source.slice(consumeStart, consumeEnd);
  assert.match(consumeBlock, /if \(!intent/);
  assert.match(consumeBlock, /return false/);
  assert.ok(
    consumeBlock.indexOf('intent.switchToken !== switchToken') <
      consumeBlock.indexOf('pendingJoinedRoomInfoIntent = null'),
    'a mismatched completion returns before clearing the queued intent'
  );
  assert.match(source, /function supersedeJoinedRoomInfoIntent[\s\S]*origin === 'user'/);
});

test('Pins load bodies only when opened and stale room pin acknowledgements are ignored', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const openStart = source.indexOf('function openPins(');
  const openEnd = source.indexOf('\n    function ', openStart + 1);
  const openBlock = source.slice(openStart, openEnd);
  assert.match(openBlock, /featureGenerations\.begin\('pins', roomCode\)/);
  assert.match(openBlock, /socket\.emit\('list_pinned_messages'/);
  assert.ok(openBlock.indexOf('featureGenerations.isCurrent') < openBlock.indexOf('response.error'));
  assert.match(openBlock, /ChatClientHelpers\.acceptPinBodies/);

  const loginStart = source.indexOf("authSocket.emit(action, payload");
  const loginEnd = source.indexOf('function showError', loginStart);
  assert.doesNotMatch(source.slice(loginStart, loginEnd), /list_pinned_messages/);
  const switchStart = source.indexOf('function handleSwitchResult(');
  const switchEnd = source.indexOf('function copyCode', switchStart);
  assert.doesNotMatch(source.slice(switchStart, switchEnd), /list_pinned_messages/);
});

test('message and member menus expose exact pin block and unblock actions', () => {
  const client = loadHelpers();
  assert.deepEqual([...client.messageActionsFor({
    canReply: true, canReact: true, canManagePins: true, pinned: false,
    canReport: true, canDelete: false
  })], ['reply', 'react', 'pin', 'report']);
  assert.deepEqual([...client.messageActionsFor({
    canReply: true, canReact: true, canManagePins: true, pinned: true,
    canReport: false, canDelete: true
  })], ['reply', 'react', 'unpin', 'delete']);
  assert.deepEqual({ ...client.blockActionFor({ username: 'Bob', isSelf: false, blocked: false }) }, {
    action: 'block', label: 'Block', blocked: true
  });
  assert.deepEqual({ ...client.blockActionFor({ username: 'Bob', isSelf: false, blocked: true }) }, {
    action: 'unblock', label: 'Unblock', blocked: false
  });
  assert.equal(client.blockActionFor({ username: 'Alice', isSelf: true, blocked: false }), null);
});

test('blocked rows are collapsed content-free controls and Show is independently expanded', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const start = source.indexOf('function renderBlockedMessage(');
  const end = source.indexOf('\n    function ', start + 1);
  const block = source.slice(start, end);
  assert.match(block, /textContent\s*=\s*'Blocked message — Show'/);
  assert.match(block, /setAttribute\('aria-expanded', 'false'\)/);
  assert.match(block, /get_blocked_message/);
  assert.match(block, /featureGenerations\.isCurrent\(token, identity\)/);
  assert.match(block, /setAttribute\('aria-expanded', 'true'\)/);
  for (const leakedField of ['data.text', 'data.attachment', 'data.replyTo', 'data.reactions']) {
    assert.doesNotMatch(block, new RegExp(leakedField.replace('.', '\\.')));
  }
});

test('blocked user settings permit recovery and unblocking without target disclosure', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const id of ['blocked-users-list', 'blocked-users-empty']) {
    assert.equal((source.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(source, /function renderBlockedUsers[\s\S]*button\.textContent|function renderBlockedUsers[\s\S]*'Unblock'/);
  assert.match(source, /function setUserBlocked\(username, blocked, control\)[\s\S]*set_user_block/);
  assert.match(source, /user_block_updated/);
  assert.doesNotMatch(source, /(?:alert|showAppAlert)\([^\n]*blockedUsers/i);
});

test('author avatar member and menu triggers support Enter Space aria-haspopup and aria-expanded', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /function createMemberMenuTrigger[\s\S]*document\.createElement\('button'\)[\s\S]*aria-haspopup[\s\S]*aria-expanded/);
  assert.match(source, /function createAuthorMenuTrigger[\s\S]*document\.createElement\('button'\)[\s\S]*aria-haspopup[\s\S]*aria-expanded/);
  assert.match(source, /function createMessageMenuTrigger[\s\S]*document\.createElement\('button'\)[\s\S]*aria-haspopup[\s\S]*aria-expanded/);
  assert.match(source, /handleTriggerKeydown/);
});

test('menus focus the first item close on Escape or outside activation and restore trigger focus', () => {
  const client = loadHelpers();
  const doc = createFakeEventTarget();
  const menu = createFakeElement(doc);
  const firstDisabled = createFakeElement(doc, { disabled: true });
  const firstEnabled = createFakeElement(doc);
  menu.children.push(firstDisabled, firstEnabled);
  const trigger = createFakeElement(doc);
  const outside = createFakeElement(doc);
  const controller = client.createMenuController({
    menu,
    documentTarget: doc,
    getItems: () => menu.children
  });

  controller.handleTriggerKeydown({ key: 'Enter', preventDefault() {} }, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.activeElement, firstEnabled);
  doc.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, trigger);

  controller.handleTriggerKeydown({ key: ' ', preventDefault() {} }, trigger);
  doc.dispatch('pointerdown', { target: outside });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, trigger);
});

test('message actions remain keyboard and coarse-pointer reachable without hover', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /\.msg:focus-within\s+\.msg-actions\s*\{[^}]*opacity:\s*1[^}]*visibility:\s*visible/s);
  assert.match(source, /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)[\s\S]*\.msg-actions\s*\{[^}]*opacity:\s*1[^}]*visibility:\s*visible/s);
  assert.match(source, /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)[\s\S]*\.action-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
});

test('mobile header keeps Room Info and Pins visible and moves every other action into one overflow menu', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  for (const id of ['room-info-btn', 'pins-btn', 'header-overflow-btn', 'header-overflow-menu']) {
    assert.equal((source.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  const start = source.indexOf('@media (max-width: 700px)');
  const end = source.indexOf('</style>', start);
  const mobile = source.slice(start, end);
  assert.notEqual(start, -1);
  for (const id of ['room-info-btn', 'pins-btn']) {
    assert.match(mobile, new RegExp(`#${id}\\s*\\{[^}]*display:\\s*(?:inline-)?flex[^}]*min-width:\\s*44px[^}]*min-height:\\s*44px`, 's'));
  }
  assert.match(mobile, /#header-overflow-btn\s*\{[^}]*display:\s*(?:inline-)?flex[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(mobile, /#header-overflow-menu\s*\.header-btn\s*\{[^}]*min-height:\s*44px[^}]*width:\s*100%/s);
  for (const id of [
    'invite-code-btn', 'leave-server-btn', 'delete-server-btn', 'join-server-btn',
    'moderator-center-btn', 'settings-btn', 'logout-btn'
  ]) assert.match(mobile, new RegExp(`#${id}\\s*\\{[^}]*display:\\s*none`, 's'), id);
});

test('responsive header contract maps 320px and 200 percent text scale to reachable 44px targets', () => {
  const client = loadHelpers();
  const layout = client.headerLayoutContract(320, 2);
  assert.equal(layout.breakpoint, 700);
  assert.equal(layout.targetSize, 44);
  assert.equal(layout.mobile, true);
  assert.deepEqual([...layout.visible], ['room-info-btn', 'pins-btn', 'header-overflow-btn']);
  assert.equal(layout.slots.length, 3);
  for (const slot of layout.slots) {
    assert.equal(slot.width >= 44, true);
    assert.equal(slot.height >= 44, true);
    assert.equal(slot.left >= 0, true);
    assert.equal(slot.right <= 320, true);
  }
  assert.equal(layout.slots[0].right <= layout.slots[1].left, true);
  assert.equal(layout.slots[1].right <= layout.slots[2].left, true);
});

test('new UI preserves reduced motion and the exact Chat v1.3.2 title', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.equal((source.match(/<title>Chat v1\.3\.2<\/title>/g) || []).length, 1);
  assert.doesNotMatch(source, /transition:\s*all\b/);
  const reducedStart = source.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(reducedStart, -1);
  const reduced = source.slice(reducedStart, source.indexOf('</style>', reducedStart));
  assert.match(reduced, /\.modal-box/);
  assert.match(reduced, /animation-duration:\s*0\.01ms\s*!important/);
});

test('complete client race matrix rejects old socket room dialog pin block read and activity work', () => {
  const client = loadHelpers();
  const source = fs.readFileSync(chatPath, 'utf8');
  const generations = client.createScopedGenerationCoordinator();
  const oldSocket = { id: 'old' };
  const newSocket = { id: 'new' };
  let activeSocket = oldSocket;
  let currentRoom = 'AAAAAA';
  let blockState = null;
  const details = new Map();
  const pins = new Map();
  const reads = new Map();
  const activityIds = new Map();
  const rendered = [];

  const oldDialog = generations.begin('room-info', 'AAAAAA');
  const oldPin = generations.begin('pin-action', 'AAAAAA');
  const oldRead = generations.begin('mark-read', 'AAAAAA:1:old');
  const oldReveal = generations.begin('reveal', 'AAAAAA:old');

  generations.invalidateAll();
  activeSocket = newSocket;
  currentRoom = 'AAAAAA';
  const roomA = generations.begin('active-room', currentRoom);
  const roomADialog = generations.begin('room-info', currentRoom);
  const roomAPin = generations.begin('pin-action', currentRoom);
  const roomARead = generations.begin('mark-read', `${currentRoom}:${roomA.generation}:a`);
  const closedReveal = generations.begin('reveal', `${currentRoom}:message-a`);
  generations.invalidate('reveal');

  currentRoom = 'BBBBBB';
  const roomB = generations.begin('active-room', currentRoom);
  for (const scope of [
    'room-info', 'room-info-save', 'pins', 'pin-action', 'reveal', 'mark-read',
    'room-notification'
  ]) generations.invalidate(scope);
  const roomBDialog = generations.begin('room-info', currentRoom);
  const roomBReveal = generations.begin('reveal', `${currentRoom}:message-b`);

  function acceptDetails(socketRef, token, incoming) {
    if (socketRef !== activeSocket || incoming.serverCode !== currentRoom ||
        !generations.isCurrent(token, incoming.serverCode)) return false;
    const current = details.get(incoming.serverCode) || null;
    const next = client.acceptVersionedState(current, incoming, 'metadata');
    if (next === current) return false;
    details.set(incoming.serverCode, next);
    return true;
  }

  assert.equal(acceptDetails(oldSocket, oldDialog, {
    serverCode: 'AAAAAA', metadataVersion: 99, description: 'old socket'
  }), false);
  assert.equal(acceptDetails(newSocket, roomADialog, {
    serverCode: 'AAAAAA', metadataVersion: 99, description: 'old room'
  }), false);
  assert.equal(acceptDetails(newSocket, roomBDialog, {
    serverCode: 'BBBBBB', metadataVersion: 4, description: 'current'
  }), true);
  assert.equal(acceptDetails(newSocket, roomBDialog, {
    serverCode: 'BBBBBB', metadataVersion: 3, description: 'stale version'
  }), false);

  blockState = client.acceptVersionedState(blockState, {
    accountKey: 'alice', blockVersion: 2, blockedUsers: []
  }, 'blocks');
  const staleBlock = client.acceptVersionedState(blockState, {
    accountKey: 'alice', blockVersion: 1,
    blockedUsers: [{ usernameKey: 'secret', username: 'Secret' }]
  }, 'blocks');
  assert.equal(staleBlock, blockState);

  const currentPin = client.acceptVersionedState(null, {
    serverCode: 'BBBBBB', pinCount: 1, pinVersion: 3, blockVersion: 2
  }, 'pins');
  pins.set('BBBBBB', currentPin);
  assert.equal(client.acceptVersionedState(currentPin, {
    serverCode: 'BBBBBB', pinCount: 8, pinVersion: 2, blockVersion: 2
  }, 'pins'), currentPin);
  assert.equal(generations.isCurrent(oldPin, 'AAAAAA'), false);
  assert.equal(generations.isCurrent(roomAPin, 'AAAAAA'), false);

  const exactRead = client.acceptVersionedState(null, {
    serverCode: 'BBBBBB', usernameKey: 'alice', notificationLevel: 'all',
    lastReadAt: '2026-08-10T12:00:00.000Z', lastReadMessageId: 'b',
    unreadCount: 2, mentionCount: 1, version: 5, blockVersion: 2
  }, 'room-state');
  reads.set('BBBBBB', exactRead);
  assert.equal(client.acceptVersionedState(exactRead, {
    ...exactRead, unreadCount: 9, version: 4
  }, 'room-state'), exactRead);
  assert.equal(generations.isCurrent(oldRead, 'AAAAAA:1:old'), false);
  assert.equal(generations.isCurrent(roomARead, `AAAAAA:${roomA.generation}:a`), false);

  activityIds.set('BBBBBB', client.createRecentIdSet());
  const activity = {
    serverCode: 'BBBBBB', messageId: 'new-message', timestamp: '2026-08-10T12:01:00.000Z',
    mentioned: true, blockVersion: 2
  };
  const afterActivity = client.applyRoomActivity(exactRead, activity, activityIds.get('BBBBBB'));
  assert.notEqual(afterActivity, exactRead);
  assert.equal(client.applyRoomActivity(afterActivity, activity, activityIds.get('BBBBBB')), afterActivity);

  if (generations.isCurrent(oldReveal, 'AAAAAA:old')) rendered.push('old socket reveal');
  if (generations.isCurrent(closedReveal, 'AAAAAA:message-a')) rendered.push('closed reveal');
  if (generations.isCurrent(roomBReveal, 'BBBBBB:message-b')) rendered.push('current B reveal');
  assert.deepEqual(rendered, ['current B reveal']);
  assert.deepEqual([...details.keys()], ['BBBBBB']);
  assert.deepEqual([...pins.keys()], ['BBBBBB']);
  assert.deepEqual([...reads.keys()], ['BBBBBB']);
  assert.equal(generations.isCurrent(roomA, 'AAAAAA'), false);
  assert.equal(generations.isCurrent(roomB, 'BBBBBB'), true);

  const pinStart = source.indexOf('function setMessagePinned(');
  const pinEnd = source.indexOf('\n    function ', pinStart + 1);
  const pinBlock = source.slice(pinStart, pinEnd);
  assert.match(pinBlock, /featureGenerations\.begin\('pin-action', context\.roomCode\)/);
  assert.ok(pinBlock.indexOf('featureGenerations.isCurrent') < pinBlock.indexOf('response.error'));
  const switchStart = source.indexOf('function handleSwitchResult(');
  const switchEnd = source.indexOf('function copyCode', switchStart);
  assert.match(source.slice(switchStart, switchEnd), /invalidateRoomScopedFeatureCallbacks\(\)/);
});

test('complete mobile keyboard matrix keeps every authorized action reachable', () => {
  const client = loadHelpers();
  const source = fs.readFileSync(chatPath, 'utf8');
  const actionPairs = [
    ['invite-code-btn', 'overflow-invite-btn'],
    ['leave-server-btn', 'overflow-leave-btn'],
    ['delete-server-btn', 'overflow-delete-btn'],
    ['join-server-btn', 'overflow-join-btn'],
    ['moderator-center-btn', 'overflow-moderate-btn'],
    ['settings-btn', 'overflow-settings-btn'],
    ['logout-btn', 'overflow-logout-btn']
  ];

  for (const [directId, overflowId] of actionPairs) {
    assert.match(source, new RegExp(`<button[^>]*id="${directId}"[^>]*type="button"`, 'i'), directId);
    assert.match(source, new RegExp(`<button[^>]*id="${overflowId}"[^>]*type="button"[^>]*role="menuitem"`, 'i'), overflowId);
  }
  assert.doesNotMatch(source, /<meta\s+name="viewport"[^>]*(?:user-scalable\s*=\s*no|maximum-scale\s*=\s*1)/i);

  const roleCases = [
    [{ canReply: true, canReact: true, canManagePins: true, pinned: false, canReport: true },
      ['reply', 'react', 'pin', 'report']],
    [{ canReply: true, canReact: true, canManagePins: true, pinned: true, canDelete: true },
      ['reply', 'react', 'unpin', 'delete']],
    [{ canReply: true, canReact: true, canManagePins: false, canReport: true },
      ['reply', 'react', 'report']]
  ];
  for (const [context, expected] of roleCases) {
    assert.deepEqual([...client.messageActionsFor(context)], expected);
  }
  assert.deepEqual({ ...client.blockActionFor({ username: 'Bob', blocked: false }) }, {
    action: 'block', label: 'Block', blocked: true
  });
  assert.deepEqual({ ...client.blockActionFor({ username: 'Bob', blocked: true }) }, {
    action: 'unblock', label: 'Unblock', blocked: false
  });

  for (const [width, scale, expectedMobile] of [[320, 2, true], [700, 1, true], [701, 2, false]]) {
    const layout = client.headerLayoutContract(width, scale);
    assert.equal(layout.mobile, expectedMobile, `${width}px at ${scale}x`);
    assert.equal(layout.targetSize, 44);
    if (!expectedMobile) continue;
    assert.deepEqual([...layout.visible], ['room-info-btn', 'pins-btn', 'header-overflow-btn']);
    for (const slot of layout.slots) {
      assert.equal(slot.width >= 44 && slot.height >= 44, true);
      assert.equal(slot.left >= 0 && slot.right <= width, true);
    }
  }
});

test('closing feature dialogs resets pending mutation controls before reopen', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const infoStart = source.indexOf('const roomInfoDialogController =');
  const infoEnd = source.indexOf('const pinsDialogController =', infoStart);
  const info = source.slice(infoStart, infoEnd);
  assert.match(info, /onClose\(\)[\s\S]*operationReceipts\.invalidate\('metadata'\)/);
  assert.match(info, /onClose\(\)[\s\S]*pendingMetadataOperation\s*=\s*null/);
  assert.match(info, /onClose\(\)[\s\S]*roomInfoSave\.disabled\s*=\s*false/);

  const pinsStart = source.indexOf('const pinsDialogController =');
  const pinsEnd = source.indexOf('const headerOverflowController =', pinsStart);
  const pins = source.slice(pinsStart, pinsEnd);
  assert.match(pins, /onClose\(\)[\s\S]*featureGenerations\.invalidate\('pin-action'\)/);
  assert.match(pins, /onClose\(\)[\s\S]*operationReceipts\.invalidate\('pin'\)/);
  assert.match(pins, /onClose\(\)[\s\S]*pendingPinOperation\s*=\s*null/);
});

test('block replacement synchronously removes compose reply and rendered pin bodies', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const replaceStart = source.indexOf('function replaceActiveMessagesWithBlockRefreshState(');
  const replaceEnd = source.indexOf('\n    function ', replaceStart + 1);
  const replace = source.slice(replaceStart, replaceEnd);
  assert.match(replace, /cancelAction\(\)/);
  assert.ok(replace.indexOf('cancelAction()') < replace.indexOf("'Refreshing messages…'"));

  const blockStart = source.indexOf('function applyAcceptedBlockState(');
  const blockEnd = source.indexOf('\n    function ', blockStart + 1);
  const block = source.slice(blockStart, blockEnd);
  assert.match(block, /document\.getElementById\('pins-list'\)\.textContent\s*=\s*''/);
  assert.match(block, /closePins\(\)/);
  assert.ok(block.indexOf("document.getElementById('pins-list').textContent = ''") <
    block.indexOf('renderBlockedUsers()'));
});

test('block refresh suppression follows the accepted room generation and clears after switch failure', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const start = source.indexOf('function handleSwitchResult(');
  const end = source.indexOf('\n    function copyCode', start);
  const block = source.slice(start, end);
  assert.match(block, /readSuppressionToken\s*=\s*ChatClientHelpers\.rebindSuppressionToken\([\s\S]*currentRoomGeneration/);
  assert.ok(block.indexOf('ChatClientHelpers.rebindSuppressionToken') < block.indexOf('loadHistory(response.history)'));
  assert.match(block, /if\s*\(!outcome\.accepted\s*&&\s*options\.suppressAutoRead\s*===\s*true\)[\s\S]*disarmReadSuppression\(options\.suppressionToken\)/);
  assert.match(block, /return outcome/);
});

test('joined-room intent owns a forced current-socket switch and same-room user intent supersedes it', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const forcedJoinSwitches = source.match(
    /switchServer\(res\.server\.code,\s*\{\s*origin:\s*'join',\s*forceRefresh:\s*true\s*\}\)/g
  ) || [];
  assert.equal(forcedJoinSwitches.length, 3, 'visible join, invite join, and create all own a real switch token');

  for (const socketName of ['joinSocket', 'createSocket', 'inviteSocket']) {
    assert.match(source, new RegExp(`const ${socketName} = socket;[\\s\\S]*${socketName}\\.emit`));
    assert.match(source, new RegExp(`${socketName}\\.emit[\\s\\S]*if \\(${socketName} !== socket\\) return`));
  }

  const supersedeStart = source.indexOf('function supersedeJoinedRoomInfoIntent(');
  const supersedeEnd = source.indexOf('\n    function ', supersedeStart + 1);
  const supersede = source.slice(supersedeStart, supersedeEnd);
  assert.match(supersede, /origin === 'user'\s*&&\s*pendingJoinedRoomInfoIntent/);
  assert.doesNotMatch(supersede, /pendingJoinedRoomInfoIntent\.roomCode\s*!==\s*roomCode/);
});

test('hydrated and event pin state updates existing message actions without stale closures', () => {
  const client = loadHelpers();
  const pin = id => ({ dataset: { messageId: id, pinned: 'false' }, textContent: 'Pin' });
  const first = pin('first');
  const second = pin('second');
  assert.equal(client.syncPinActionControls([first, second], {
    pinsLoaded: true,
    pins: [{ messageId: 'second' }]
  }), 2);
  assert.deepEqual(
    [first, second].map(control => [control.dataset.pinned, control.textContent]),
    [['false', 'Pin'], ['true', 'Unpin']]
  );
  assert.equal(client.syncPinActionControls([first, second], null, {
    messageId: 'first', pinned: true
  }), 1);
  assert.deepEqual([first.dataset.pinned, first.textContent], ['true', 'Unpin']);

  const source = fs.readFileSync(chatPath, 'utf8');
  const syncStart = source.indexOf('function syncMessagePinControls(');
  const syncEnd = source.indexOf('\n    function ', syncStart + 1);
  const sync = source.slice(syncStart, syncEnd);
  assert.match(sync, /pinsByRoom\.get\(serverCode\)/);
  assert.match(sync, /\.message-pin-action\[data-message-id\]/);
  assert.match(sync, /ChatClientHelpers\.syncPinActionControls/);

  const openStart = source.indexOf('function openPins(');
  const openEnd = source.indexOf('\n    function ', openStart + 1);
  assert.match(source.slice(openStart, openEnd), /pinsByRoom\.set\(roomCode, hydrated\)[\s\S]*syncMessagePinControls\(roomCode\)/);

  const eventStart = source.indexOf("activeSocket.on('message_pin_updated'");
  const eventEnd = source.indexOf("activeSocket.on('room_notification_updated'", eventStart);
  assert.match(source.slice(eventStart, eventEnd), /if \(accepted[\s\S]*updateMessagePinControlState\(/);

  const appendStart = source.indexOf('function appendMessage(');
  const appendEnd = source.indexOf('\n    function ', appendStart + 1);
  const append = source.slice(appendStart, appendEnd);
  assert.match(append, /pinBtn\.className\s*=\s*'action-btn message-pin-action'/);
  assert.match(append, /pinBtn\.dataset\.messageId\s*=/);
  assert.match(append, /setMessagePinned\([\s\S]*pinBtn\.dataset\.pinned !== 'true'/);
  assert.doesNotMatch(append, /setMessagePinned\([^\n]*!isPinned/);
});

test('overlapping block refreshes retain the newest suppression through the scroll mark frame', () => {
  const client = loadHelpers();
  const tokenA = Object.freeze({ id: 'A' });
  const tokenB = Object.freeze({ id: 'B' });
  assert.equal(client.releaseExactToken(tokenB, tokenA), tokenB, 'older A cannot release newer B');
  assert.equal(client.releaseExactToken(tokenB, tokenB), null, 'the exact owner can release B');

  const frames = [];
  const observedDuringMark = [];
  let active = tokenA;
  const schedule = callback => frames.push(callback);
  schedule(() => schedule(() => observedDuringMark.push(active)));
  client.scheduleAfterScrollFrame(schedule, () => { active = client.releaseExactToken(active, tokenA); });
  const firstFrame = frames.splice(0);
  firstFrame.forEach(callback => callback());
  assert.equal(active, tokenA);
  const secondFrame = frames.splice(0);
  secondFrame.forEach(callback => callback());
  assert.deepEqual(observedDuringMark, [tokenA], 'scroll-triggered mark check sees suppression');
  assert.equal(active, null, 'release follows the mark-check frame');

  const source = fs.readFileSync(chatPath, 'utf8');
  const refreshStart = source.indexOf('function handleRoomRefreshRequired(');
  const refreshEnd = source.indexOf('\n    const authModal', refreshStart);
  const refresh = source.slice(refreshStart, refreshEnd);
  assert.match(refresh, /const suppressionToken\s*=\s*Object\.freeze/);
  assert.match(refresh, /readSuppressionToken\s*=\s*suppressionToken/);
  assert.match(refresh, /requestServerSwitch\([\s\S]*suppressionToken/);

  const switchStart = source.indexOf('function handleSwitchResult(');
  const switchEnd = source.indexOf('\n    function copyCode', switchStart);
  const switchBlock = source.slice(switchStart, switchEnd);
  assert.match(switchBlock, /ChatClientHelpers\.sameSuppressionOwner/);
  assert.match(switchBlock, /ChatClientHelpers\.rebindSuppressionToken/);
  assert.match(switchBlock, /disarmReadSuppression\(options\.suppressionToken\)/);
  assert.doesNotMatch(switchBlock, /disarmReadSuppression\(\)/);
  assert.match(
    switchBlock,
    /ChatClientHelpers\.scheduleAfterScrollFrame\([\s\S]*disarmReadSuppression\(ownedToken\s*\|\|\s*acceptedSuppressionToken\)/
  );
});

test('timed-out message policy hides mutations except own delete and restores them on expiry', () => {
  const client = loadHelpers();
  assert.deepEqual([...client.messageActionsFor({
    timedOut: true,
    isOwn: true,
    canReply: true,
    canReact: true,
    canManagePins: true,
    pinned: true,
    canEdit: true,
    canReport: false,
    canDelete: true
  })], ['delete']);
  assert.deepEqual([...client.messageActionsFor({
    timedOut: true,
    isOwn: false,
    canReply: true,
    canReact: true,
    canManagePins: false,
    canEdit: false,
    canReport: true,
    canDelete: false
  })], ['report']);
  assert.deepEqual([...client.messageActionsFor({
    timedOut: true,
    isOwn: false,
    canReply: true,
    canReact: true,
    canManagePins: true,
    pinned: false,
    canEdit: true,
    canReport: true,
    canDelete: true
  })], ['report']);
  assert.deepEqual([...client.messageActionsFor({
    timedOut: false,
    isOwn: false,
    canReply: true,
    canReact: true,
    canManagePins: true,
    pinned: false,
    canEdit: true,
    canReport: true,
    canDelete: true
  })], ['reply', 'react', 'pin', 'edit', 'report', 'delete']);

  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /let currentRestrictionState\s*=\s*Object\.freeze/);
  assert.match(source, /function isCurrentRoomTimedOut\(\)/);
  assert.match(source, /function canManagePinsInCurrentRoom\(\)[\s\S]*!isCurrentRoomTimedOut\(\)/);
  assert.match(source, /function syncMessageActionAvailability\(\)[\s\S]*data-active-room-required/);
  const restrictionStart = source.indexOf('const restrictionCoordinator =');
  const restrictionEnd = source.indexOf('const roomAccessCoordinator =', restrictionStart);
  const restriction = source.slice(restrictionStart, restrictionEnd);
  assert.match(restriction, /currentRestrictionState\s*=\s*Object\.freeze/);
  assert.match(restriction, /syncMessageActionAvailability\(\)/);
  assert.match(restriction, /pinsDialogController\.isOpen\(\)[\s\S]*renderPins\(\)/);

  const appendStart = source.indexOf('function appendMessage(');
  const appendEnd = source.indexOf('\n    function ', appendStart + 1);
  const append = source.slice(appendStart, appendEnd);
  assert.match(append, /ChatClientHelpers\.messageActionsFor\(\{[\s\S]*timedOut:\s*isCurrentRoomTimedOut\(\)/);
  assert.match(append, /data-active-room-required/);
  assert.match(append, /isMe\s*\|\|\s*!isCurrentRoomTimedOut\(\)/);
  assert.doesNotMatch(append, /const canManagePins\s*=\s*myRole/);

  for (const functionName of ['setMessagePinned', 'initiateEdit', 'initiateReply']) {
    const start = source.indexOf(`function ${functionName}(`);
    const end = source.indexOf('\n    function ', start + 1);
    assert.match(source.slice(start, end), /isCurrentRoomTimedOut\(\)/, functionName);
  }
  const reactionsStart = source.indexOf('function renderReactions(');
  const reactionsEnd = source.indexOf('\n    function ', reactionsStart + 1);
  assert.match(source.slice(reactionsStart, reactionsEnd), /isCurrentRoomTimedOut\(\)/);
});

test('a stale switch acknowledgement cannot restore history scrubbed by a newer block version', () => {
  const client = loadHelpers();
  const callbacks = [];
  const renderedHistory = ['visible-before-block'];
  let acceptedBlockVersion = 4;
  let currentServerCode = 'global';

  const coordinator = client.createSwitchCoordinator(
    (target, callback) => callbacks.push({ target, callback }),
    (targetServerCode, response) => {
      const outcome = client.applySwitchResult({
        currentServerCode,
        targetServerCode,
        response,
        acceptedBlockVersion,
        showAlert() {},
        applySuccess(nextRoom, accepted) {
          currentServerCode = nextRoom;
          for (const message of accepted.history || []) renderedHistory.push(message.text);
        }
      });
      currentServerCode = outcome.currentServerCode;
    }
  );

  coordinator.request('ABC123', { origin: 'user' });
  acceptedBlockVersion = 5;
  renderedHistory.length = 0;
  coordinator.request('ABC123', { forceRefresh: true, origin: 'block-refresh' });

  callbacks[0].callback({
    serverCode: 'ABC123',
    history: [{ _id: 'secret', text: 'BLOCKED CONTENT SENTINEL' }],
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 1, blockVersion: 4 },
    notification: { serverCode: 'ABC123', version: 1, blockVersion: 4 }
  });

  assert.deepEqual(renderedHistory, [], 'older serialized history never reaches the fake DOM');
  assert.equal(currentServerCode, 'global', 'the stale acknowledgement cannot change visible room state');
  assert.equal(callbacks.length, 2, 'the queued content-free refresh starts immediately');

  const source = fs.readFileSync(chatPath, 'utf8');
  const switchStart = source.indexOf('function handleSwitchResult(');
  const switchEnd = source.indexOf('\n    function copyCode', switchStart);
  const switchBlock = source.slice(switchStart, switchEnd);
  assert.match(switchBlock, /acceptedBlockVersion/);
  assert.ok(
    switchBlock.indexOf('acceptedBlockVersion') < switchBlock.indexOf('invalidateRoomScopedFeatureCallbacks()'),
    'block authority is checked before any room or DOM mutation'
  );
});

function createRuntimeSocket() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    trigger(event, payload) {
      const handler = handlers.get(event);
      assert.equal(typeof handler, 'function', `${event} listener is registered`);
      return handler(payload);
    }
  };
}

function clientFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} exists`);
  const end = source.indexOf('\n    function ', start + 1);
  assert.notEqual(end, -1, `${functionName} has a following function boundary`);
  return source.slice(start, end);
}

function setupSocketSource(source) {
  const start = source.indexOf('function setupSocket(');
  const end = source.indexOf('\n    // --- REACTION UI ENGINE ---', start);
  assert.notEqual(start, -1, 'setupSocket exists');
  assert.notEqual(end, -1, 'setupSocket boundary exists');
  return source.slice(start, end);
}

function createSetupSocketRuntime(overrides = {}, extraFunctions = []) {
  const source = fs.readFileSync(chatPath, 'utf8');
  const client = loadHelpers();
  const initialSocket = overrides.socket || createRuntimeSocket();
  const context = vm.createContext({
    ChatClientHelpers: client,
    socket: initialSocket,
    authModal: { classList: { contains: () => false } },
    authBtn: { disabled: false },
    showError() {},
    localStorage: { removeItem() {} },
    alert() {},
    location: { reload() {} },
    currentServerCode: 'ABC123',
    myUsername: 'alice',
    myDisplayName: 'Alice',
    roomStateByCode: new Map([['ABC123', { notificationLevel: 'all' }]]),
    typingUsers: new Map(),
    appendMessage() {},
    updateTypingUI() {},
    scheduleMaybeMarkCurrentRoomRead() {},
    playSound() {},
    ...overrides
  });
  const functions = extraFunctions.map(name => clientFunctionSource(source, name)).join('\n');
  vm.runInContext(
    `${functions}\n${setupSocketSource(source)}\nglobalThis.__setupSocket = setupSocket;`,
    context,
    { filename: 'chat-setup-socket-runtime.js' }
  );
  return { client, context, setupSocket: context.__setupSocket };
}

function createQueuedRefreshRuntime() {
  const source = fs.readFileSync(chatPath, 'utf8');
  const client = loadHelpers();
  const socket = {};
  const emissions = [];
  let coordinator;
  let context;
  context = vm.createContext({
    ChatClientHelpers: client,
    socket,
    currentServerCode: 'ABC123',
    acceptedBlockVersion: 5,
    currentRoomGeneration: 7,
    readSuppressionToken: null,
    requestServerSwitch(target, options) {
      return coordinator.request(target, options);
    }
  });
  coordinator = client.createSwitchCoordinator(
    (target, callback) => emissions.push({ target, callback }),
    (target, response, _token, options) => {
      if (!response || response.error) return;
      context.currentServerCode = target;
      context.currentRoomGeneration += 1;
      if (context.readSuppressionToken?.roomCode === target) {
        context.readSuppressionToken = client.rebindSuppressionToken(
          context.readSuppressionToken,
          target,
          context.currentRoomGeneration
        );
      }
      if (options.suppressAutoRead === true && client.sameSuppressionOwner(
        context.readSuppressionToken,
        options.suppressionToken
      )) {
        context.readSuppressionToken = client.releaseExactToken(
          context.readSuppressionToken,
          context.readSuppressionToken
        );
      }
    }
  );
  const refreshStart = source.indexOf('function handleRoomRefreshRequired(');
  const refreshEnd = source.indexOf('\n    const authModal', refreshStart);
  assert.notEqual(refreshStart, -1, 'refresh handler exists');
  assert.notEqual(refreshEnd, -1, 'refresh handler boundary exists');
  vm.runInContext(
    `${clientFunctionSource(source, 'disarmReadSuppression')}\n` +
      `${source.slice(refreshStart, refreshEnd)}\n` +
      'globalThis.__handleRoomRefreshRequired = handleRoomRefreshRequired;',
    context,
    { filename: 'chat-refresh-queue-runtime.js' }
  );
  return { client, context, coordinator, emissions, socket };
}

test('superseding a queued refresh releases only its suppression owner for later reads', () => {
  const sameRoom = createQueuedRefreshRuntime();
  sameRoom.context.__handleRoomRefreshRequired({ serverCode: 'ABC123', blockVersion: 5 }, sameRoom.socket);
  const sameRoomTokenA = sameRoom.context.readSuppressionToken;
  sameRoom.context.__handleRoomRefreshRequired({ serverCode: 'ABC123', blockVersion: 5 }, sameRoom.socket);
  const userCancellations = [];

  sameRoom.coordinator.request('ABC123', {
    origin: 'user',
    onCancel: reason => userCancellations.push(reason)
  });

  assert.equal(
    sameRoom.client.sameSuppressionOwner(sameRoom.context.readSuppressionToken, sameRoomTokenA),
    true,
    'displaced refresh B transfers suppression to in-flight refresh A'
  );
  sameRoom.emissions[0].callback({ history: [] });
  assert.deepEqual(userCancellations, ['coalesced'], 'the redundant same-room user request is cleaned up');
  assert.equal(sameRoom.emissions.length, 1, 'same-room user intent remains coalesced after A succeeds');
  assert.equal(sameRoom.coordinator.isPending(), false);
  assert.equal(sameRoom.context.readSuppressionToken, null, 'A releases its transferred owner');
  assert.equal(sameRoom.client.isMarkReadEligible({
    currentRoom: 'ABC123',
    roomCode: 'ABC123',
    visibilityState: 'visible',
    nearBottom: true,
    roomGeneration: sameRoom.context.currentRoomGeneration,
    suppressionToken: sameRoom.context.readSuppressionToken
  }), true, 'a later ordinary read is eligible');

  const unrelatedOwner = createQueuedRefreshRuntime();
  unrelatedOwner.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    unrelatedOwner.socket
  );
  unrelatedOwner.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    unrelatedOwner.socket
  );
  const otherToken = Object.freeze({ roomCode: 'XYZ789', roomGeneration: 3 });
  unrelatedOwner.context.readSuppressionToken = otherToken;
  unrelatedOwner.coordinator.request('ABC123', { origin: 'user' });
  assert.equal(
    unrelatedOwner.context.readSuppressionToken,
    otherToken,
    'cancelling refresh B cannot release an unrelated current owner'
  );

  const newerOwner = createQueuedRefreshRuntime();
  newerOwner.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    newerOwner.socket
  );
  newerOwner.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    newerOwner.socket
  );
  const newerToken = Object.freeze({ refreshId: 'newer', roomCode: 'ABC123', roomGeneration: 7 });
  newerOwner.context.readSuppressionToken = newerToken;
  newerOwner.coordinator.request('ABC123', { origin: 'user' });
  assert.equal(
    newerOwner.context.readSuppressionToken,
    newerToken,
    'cancelling refresh B cannot replace a newer same-room owner'
  );

  const mismatchedBlock = createQueuedRefreshRuntime();
  const oldBlockToken = Object.freeze({
    roomCode: 'ABC123', roomGeneration: 7, blockVersion: 4
  });
  mismatchedBlock.context.readSuppressionToken = oldBlockToken;
  mismatchedBlock.coordinator.request('ABC123', {
    forceRefresh: true,
    suppressAutoRead: true,
    suppressionToken: oldBlockToken
  });
  mismatchedBlock.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    mismatchedBlock.socket
  );
  mismatchedBlock.coordinator.request('ABC123', { origin: 'user' });
  assert.equal(
    mismatchedBlock.context.readSuppressionToken,
    null,
    'refresh B cannot transfer suppression to an in-flight refresh from another block version'
  );

  const differentRoom = createQueuedRefreshRuntime();
  differentRoom.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    differentRoom.socket
  );
  const differentRoomTokenA = differentRoom.context.readSuppressionToken;
  differentRoom.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    differentRoom.socket
  );
  differentRoom.coordinator.request('XYZ789', { origin: 'user' });
  assert.equal(
    differentRoom.client.sameSuppressionOwner(
      differentRoom.context.readSuppressionToken,
      differentRoomTokenA
    ),
    true,
    'a different-room user superseder still leaves A scroll-protected'
  );
  differentRoom.emissions[0].callback({ history: [] });
  assert.equal(differentRoom.context.readSuppressionToken, null);
  assert.equal(differentRoom.emissions[1].target, 'XYZ789');
  differentRoom.emissions[1].callback({ history: [] });
  differentRoom.coordinator.request('ABC123', { origin: 'user' });
  differentRoom.emissions[2].callback({ history: [] });
  assert.equal(differentRoom.context.currentServerCode, 'ABC123');
  assert.equal(differentRoom.client.isMarkReadEligible({
    currentRoom: 'ABC123',
    roomCode: 'ABC123',
    visibilityState: 'visible',
    nearBottom: true,
    roomGeneration: differentRoom.context.currentRoomGeneration,
    suppressionToken: differentRoom.context.readSuppressionToken
  }), true, 'returning after a different-room superseder does not revive B suppression');
});

function createRefreshHistoryRuntime() {
  const source = fs.readFileSync(chatPath, 'utf8');
  const client = loadHelpers();
  const frames = [];
  const observedEligibility = [];
  const emissions = [];
  const elements = new Map();
  const socket = {};
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        style: {},
        classList: { add() {}, remove() {} },
        appendChild() {},
        textContent: '',
        disabled: false
      });
    }
    return elements.get(id);
  };
  let nextGeneration = 7;
  let coordinator;
  let context;
  const scheduleFrame = callback => frames.push(callback);
  context = vm.createContext({
    ChatClientHelpers: client,
    socket,
    currentServerCode: 'ABC123',
    acceptedBlockVersion: 5,
    currentRoomGeneration: 7,
    readSuppressionToken: null,
    serversCache: { ABC123: { name: 'Room', owner: 'owner' } },
    myRole: 'user',
    myRoomRole: 'user',
    myJoinedServers: ['ABC123'],
    myUsername: 'alice',
    compositionContextCoordinator: { activate() {} },
    featureGenerations: { begin() { return { generation: ++nextGeneration }; } },
    showAppAlert() {},
    invalidateRoomScopedFeatureCallbacks() {},
    closeModeratorCenter() {}, closeModerationPrompt() {}, closeReportPrompt() {},
    closeRoomInfo() {}, closePins() {}, closeRoleManager() {},
    acceptRoomDetailsSnapshot() {}, acceptPinSnapshot() {}, acceptRoomStateSnapshot() {},
    applyRestrictionState() {}, renderServerAccess() {}, updateModeratorCenterAccess() {},
    updatePinsButton() {}, syncHeaderOverflowActions() {},
    typingUsers: new Map(), updateTypingUI() {}, cancelAction() {},
    consumeJoinedRoomInfoIntent() {}, scheduleMaybeMarkCurrentRoomRead() {},
    scheduleAnimationFrame: scheduleFrame,
    chatWindow: { textContent: '' },
    document: {
      querySelectorAll() { return []; },
      getElementById: element,
      createElement(tagName) { return { tagName, className: '', textContent: '' }; }
    },
    requestServerSwitch(target, options) {
      return coordinator.request(target, options);
    },
    loadHistory() {
      scheduleFrame(() => scheduleFrame(() => {
        observedEligibility.push(client.isMarkReadEligible({
          currentRoom: context.currentServerCode,
          roomCode: context.currentServerCode,
          visibilityState: 'visible',
          nearBottom: true,
          roomGeneration: context.currentRoomGeneration,
          suppressionToken: context.readSuppressionToken
        }));
      }));
    }
  });
  const refreshStart = source.indexOf('function handleRoomRefreshRequired(');
  const refreshEnd = source.indexOf('\n    const authModal', refreshStart);
  vm.runInContext(
    `${clientFunctionSource(source, 'disarmReadSuppression')}\n` +
      `${source.slice(refreshStart, refreshEnd)}\n` +
      `${clientFunctionSource(source, 'handleSwitchResult')}\n` +
      'globalThis.__handleRoomRefreshRequired = handleRoomRefreshRequired;\n' +
      'globalThis.__handleSwitchResult = handleSwitchResult;',
    context,
    { filename: 'chat-refresh-history-runtime.js' }
  );
  coordinator = client.createSwitchCoordinator(
    (target, callback) => emissions.push({ target, callback }),
    (target, response, token, options) =>
      context.__handleSwitchResult(target, response, token, options)
  );
  return { client, context, coordinator, emissions, frames, observedEligibility, socket };
}

test('cancelled queued refresh keeps in-flight history scroll suppressed until A releases it', () => {
  const runtime = createRefreshHistoryRuntime();
  runtime.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    runtime.socket
  );
  runtime.context.__handleRoomRefreshRequired(
    { serverCode: 'ABC123', blockVersion: 5 },
    runtime.socket
  );
  runtime.coordinator.request('ABC123', { origin: 'user' });

  runtime.emissions[0].callback({
    serverCode: 'ABC123',
    history: [{ _id: 'message', serverCode: 'ABC123' }],
    roomRole: 'user',
    restriction: { timedOut: false, timeoutUntil: null },
    details: null,
    notification: null,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 1, blockVersion: 5 }
  });
  runtime.frames.splice(0).forEach(callback => callback());
  runtime.frames.splice(0).forEach(callback => callback());

  assert.deepEqual(
    runtime.observedEligibility,
    [false],
    'A programmatic history scroll stays suppressed through its mark-read frame'
  );
  assert.equal(runtime.context.readSuppressionToken, null, 'A releases the transferred owner after rendering');
  assert.equal(runtime.coordinator.isPending(), false);
  assert.equal(runtime.emissions.length, 1, 'the redundant same-room user switch remains coalesced');
  assert.equal(runtime.client.isMarkReadEligible({
    currentRoom: 'ABC123',
    roomCode: 'ABC123',
    visibilityState: 'visible',
    nearBottom: true,
    roomGeneration: runtime.context.currentRoomGeneration,
    suppressionToken: runtime.context.readSuppressionToken
  }), true, 'normal mark-read becomes eligible only after A owned release');
});

test('accepted refresh response rearms suppression for its newer block context without stealing owners', () => {
  const responseForBlock = blockVersion => ({
    serverCode: 'ABC123',
    history: [{ _id: `message-${blockVersion}`, serverCode: 'ABC123' }],
    roomRole: 'user',
    restriction: { timedOut: false, timeoutUntil: null },
    details: null,
    notification: null,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 1, blockVersion }
  });
  const flushHistoryFrames = runtime => {
    runtime.frames.splice(0).forEach(callback => callback());
    runtime.frames.splice(0).forEach(callback => callback());
  };
  const queueMismatchedRefreshAndCancelB = (
    runtime,
    userOptions = { origin: 'user' }
  ) => {
    runtime.context.acceptedBlockVersion = 4;
    runtime.context.__handleRoomRefreshRequired(
      { serverCode: 'ABC123', blockVersion: 4 },
      runtime.socket
    );
    const tokenA = runtime.context.readSuppressionToken;
    runtime.context.acceptedBlockVersion = 5;
    runtime.context.__handleRoomRefreshRequired(
      { serverCode: 'ABC123', blockVersion: 5 },
      runtime.socket
    );
    runtime.coordinator.request('ABC123', userOptions);
    assert.equal(
      runtime.context.readSuppressionToken,
      null,
      'B cancellation refuses cross-block transfer to A and releases B'
    );
    return tokenA;
  };

  const accepted = createRefreshHistoryRuntime();
  const acceptedTokenA = queueMismatchedRefreshAndCancelB(accepted);
  accepted.emissions[0].callback(responseForBlock(5));

  assert.equal(
    accepted.client.sameSuppressionOwner(
      accepted.context.readSuppressionToken,
      acceptedTokenA
    ),
    true,
    'accepted A response reclaims only A ownership'
  );
  assert.equal(accepted.context.readSuppressionToken.blockVersion, 5);
  assert.equal(accepted.context.readSuppressionToken.roomGeneration, 8);
  flushHistoryFrames(accepted);
  assert.deepEqual(
    accepted.observedEligibility,
    [false],
    'A remains ineligible through its programmatic history scroll'
  );
  assert.equal(accepted.context.readSuppressionToken, null, 'A releases after its scroll mark frame');
  assert.equal(accepted.client.isMarkReadEligible({
    currentRoom: 'ABC123',
    roomCode: 'ABC123',
    visibilityState: 'visible',
    nearBottom: true,
    roomGeneration: accepted.context.currentRoomGeneration,
    suppressionToken: accepted.context.readSuppressionToken
  }), true, 'ordinary reads become eligible after accepted A releases');

  const stale = createRefreshHistoryRuntime();
  const staleUserCancellations = [];
  queueMismatchedRefreshAndCancelB(stale, {
    origin: 'user',
    onCancel: reason => staleUserCancellations.push(reason)
  });
  stale.emissions[0].callback(responseForBlock(4));
  assert.equal(stale.context.currentRoomGeneration, 7, 'stale A cannot activate a room generation');
  assert.equal(stale.context.readSuppressionToken, null, 'stale A releases its own suppression');
  assert.deepEqual(stale.observedEligibility, [], 'stale A never renders or schedules history work');
  assert.deepEqual(staleUserCancellations, [], 'stale A cannot coalesce the queued user switch');
  assert.equal(stale.emissions.length, 2, 'the queued user switch requests fresh block-v5 history');
  assert.equal(stale.coordinator.isPending(), true);
  stale.emissions[1].callback(responseForBlock(5));
  assert.equal(stale.coordinator.isPending(), false);

  const unrelated = createRefreshHistoryRuntime();
  queueMismatchedRefreshAndCancelB(unrelated);
  const newerUnrelatedOwner = Object.freeze({
    refreshId: 'newer-unrelated',
    roomCode: 'ABC123',
    roomGeneration: 7,
    blockVersion: 5
  });
  unrelated.context.readSuppressionToken = newerUnrelatedOwner;
  unrelated.emissions[0].callback(responseForBlock(5));
  assert.equal(
    unrelated.client.sameSuppressionOwner(
      unrelated.context.readSuppressionToken,
      newerUnrelatedOwner
    ),
    true,
    'accepted A cannot replace a newer unrelated owner'
  );
  flushHistoryFrames(unrelated);
  assert.deepEqual(unrelated.observedEligibility, [false]);
  assert.equal(
    unrelated.client.sameSuppressionOwner(
      unrelated.context.readSuppressionToken,
      newerUnrelatedOwner
    ),
    true,
    'A completion cannot release the unrelated owner'
  );
});

test('replaced socket chat listener ignores old and wrong-room payloads before effects', () => {
  const oldSocket = createRuntimeSocket();
  const effects = { dom: 0, typing: 0, read: 0, sound: 0 };
  const runtime = createSetupSocketRuntime({
    socket: oldSocket,
    appendMessage() { effects.dom += 1; },
    updateTypingUI() { effects.typing += 1; },
    scheduleMaybeMarkCurrentRoomRead() { effects.read += 1; },
    playSound() { effects.sound += 1; }
  });
  runtime.setupSocket(oldSocket);

  const replacementSocket = createRuntimeSocket();
  runtime.context.socket = replacementSocket;
  oldSocket.trigger('chat_message', {
    _id: 'old-socket', serverCode: 'ABC123', username: 'bob', displayName: 'Bob',
    text: 'old socket payload', blocked: false
  });
  assert.deepEqual(effects, { dom: 0, typing: 0, read: 0, sound: 0 });

  runtime.setupSocket(replacementSocket);
  replacementSocket.trigger('chat_message', {
    _id: 'wrong-room', serverCode: 'XYZ789', username: 'bob', displayName: 'Bob',
    text: 'wrong room payload', blocked: false
  });
  assert.deepEqual(effects, { dom: 0, typing: 0, read: 0, sound: 0 });

  replacementSocket.trigger('chat_message', {
    _id: 'current', serverCode: 'ABC123', username: 'bob', displayName: 'Bob',
    text: 'current room payload', blocked: false
  });
  assert.deepEqual(effects, { dom: 1, typing: 1, read: 1, sound: 1 });
});

test('overlapping refresh acknowledgements keep newest suppression aligned through both scroll frames', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const client = loadHelpers();
  const frames = [];
  const observedEligibility = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        style: {},
        classList: { add() {}, remove() {} },
        appendChild() {},
        textContent: '',
        disabled: false
      });
    }
    return elements.get(id);
  };
  let nextGeneration = 7;
  let runtimeContext;
  const scheduleFrame = callback => frames.push(callback);
  const context = vm.createContext({
    ChatClientHelpers: client,
    currentServerCode: 'ABC123',
    acceptedBlockVersion: 5,
    currentRoomGeneration: 7,
    readSuppressionToken: null,
    serversCache: { ABC123: { name: 'Room', owner: 'owner' } },
    myRole: 'user',
    myRoomRole: 'user',
    myJoinedServers: ['ABC123'],
    myUsername: 'alice',
    compositionContextCoordinator: { activate() {} },
    featureGenerations: { begin() { return { generation: ++nextGeneration }; } },
    showAppAlert() {},
    invalidateRoomScopedFeatureCallbacks() {},
    closeModeratorCenter() {}, closeModerationPrompt() {}, closeReportPrompt() {},
    closeRoomInfo() {}, closePins() {}, closeRoleManager() {},
    acceptRoomDetailsSnapshot() {}, acceptPinSnapshot() {}, acceptRoomStateSnapshot() {},
    applyRestrictionState() {}, renderServerAccess() {}, updateModeratorCenterAccess() {},
    updatePinsButton() {}, syncHeaderOverflowActions() {},
    typingUsers: new Map(), updateTypingUI() {}, cancelAction() {},
    consumeJoinedRoomInfoIntent() {}, scheduleMaybeMarkCurrentRoomRead() {},
    scheduleAnimationFrame: scheduleFrame,
    chatWindow: { textContent: '' },
    document: {
      querySelectorAll() { return []; },
      getElementById: element,
      createElement(tagName) { return { tagName, className: '', textContent: '' }; }
    },
    loadHistory() {
      scheduleFrame(() => scheduleFrame(() => {
        observedEligibility.push(client.isMarkReadEligible({
          currentRoom: 'ABC123', roomCode: 'ABC123', visibilityState: 'visible',
          nearBottom: true,
          roomGeneration: runtimeContext.currentRoomGeneration,
          suppressionToken: runtimeContext.readSuppressionToken
        }));
      }));
    }
  });
  runtimeContext = context;
  vm.runInContext(
    `${clientFunctionSource(source, 'disarmReadSuppression')}\n` +
      `${clientFunctionSource(source, 'handleSwitchResult')}\n` +
      'globalThis.__handleSwitchResult = handleSwitchResult;',
    context,
    { filename: 'chat-switch-runtime.js' }
  );

  const callbacks = [];
  const coordinator = client.createSwitchCoordinator(
    (_target, callback) => callbacks.push(callback),
    (target, response, token, options) =>
      context.__handleSwitchResult(target, response, token, options)
  );
  const tokenA = Object.freeze({ refreshId: 1, roomCode: 'ABC123', roomGeneration: 7 });
  const tokenB = Object.freeze({ refreshId: 2, roomCode: 'ABC123', roomGeneration: 7 });
  context.readSuppressionToken = tokenA;
  coordinator.request('ABC123', {
    forceRefresh: true, suppressAutoRead: true, suppressionToken: tokenA
  });
  context.readSuppressionToken = tokenB;
  coordinator.request('ABC123', {
    forceRefresh: true, suppressAutoRead: true, suppressionToken: tokenB
  });

  const response = {
    serverCode: 'ABC123', history: [{ _id: 'message', serverCode: 'ABC123' }],
    roomRole: 'user', restriction: { timedOut: false, timeoutUntil: null },
    details: null, notification: null,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 1, blockVersion: 5 }
  };
  callbacks[0](response);
  frames.splice(0).forEach(callback => callback());
  frames.splice(0).forEach(callback => callback());
  assert.deepEqual(observedEligibility, [false], 'A scroll remains suppressed by newer owner B');
  assert.equal(context.readSuppressionToken.refreshId, 2);
  assert.equal(context.readSuppressionToken.roomGeneration, 8);

  callbacks[1](response);
  frames.splice(0).forEach(callback => callback());
  frames.splice(0).forEach(callback => callback());
  assert.deepEqual(observedEligibility, [false, false], 'B scroll remains suppressed until its mark frame');
  assert.equal(context.readSuppressionToken, null, 'newest owner B releases only after its scroll mark frame');

  const failureCallbacks = [];
  const failureCoordinator = client.createSwitchCoordinator(
    (_target, callback) => failureCallbacks.push(callback),
    (target, responseValue, token, options) =>
      context.__handleSwitchResult(target, responseValue, token, options)
  );
  const tokenC = Object.freeze({ refreshId: 3, roomCode: 'ABC123', roomGeneration: 9 });
  const tokenD = Object.freeze({ refreshId: 4, roomCode: 'ABC123', roomGeneration: 9 });
  context.readSuppressionToken = tokenC;
  failureCoordinator.request('ABC123', {
    forceRefresh: true, suppressAutoRead: true, suppressionToken: tokenC
  });
  context.readSuppressionToken = tokenD;
  failureCoordinator.request('ABC123', {
    forceRefresh: true, suppressAutoRead: true, suppressionToken: tokenD
  });
  failureCallbacks[0]({ error: 'older refresh failed' });
  assert.equal(context.readSuppressionToken, tokenD, 'older failed owner C cannot clear newer owner D');
});

test('stale metadata and pin events cannot settle pending controls but authoritative equal or newer events can', () => {
  const socket = createRuntimeSocket();
  const client = loadHelpers();
  const operationReceipts = client.createOperationReceiptCoordinator();
  const roomInfoSave = { disabled: true };
  const roomDetailsByCode = new Map([['ABC123', {
    serverCode: 'ABC123', description: 'desired', rules: 'rules', metadataVersion: 5, canEdit: true
  }]]);
  const pinsByRoom = new Map([['ABC123', {
    serverCode: 'ABC123', pinCount: 1, pinVersion: 5, blockVersion: 7,
    pinsLoaded: false, pins: []
  }]]);
  const metadataIdentity = 'metadata:ABC123:desired:rules';
  const pinIdentity = 'pin:ABC123:message:true';
  const metadataToken = operationReceipts.begin('metadata', metadataIdentity);
  const pinToken = operationReceipts.begin('pin', pinIdentity);
  const pinControl = { disabled: true, isConnected: true };
  const runtime = createSetupSocketRuntime({
    ChatClientHelpers: client,
    socket,
    operationReceipts,
    roomInfoSave,
    roomInfoEditing: true,
    roomDetailsByCode,
    pinsByRoom,
    acceptedBlockVersion: 7,
    pendingMetadataOperation: {
      receiptToken: metadataToken,
      identity: metadataIdentity,
      payload: { serverCode: 'ABC123', description: 'desired', rules: 'rules' }
    },
    pendingPinOperation: {
      receiptToken: pinToken,
      identity: pinIdentity,
      payload: { serverCode: 'ABC123', messageId: 'message', pinned: true },
      control: pinControl
    },
    renderRoomInfo() {}, updatePinsButton() {}, updateMessagePinControlState() {},
    pinsDialogController: { isOpen: () => false },
    featureGenerations: { invalidate() {} },
    openPins() {},
    document: { getElementById() { return {}; } }
  }, [
    'acceptRoomDetailsSnapshot', 'acceptPinSnapshot',
    'settleMetadataControlFromEvent', 'settlePinControlFromEvent'
  ]);
  runtime.setupSocket(socket);

  socket.trigger('room_details_updated', {
    serverCode: 'ABC123', description: 'desired', rules: 'rules', metadataVersion: 4
  });
  socket.trigger('message_pin_updated', {
    messageId: 'message', pinned: true,
    pin: { serverCode: 'ABC123', pinCount: 1, pinVersion: 4, blockVersion: 7 }
  });
  assert.equal(roomInfoSave.disabled, true, 'stale metadata does not release Save');
  assert.equal(pinControl.disabled, true, 'stale pin does not release Pin control');

  socket.trigger('room_details_updated', {
    serverCode: 'ABC123', description: 'desired', rules: 'rules', metadataVersion: 5
  });
  socket.trigger('message_pin_updated', {
    messageId: 'message', pinned: true,
    pin: { serverCode: 'ABC123', pinCount: 1, pinVersion: 5, blockVersion: 7 }
  });
  assert.equal(roomInfoSave.disabled, false, 'equal current metadata is authoritative and settles');
  assert.equal(pinControl.disabled, false, 'equal current pin is authoritative and settles');

  const newerMetadataIdentity = 'metadata:ABC123:newer:new-rules';
  const newerPinIdentity = 'pin:ABC123:message:false';
  runtime.context.pendingMetadataOperation = {
    receiptToken: operationReceipts.begin('metadata', newerMetadataIdentity),
    identity: newerMetadataIdentity,
    payload: { serverCode: 'ABC123', description: 'newer', rules: 'new-rules' }
  };
  runtime.context.pendingPinOperation = {
    receiptToken: operationReceipts.begin('pin', newerPinIdentity),
    identity: newerPinIdentity,
    payload: { serverCode: 'ABC123', messageId: 'message', pinned: false },
    control: pinControl
  };
  roomInfoSave.disabled = true;
  pinControl.disabled = true;
  socket.trigger('room_details_updated', {
    serverCode: 'ABC123', description: 'newer', rules: 'new-rules', metadataVersion: 6
  });
  socket.trigger('message_pin_updated', {
    messageId: 'message', pinned: false,
    pin: { serverCode: 'ABC123', pinCount: 0, pinVersion: 6, blockVersion: 7 }
  });
  assert.equal(roomInfoSave.disabled, false, 'newer accepted metadata settles');
  assert.equal(pinControl.disabled, false, 'newer accepted pin settles');
});
