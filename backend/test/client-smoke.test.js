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

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function loadNamedFunction(source, startMarker, endMarker, name, sandbox = {}) {
  const block = sourceBetween(source, startMarker, endMarker);
  const context = vm.createContext(sandbox);
  vm.runInContext(`${block}\nthis.__subject = ${name};`, context, {
    filename: `chat-${name}-adapter.js`
  });
  return { block, context, subject: context.__subject };
}

function createStubElement() {
  return {
    children: [],
    style: {},
    classList: { values: [], add(value) { this.values.push(value); } },
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); return child; }
  };
}

test('new users receive the deployed Render backend URL by default', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(
    source,
    /id="url-input"[^>]*value="https:\/\/chat-backend-iekp\.onrender\.com"/
  );
});

test('browser title and AutoMod message-rate controls are exact and aligned', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /<title>Chat v1\.3\.2<\/title>/);
  assert.match(source, /\.automod-limits-grid\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(170px,\s*1fr\)\)[^}]*gap:\s*10px[^}]*align-items:\s*end/s);
  const panelStart = source.indexOf('<section id="moderator-panel-automod"');
  const panelEnd = source.indexOf('</section>', panelStart);
  assert.notEqual(panelStart, -1);
  assert.ok(panelEnd > panelStart);
  const panel = source.slice(panelStart, panelEnd);
  assert.match(panel, /<div class="automod-limits-grid">/);
  assert.doesNotMatch(panel, /minmax\(130px,\s*1fr\)/);
  const controls = [
    ['automod-mention-limit', 'Mention limit (1–20)', '1', '20'],
    ['automod-repeat-limit', 'Repeat limit (2–10)', '2', '10'],
    ['automod-repeat-window', 'Window seconds (5–300)', '5', '300'],
    ['automod-message-limit', 'Message limit (1–20)', '1', '20'],
    ['automod-message-window', 'Window seconds (1–60)', '1', '60']
  ];
  let previousIndex = -1;
  for (const [id, label, min, max] of controls) {
    const labelIndex = panel.indexOf(`<label for="${id}">${label}</label>`);
    const inputPattern = new RegExp(`id="${id}"[^>]*min="${min}"[^>]*max="${max}"`);
    assert.ok(labelIndex > previousIndex, `${id} label is present in order`);
    assert.match(panel.slice(labelIndex), inputPattern);
    previousIndex = labelIndex;
  }

  const modalPadding = Number(source.match(/\.modal\s*\{[^}]*padding:\s*([0-9.]+)rem/s)[1]) * 16;
  const boxPadding = Number(source.match(/\.modal-box\s*\{[^}]*padding:\s*([0-9.]+)rem/s)[1]) * 16;
  const boxMax = Number(source.match(/id="moderator-center-modal"[\s\S]*?class="modal-box" style="max-width:\s*([0-9.]+)px/)[1]);
  const gridRule = source.match(/\.automod-limits-grid\s*\{([^}]*)\}/s)[1];
  const minimumTrack = Number(gridRule.match(/minmax\(([0-9.]+)px,\s*1fr\)/)[1]);
  const gap = Number(gridRule.match(/gap:\s*([0-9.]+)px/)[1]);
  const columnCount = viewportWidth => {
    const boxWidth = Math.min(viewportWidth - (2 * modalPadding), boxMax);
    const contentWidth = boxWidth - (2 * boxPadding);
    return Math.max(1, Math.floor((contentWidth + gap) / (minimumTrack + gap)));
  };
  assert.deepEqual(
    [760, 480, 320].map(viewportWidth => columnCount(viewportWidth)),
    [3, 2, 1],
    'AutoMod controls deterministically reflow to 3/2/1 columns at target widths'
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

test('history rendering skips layout measurements and performs one final scroll', () => {
  const helpers = loadHelpers();
  let measurements = 0;
  const scroller = {
    get scrollHeight() { measurements += 1; return 1_000; },
    get scrollTop() { measurements += 1; return 600; },
    get clientHeight() { measurements += 1; return 320; }
  };
  const rows = Array.from({ length: 100 }, (_, index) => ({ _id: String(index), username: 'alice' }));
  const appended = [];
  const scrolls = [];

  const count = helpers.renderHistoryMessages(rows, {
    append(message, isMe, options) {
      appended.push({ message, isMe, options: { ...options } });
      helpers.messageRenderPolicyForElement(scroller, options);
    },
    isMine: message => message.username === 'alice',
    requestScroll: behavior => scrolls.push(behavior)
  });

  assert.equal(count, 100);
  assert.equal(appended.length, 100);
  assert.equal(appended.every(item => item.isMe && item.options.history === true), true);
  assert.equal(measurements, 0);
  assert.deepEqual(scrolls, ['auto']);

  const livePolicy = helpers.messageRenderPolicyForElement(scroller, { history: false });
  assert.equal(measurements, 3);
  assert.deepEqual({ ...livePolicy }, { animate: true, shouldScroll: true, behavior: 'smooth' });
});

test('production loadHistory adapter forwards one hundred rows with history options and one final scroll', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const helpers = loadHelpers();
  const appended = [];
  const scrolls = [];
  const rows = Array.from({ length: 100 }, (_, index) => ({
    _id: String(index),
    username: index % 2 === 0 ? 'alice' : 'bob'
  }));
  const { subject: loadHistory } = loadNamedFunction(
    source,
    'function loadHistory(msgs)',
    '\n    function appendMessage',
    'loadHistory',
    {
      ChatClientHelpers: helpers,
      appendMessage(message, isMe, options) {
        appended.push({ message, isMe, options: { ...options } });
      },
      myUsername: 'alice',
      chatScrollCoordinator: { request: behavior => scrolls.push(behavior) }
    }
  );

  assert.equal(loadHistory(rows), undefined);
  assert.equal(appended.length, 100);
  assert.deepEqual(
    appended.map(item => [item.message._id, item.isMe, item.options.history]),
    rows.map((row, index) => [row._id, index % 2 === 0, true])
  );
  assert.deepEqual(scrolls, ['auto']);
});

test('complete production appendMessage uses the exact history policy without direct near-scroll reads', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  let measurements = 0;
  const appended = [];
  const policyCalls = [];
  const chatWindow = {
    get scrollHeight() { measurements += 1; return 1_000; },
    get scrollTop() { measurements += 1; return 600; },
    get clientHeight() { measurements += 1; return 320; },
    appendChild(element) { appended.push(element); }
  };
  const ChatClientHelpers = {
    messageRenderPolicyForElement(element, options) {
      policyCalls.push({ element, options: { ...options } });
      return { animate: false, shouldScroll: false, behavior: 'auto' };
    },
    appendTextElement(documentObject, parent, tagName, className, text) {
      const element = documentObject.createElement(tagName);
      element.className = className;
      element.textContent = text;
      parent.appendChild(element);
      return element;
    }
  };
  const { block, subject: appendMessage } = loadNamedFunction(
    source,
    'function appendMessage(data, isMe, { history = false } = {})',
    '\n    function appendSystemMessage',
    'appendMessage',
    {
      ChatClientHelpers,
      chatWindow,
      chatScrollCoordinator: { request() { throw new Error('history row must not request a live scroll'); } },
      document: { createElement: () => createStubElement() },
      myRole: 'user',
      currentServerCode: 'global',
      myRoomRole: 'user'
    }
  );

  assert.doesNotMatch(block, /isNearScrollEnd/);
  assert.equal((block.match(/messageRenderPolicyForElement/g) || []).length, 1);
  assert.match(
    block,
    /const renderPolicy = ChatClientHelpers\.messageRenderPolicyForElement\(chatWindow, \{ history \}\);/
  );
  appendMessage({
    _id: 'deleted-1', username: 'alice', displayName: 'Alice', text: '', deleted: true
  }, true, { history: true });
  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].element, chatWindow);
  assert.deepEqual(policyCalls[0].options, { history: true });
  assert.equal(measurements, 0);
  assert.equal(appended.length, 1);
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

