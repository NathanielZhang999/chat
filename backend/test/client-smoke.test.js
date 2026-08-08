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
  return context.ChatClientHelpers;
}

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

test('production connect-error binding re-enables authentication while the active modal is open', () => {
  const helpers = loadHelpers();
  assert.equal(typeof helpers.bindConnectErrorRecovery, 'function');
  const handlers = {};
  const activeSocket = { on(event, handler) { handlers[event] = handler; } };
  const authButton = { disabled: true };
  const errors = [];
  helpers.bindConnectErrorRecovery({
    activeSocket,
    getCurrentSocket: () => activeSocket,
    isAuthModalActive: () => true,
    authButton,
    showError: (message, success) => errors.push({ message, success })
  });

  handlers.connect_error();
  assert.equal(authButton.disabled, false);
  assert.deepEqual(errors, [{
    message: 'Unable to connect. Check the backend URL and try again.',
    success: false
  }]);
});

test('production rejected-switch gate preserves displayed room and DOM state', () => {
  const helpers = loadHelpers();
  assert.equal(typeof helpers.evaluateSwitchResult, 'function');
  const alerts = [];
  const currentRoom = 'AAAAAA';
  const chatWindow = { textContent: 'existing history' };
  const result = helpers.evaluateSwitchResult(
    currentRoom,
    'BBBBBB',
    { error: 'Permission denied.' },
    (title, message) => alerts.push({ title, message })
  );

  assert.equal(result.accepted, false);
  assert.equal(result.currentServerCode, 'AAAAAA');
  assert.equal(result.response.error, 'Permission denied.');
  assert.equal(chatWindow.textContent, 'existing history');
  assert.deepEqual(alerts, [{ title: 'Error', message: 'Permission denied.' }]);
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