test('typing coordinator emits one start and one idle stop for one hundred inputs', () => {
  const helpers = loadHelpers();
  let nextTimer = 0;
  const timers = new Map();
  const emitted = [];
  const socket = {
    connected: true,
    emit(event, payload) { emitted.push({ event, payload: { ...payload } }); }
  };
  const context = { roomCode: 'ABC123', clientContextId: 7 };
  const typing = helpers.createTypingCoordinator({
    schedule(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
    getSocket: () => socket,
    getContext: () => ({ ...context }),
    delay: 1_500
  });

  for (let index = 0; index < 100; index += 1) assert.equal(typing.input(), true);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    event: 'typing',
    payload: { serverCode: 'ABC123', clientContextId: 7, isTyping: true }
  });
  assert.equal(timers.size, 1);
  const idle = [...timers.values()][0];
  assert.equal(idle.delay, 1_500);
  idle.callback();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].payload.isTyping, false);
  assert.equal(typing.current().active, false);
  typing.input();
  assert.equal(emitted.filter(item => item.payload.isTyping).length, 2);
});

test('typing submit is ordered once and stale socket timers cannot emit', () => {
  const helpers = loadHelpers();
  const callbacks = [];
  const canceled = [];
  const events = [];
  let context = { roomCode: 'ABC123', clientContextId: 2 };
  const oldSocket = { connected: true, emit(event, payload) { events.push({ source: 'old', event, payload }); } };
  const newSocket = { connected: true, emit(event, payload) { events.push({ source: 'new', event, payload }); } };
  let socket = oldSocket;
  const typing = helpers.createTypingCoordinator({
    schedule(callback) { callbacks.push(callback); return callbacks.length; },
    cancel(id) { canceled.push(id); },
    getSocket: () => socket,
    getContext: () => ({ ...context })
  });

  typing.input();
  oldSocket.emit('chat_message', { text: 'sent' });
  assert.equal(typing.submit(), true);
  assert.deepEqual(events.map(item => `${item.event}:${item.payload.isTyping}`), [
    'typing:true', 'chat_message:undefined', 'typing:false'
  ]);
  assert.equal(typing.submit(), false, 'no duplicate false without an active start');

  typing.input();
  const staleSameEpisodeTimer = callbacks.at(-1);
  typing.input();
  const currentSameEpisodeTimer = callbacks.at(-1);
  staleSameEpisodeTimer();
  assert.equal(typing.current().active, true);
  assert.equal(typing.current().timerPending, true);
  assert.equal(events.filter(item => item.payload.isTyping === false).length, 1);

  const staleRoomTimer = currentSameEpisodeTimer;
  typing.clear();
  socket = newSocket;
  context = { roomCode: 'BBB222', clientContextId: 3 };
  typing.input();
  staleRoomTimer();
  assert.equal(typing.current().active, true);
  assert.equal(typing.current().timerPending, true);
  assert.equal(events.filter(item => item.source === 'new' && item.payload.isTyping === false).length, 0);
  assert.equal(events.filter(item => item.source === 'old' && item.payload.isTyping === false).length, 1);
  assert.ok(canceled.length >= 2);

  typing.clear();
  const eventCount = events.length;
  newSocket.connected = false;
  assert.equal(typing.input(), false);
  newSocket.connected = true;
  context = { roomCode: null, clientContextId: 4 };
  assert.equal(typing.input(), false);
  assert.equal(events.length, eventCount, 'invalid socket or room fails closed');
});

test('typing identity transitions independently bind socket, room, and context changes', () => {
  const helpers = loadHelpers();
  const scenarios = [
    {
      name: 'socket only',
      mutate(state) { state.socket = state.replacementSocket; },
      expected: [
        ['old', 'ABC123', 7, true],
        ['new', 'ABC123', 7, true]
      ]
    },
    {
      name: 'room only',
      mutate(state) { state.context = { roomCode: 'BBB222', clientContextId: 7 }; },
      expected: [
        ['old', 'ABC123', 7, true],
        ['old', 'BBB222', 7, true]
      ]
    },
    {
      name: 'context only',
      mutate(state) { state.context = { roomCode: 'ABC123', clientContextId: 8 }; },
      expected: [
        ['old', 'ABC123', 7, true],
        ['old', 'ABC123', 8, true]
      ]
    }
  ];

  for (const scenario of scenarios) {
    const emitted = [];
    const callbacks = [];
    const socketFor = source => ({
      connected: true,
      emit(event, payload) { emitted.push([source, payload.serverCode, payload.clientContextId, payload.isTyping]); }
    });
    const state = {
      socket: socketFor('old'),
      replacementSocket: socketFor('new'),
      context: { roomCode: 'ABC123', clientContextId: 7 }
    };
    const typing = helpers.createTypingCoordinator({
      schedule(callback) { callbacks.push(callback); return callbacks.length; },
      cancel() {},
      getSocket: () => state.socket,
      getContext: () => ({ ...state.context })
    });

    assert.equal(typing.input(), true, `${scenario.name}: initial episode starts`);
    const staleCallback = callbacks[0];
    scenario.mutate(state);
    assert.equal(typing.input(), true, `${scenario.name}: replacement episode starts`);
    staleCallback();
    assert.deepEqual(emitted, scenario.expected, `${scenario.name}: identity axis is independently enforced`);
    assert.equal(typing.current().active, true, `${scenario.name}: stale timer cannot stop replacement`);
  }
});

test('typing input rejects every invalid client context identifier', () => {
  const helpers = loadHelpers();
  const invalidIds = [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '7', 2 ** 53];

  for (const clientContextId of invalidIds) {
    const emitted = [];
    const typing = helpers.createTypingCoordinator({
      schedule() { throw new Error('invalid context must not schedule a timer'); },
      getSocket: () => ({ connected: true, emit: (...args) => emitted.push(args) }),
      getContext: () => ({ roomCode: 'ABC123', clientContextId })
    });
    assert.equal(typing.input(), false, `rejects clientContextId ${String(clientContextId)}`);
    assert.deepEqual(emitted, []);
    assert.deepEqual({ ...typing.current() }, { active: false, timerPending: false });
  }
});

test('production compose handler emits edits and chats before stopping typing', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const snippet = sourceBetween(
    source,
    "document.getElementById('compose').addEventListener('submit'",
    "\n    msgInput.addEventListener('input'"
  );
  const events = [];
  let submitHandler;
  const msgInput = { value: 'hello', focus: () => events.push('focus') };
  const context = vm.createContext({
    document: {
      getElementById(id) {
        assert.equal(id, 'compose');
        return { addEventListener(event, handler) { assert.equal(event, 'submit'); submitHandler = handler; } };
      }
    },
    compositionDisabled: false,
    currentServerCode: 'ABC123',
    msgInput,
    pendingAttachmentBase64: null,
    socket: {
      connected: true,
      emit(event) { events.push(`emit:${event}`); }
    },
    editingMsgId: 'edit-1',
    compositionContextCoordinator: {
      payload(value) { return { ...value, serverCode: 'ABC123', clientContextId: 9 }; }
    },
    replyingToData: null,
    typingCoordinator: { submit() { events.push('typing:stop'); } },
    cancelAction() { events.push('cancel'); }
  });
  vm.runInContext(snippet, context, { filename: 'chat-compose-adapter.js' });
  const event = { preventDefault: () => events.push('prevent') };

  submitHandler(event);
  assert.deepEqual(events, ['prevent', 'emit:edit_message', 'typing:stop', 'cancel', 'focus']);

  events.length = 0;
  context.editingMsgId = null;
  msgInput.value = 'new message';
  submitHandler(event);
  assert.deepEqual(events, ['prevent', 'emit:chat_message', 'typing:stop', 'cancel', 'focus']);
});

test('production logout clears typing only after confirmation', async () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const events = [];
  let confirmed = false;
  const { subject: logoutApp } = loadNamedFunction(
    source,
    'async function logoutApp()',
    '\n\n    // --- AUTHENTICATION ---',
    'logoutApp',
    {
      async showAppConfirm() { events.push('confirm'); return confirmed; },
      typingCoordinator: { clear() { events.push('typing:clear'); } },
      localStorage: { removeItem() { events.push('storage:remove'); } },
      location: { reload() { events.push('reload'); } }
    }
  );

  await logoutApp();
  assert.deepEqual(events, ['confirm'], 'canceled logout preserves the typing episode');

  events.length = 0;
  confirmed = true;
  await logoutApp();
  assert.deepEqual(events, ['confirm', 'typing:clear', 'storage:remove', 'reload']);
});

test('production room-switch request clears only after the same-room fast return', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const events = [];
  const roomSwitchCoordinator = {
    pending: false,
    isPending() { return this.pending; },
    request(code) { events.push(`request:${code}`); }
  };
  const { context, subject: requestServerSwitch } = loadNamedFunction(
    source,
    'function requestServerSwitch(code)',
    '\n\n    function switchServer',
    'requestServerSwitch',
    {
      currentServerCode: 'ABC123',
      chatWindow: { innerHTML: '<div>history</div>' },
      roomSwitchCoordinator,
      typingCoordinator: { clear() { events.push('typing:clear'); } }
    }
  );

  requestServerSwitch('ABC123');
  assert.deepEqual(events, [], 'same-room fast return does not clear active typing');

  requestServerSwitch('BBB222');
  assert.deepEqual(events, ['typing:clear', 'request:BBB222']);

  events.length = 0;
  context.chatWindow.innerHTML = '';
  requestServerSwitch('ABC123');
  assert.deepEqual(events, ['typing:clear', 'request:ABC123']);
});

test('production authentication clears typing only when the socket is actually replaced', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const snippet = sourceBetween(
    source,
    "authBtn.addEventListener('click'",
    '\n\n    function showError'
  );

  const runAttempt = replaceSocket => {
    const events = [];
    let clickHandler;
    const initialSocket = {
      connected: true,
      emit(event) { events.push(`emit:${event}`); }
    };
    const authBtn = {
      disabled: false,
      addEventListener(event, handler) { assert.equal(event, 'click'); clickHandler = handler; }
    };
    const fields = {
      'url-input': { value: 'https://chat.example.test' },
      'username-input': { value: 'alice' },
      'password-input': { value: 'password' },
      'displayname-input': { value: 'Alice' }
    };
    const context = vm.createContext({
      authBtn,
      document: { getElementById: id => fields[id] },
      isLoginMode: true,
      showError() { events.push('show:error'); },
      ChatClientHelpers: {
        normalizeBackendUrl: value => value,
        replaceSocket(socket, socketUrl, url, ioFactory) {
          events.push('replace');
          return replaceSocket(socket, socketUrl, url, ioFactory);
        }
      },
      localStorage: { setItem() {} },
      authError: { style: {}, textContent: '' },
      socket: initialSocket,
      socketUrl: 'https://chat.example.test',
      io: () => {},
      typingCoordinator: { clear() { events.push('typing:clear'); } },
      compositionContextCoordinator: { invalidate() { events.push('composition:invalidate'); } },
      closeModerationPrompt() { events.push('moderation:close'); },
      closeReportPrompt() { events.push('report:close'); },
      invalidatePrivilegedAccess() { events.push('privilege:invalidate'); },
      setupSocket() { events.push('socket:setup'); },
      pendingAuthSocket: null,
      pendingAuthConnectHandler: null
    });
    vm.runInContext(snippet, context, { filename: 'chat-auth-adapter.js' });
    clickHandler();
    return { events, initialSocket };
  };

  const unchanged = runAttempt((socket, socketUrl) => ({ socket, socketUrl }));
  assert.deepEqual(unchanged.events, ['replace', 'emit:login']);

  const replacementSocket = { connected: true, emit() {} };
  const replaced = runAttempt(() => ({
    socket: replacementSocket,
    socketUrl: 'https://replacement.example.test'
  }));
  assert.deepEqual(replaced.events.slice(0, 7), [
    'replace',
    'typing:clear',
    'composition:invalidate',
    'moderation:close',
    'report:close',
    'privilege:invalidate',
    'socket:setup'
  ]);
});

test('production socket handlers clear typing before forced logout and direct role refreshes', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  const handlers = new Map();
  const events = [];
  const activeSocket = { on(event, handler) { handlers.set(event, handler); } };
  const { subject: setupSocket } = loadNamedFunction(
    source,
    'function setupSocket(activeSocket)',
    '\n\n    // --- CONTEXT MENU MANAGER',
    'setupSocket',
    {
      ChatClientHelpers: { bindConnectErrorRecovery() {} },
      socket: activeSocket,
      authModal: { classList: { contains: () => false } },
      authBtn: {},
      showError() {},
      myUsername: 'alice',
      myRole: 'admin',
      myRoomRole: 'mod',
      currentServerCode: 'ABC123',
      typingCoordinator: { clear() { events.push('typing:clear'); } },
      roomSwitchCoordinator: { request(code) { events.push(`direct-request:${code}`); } },
      requestServerSwitch(code) { events.push(`wrapped-request:${code}`); },
      invalidatePrivilegedAccess() { events.push('privilege:invalidate'); },
      renderServerAccess() { events.push('server-access:render'); },
      showAppAlert() { events.push('alert:role'); },
      updateModeratorCenterAccess() { events.push('moderator-access:update'); },
      localStorage: { removeItem() { events.push('storage:remove'); } },
      alert() { events.push('alert:force'); },
      location: { reload() { events.push('reload'); } }
    }
  );
  setupSocket(activeSocket);

  handlers.get('global_role_updated')({ username: 'alice', role: 'user' });
  assert.deepEqual(events.slice(-2), ['typing:clear', 'direct-request:ABC123']);
  assert.equal(events.includes('wrapped-request:ABC123'), false);

  events.length = 0;
  handlers.get('room_role_updated')({ username: 'alice', targetServer: 'ABC123' });
  assert.deepEqual(events.slice(-2), ['typing:clear', 'direct-request:ABC123']);
  assert.equal(events.includes('wrapped-request:ABC123'), false);

  events.length = 0;
  handlers.get('force_logout')('remote logout');
  assert.deepEqual(events, ['typing:clear', 'storage:remove', 'alert:force', 'reload']);
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
  for (const event of ['chat_message', 'edit_message', 'toggle_reaction', 'delete_message']) {
    assert.match(source, new RegExp(`compositionContextCoordinator\\.payload\\([\\s\\S]{0,240}socket\\.emit\\(['"]${event}['"]`), event);
  }
});

test('production typing wiring uses the coordinator at every lifecycle boundary', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(source, /const typingCoordinator = ChatClientHelpers\.createTypingCoordinator\(/);
  assert.match(source, /msgInput\.addEventListener\(['"]input['"],\s*\(\)\s*=>\s*\{[\s\S]{0,300}typingCoordinator\.input\(\)/);
  assert.match(source, /document\.getElementById\(['"]compose['"]\)[\s\S]{0,1800}socket\.emit\(['"]chat_message['"][\s\S]{0,500}typingCoordinator\.submit\(\)/);
  for (const boundary of ['enterLobby', 'requestServerSwitch', 'logoutApp']) {
    const start = source.indexOf(`function ${boundary}`);
    const end = source.indexOf('\n    function ', start + 1);
    assert.notEqual(start, -1, boundary);
    assert.match(source.slice(start, end === -1 ? source.length : end), /typingCoordinator\.clear\(\)/, boundary);
  }
  assert.match(source, /const previousSocket = socket;[\s\S]{0,300}replaceSocket[\s\S]{0,300}if \(socket !== previousSocket\)\s*\{[\s\S]{0,120}typingCoordinator\.clear\(\)/);
  assert.match(source, /activeSocket\.on\(['"]force_logout['"][\s\S]{0,200}typingCoordinator\.clear\(\)/);
  assert.match(source, /activeSocket\.on\(['"]global_role_updated['"][\s\S]{0,700}typingCoordinator\.clear\(\)[\s\S]{0,120}roomSwitchCoordinator\.request\(currentServerCode\)/);
  assert.match(source, /activeSocket\.on\(['"]room_role_updated['"][\s\S]{0,500}typingCoordinator\.clear\(\)[\s\S]{0,120}roomSwitchCoordinator\.request\(currentServerCode\)/);
  assert.doesNotMatch(source, /let typingTimeout|clearTimeout\(typingTimeout\)/);
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
