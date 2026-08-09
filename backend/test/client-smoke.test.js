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

function loadClientFunction(name, values = {}) {
  const source = fs.readFileSync(chatPath, 'utf8');
  const plainStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = plainStart === -1 ? asyncStart :
    (asyncStart === -1 ? plainStart : Math.min(plainStart, asyncStart));
  assert.notEqual(start, -1, `missing production function ${name}`);

  for (let end = source.indexOf('}', start); end !== -1; end = source.indexOf('}', end + 1)) {
    const candidate = source.slice(start, end + 1);
    const context = vm.createContext({ ...values });
    try {
      vm.runInContext(`globalThis.__clientFunction = (${candidate});`, context, {
        filename: `${name}.js`
      });
      return { fn: context.__clientFunction, context };
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.name !== 'SyntaxError') throw error;
    }
  }
  assert.fail(`could not compile production function ${name}`);
}

function createClientElement() {
  const classes = new Set();
  return {
    children: [],
    style: {},
    hidden: false,
    disabled: false,
    textContent: '',
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); }
    },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
}

function createClientDocument() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createClientElement());
      return elements.get(id);
    },
    querySelectorAll() { return []; }
  };
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

test('message read coordinator rejects stale room and older-page acknowledgements', () => {
  const helpers = loadHelpers();
  const pending = [];
  const coordinator = helpers.createMessageReadCoordinator({
    onOlderPendingChange(value) { pending.push(value); }
  });

  coordinator.activate('ABC123', 4, 'cursor-a');
  const token = coordinator.beginOlder();
  assert.ok(token);
  assert.equal(Object.isFrozen(token), true);
  assert.equal(coordinator.beginOlder(), null, 'only one older page may be pending');
  coordinator.activate('XYZ789', 5, 'cursor-b');
  const currentToken = coordinator.beginOlder();

  assert.equal(coordinator.finishOlder(token, {
    serverCode: 'ABC123', clientContextId: 4, messages: [], nextCursor: null
  }), null);
  assert.deepEqual({ ...coordinator.current() }, {
    epoch: 2,
    roomCode: 'XYZ789',
    clientContextId: 5,
    nextCursor: 'cursor-b',
    olderPending: true
  });
  assert.equal(pending.at(-1), true, 'a stale acknowledgement cannot enable a newer request');
  assert.ok(coordinator.finishOlder(currentToken, {
    serverCode: 'XYZ789', clientContextId: 5, messages: [], nextCursor: null
  }));
  assert.deepEqual(pending, [false, true, false, true, false]);
});

test('message read coordinator replaces cursors only for accepted older pages', () => {
  const helpers = loadHelpers();
  const olderPending = [];
  const searchPending = [];
  const coordinator = helpers.createMessageReadCoordinator({
    onOlderPendingChange(value) { olderPending.push(value); },
    onSearchPendingChange(value) { searchPending.push(value); }
  });

  coordinator.activate('ABC123', 7, 'cursor-a');
  const wrongEcho = coordinator.beginOlder();
  assert.equal(coordinator.finishOlder(wrongEcho, {
    serverCode: 'XYZ789', clientContextId: 7, messages: [], nextCursor: 'wrong-cursor'
  }), null);
  assert.equal(coordinator.current().nextCursor, 'cursor-a');
  assert.equal(coordinator.current().olderPending, false, 'a current malformed ack releases its control');

  const acceptedToken = coordinator.beginOlder();
  const accepted = coordinator.finishOlder(acceptedToken, {
    serverCode: 'ABC123', clientContextId: 7,
    messages: [{ _id: '1' }], nextCursor: 'cursor-b'
  });
  assert.deepEqual(structuredClone(accepted), {
    serverCode: 'ABC123', clientContextId: 7,
    messages: [{ _id: '1' }], nextCursor: 'cursor-b'
  });
  assert.equal(coordinator.current().nextCursor, 'cursor-b');

  const terminalToken = coordinator.beginOlder();
  assert.ok(coordinator.finishOlder(terminalToken, {
    serverCode: 'ABC123', clientContextId: 7, messages: [], nextCursor: null
  }));
  assert.equal(coordinator.current().nextCursor, null);
  assert.equal(coordinator.beginOlder(), null, 'terminal pages cannot be requested again');

  coordinator.activate('ABC123', 8, 'cursor-c');
  coordinator.beginOlder();
  coordinator.invalidate();
  assert.deepEqual({ ...coordinator.current() }, {
    epoch: 3,
    roomCode: null,
    clientContextId: null,
    nextCursor: null,
    olderPending: false
  });
  assert.equal(olderPending.at(-1), false, 'lost older acknowledgement is reset');
  assert.equal(searchPending.at(-1), false, 'full invalidation resets search controls too');
});

test('latest accepted room search wins and close invalidates late results', () => {
  const helpers = loadHelpers();
  const pending = [];
  const coordinator = helpers.createMessageReadCoordinator({
    onSearchPendingChange(value) { pending.push(value); }
  });
  const response = token => ({
    serverCode: token.roomCode,
    clientContextId: token.clientContextId,
    requestId: token.requestId,
    results: []
  });

  coordinator.activate('ABC123', 7, null);
  const first = coordinator.beginSearch();
  const second = coordinator.beginSearch({ supersede: true });
  assert.ok(first);
  assert.ok(second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual({ ...second }, {
    epoch: 1, roomCode: 'ABC123', clientContextId: 7, requestId: 2
  });
  assert.equal(coordinator.finishSearch(first, response(first)), null);
  assert.equal(pending.at(-1), true, 'an older response cannot release the latest search control');
  assert.ok(coordinator.finishSearch(second, response(second)));
  assert.equal(pending.at(-1), false);

  const beforeClose = coordinator.beginSearch();
  coordinator.closeSearch();
  assert.equal(pending.at(-1), false, 'close resets a search whose acknowledgement was lost');
  const afterReopen = coordinator.beginSearch();
  assert.equal(coordinator.finishSearch(beforeClose, response(beforeClose)), null);
  assert.equal(pending.at(-1), true, 'a late closed-modal response cannot release the reopened search');

  coordinator.activate('XYZ789', 8, null);
  assert.equal(coordinator.finishSearch(afterReopen, response(afterReopen)), null);
  assert.equal(pending.at(-1), false, 'room switches reset pending search controls');

  for (const wrongEcho of [
    { serverCode: 'WRONG1' },
    { clientContextId: 999 },
    { requestId: 999 }
  ]) {
    const token = coordinator.beginSearch();
    assert.equal(
      coordinator.finishSearch(token, { ...response(token), ...wrongEcho }),
      null,
      `rejects wrong current search echo ${Object.keys(wrongEcho)[0]}`
    );
    assert.equal(pending.at(-1), false, 'a malformed current acknowledgement releases its control');
  }
});

test('room read token guards privileged modal callbacks after a switch or close', () => {
  const helpers = loadHelpers();
  const coordinator = helpers.createMessageReadCoordinator();
  coordinator.activate('ABC123', 7, null);

  const editToken = coordinator.beginDetail('ABC123', 7, 'edit-message-id');
  assert.ok(editToken);
  assert.equal(Object.isFrozen(editToken), true);
  coordinator.activate('XYZ789', 8, null);
  assert.equal(coordinator.finishDetail(editToken), false);

  const deletedToken = coordinator.beginDetail('deleted-message-id');
  assert.ok(deletedToken);
  coordinator.closeDetail();
  assert.equal(coordinator.finishDetail(deletedToken), false);

  const calls = [];
  const socket = {
    emit(event, messageId, callback) { calls.push({ event, messageId, callback }); }
  };
  const doc = createClientDocument();
  doc.createElement = () => createClientElement();
  const values = {
    socket,
    messageReadCoordinator: coordinator,
    document: doc,
    showAppAlert() { throw new Error('stale response reached alert rendering'); },
    formatExactDate() { throw new Error('stale response reached date rendering'); },
    formatMessageText() { throw new Error('stale response reached text rendering'); },
    ChatClientHelpers: helpers
  };
  const history = loadClientFunction('viewHistory', values);
  const deleted = loadClientFunction('viewDeleted', values);

  history.fn('history-message-id');
  assert.deepEqual({ event: calls[0].event, messageId: calls[0].messageId }, {
    event: 'get_edit_history', messageId: 'history-message-id'
  });
  coordinator.activate('NEXT01', 9, null);
  const unreadableResponse = new Proxy({}, {
    get() { throw new Error('stale privileged response was inspected'); }
  });
  assert.doesNotThrow(() => calls[0].callback(unreadableResponse));
  assert.equal(doc.getElementById('history-modal').classList.contains('active'), false);

  deleted.fn('deleted-message-id');
  assert.deepEqual({ event: calls[1].event, messageId: calls[1].messageId }, {
    event: 'get_deleted_message', messageId: 'deleted-message-id'
  });
  coordinator.invalidate();
  assert.doesNotThrow(() => calls[1].callback(unreadableResponse));
  assert.equal(doc.getElementById('history-list').children.length, 0);

  coordinator.activate('SAME01', 10, null);
  history.fn('same-room-old');
  doc.getElementById('history-modal').classList.add('active');
  const close = loadClientFunction('closeHistoryModal', {
    messageReadCoordinator: coordinator,
    document: doc
  });
  close.fn();
  assert.equal(doc.getElementById('history-modal').classList.contains('active'), false);
  history.fn('same-room-new');
  assert.doesNotThrow(() => calls[2].callback(unreadableResponse));
  calls[3].callback({ history: [] });
  assert.equal(doc.getElementById('history-modal').classList.contains('active'), true);
});

test('room read token access-loss handlers invalidate before navigating away', async () => {
  const leaveCalls = [];
  const leaveSocketCalls = [];
  const leaveDocument = { getElementById() { return null; } };
  const leaving = loadClientFunction('leaveServer', {
    currentServerCode: 'ABC123',
    myJoinedServers: ['global', 'ABC123'],
    myBannedRooms: new Set(),
    myRole: 'user',
    showAppConfirm: async () => true,
    socket: {
      emit(event, payload, callback) { leaveSocketCalls.push({ event, payload, callback }); }
    },
    document: leaveDocument,
    showAppAlert() {},
    invalidateMessageReads: () => leaveCalls.push('invalidate'),
    renderSearchControl: () => leaveCalls.push('search-control'),
    switchServer: code => leaveCalls.push(`switch:${code}`),
    enterLobby: () => leaveCalls.push('lobby')
  });
  await leaving.fn();
  leaveSocketCalls[0].callback({ success: true });
  assert.deepEqual(leaveCalls, ['invalidate', 'search-control', 'switch:global']);

  const deletionCalls = [];
  const deleted = loadClientFunction('handleServerDeleted', {
    currentServerCode: 'ABC123',
    myJoinedServers: ['global', 'ABC123'],
    myBannedRooms: new Set(),
    document: createClientDocument(),
    invalidateMessageReads: () => deletionCalls.push('invalidate'),
    renderSearchControl: () => deletionCalls.push('search-control'),
    enterLobby: () => deletionCalls.push('lobby'),
    switchServer: code => deletionCalls.push(`switch:${code}`),
    showAppAlert: () => deletionCalls.push('alert')
  });
  deleted.fn('ABC123');
  assert.deepEqual(deletionCalls, [
    'invalidate', 'search-control', 'switch:global', 'alert'
  ]);
});

test('search modal sends exact context, keeps hostile results inert, and recovers from a lost ack', () => {
  const helpers = loadHelpers();
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.children = [];
      this.className = '';
      this.style = {};
      this.disabled = false;
      this.hidden = false;
      this.value = '';
      this.onclick = null;
      this.attributes = new Map();
      this.classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        contains: name => this.classes.has(name)
      };
      this._textContent = '';
    }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, callback) { this[`on${type}`] = callback; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    scrollIntoView(options) { this.scrolledWith = options; }
    focus() { this.focused = true; }
    set textContent(value) {
      this._textContent = value == null ? '' : String(value);
      if (this._textContent === '') this.children = [];
    }
    get textContent() { return this._textContent; }
    set innerHTML(_value) { throw new Error('unsafe HTML assignment'); }
  }
  const elements = new Map([
    ['message-search-input', new Element('input')],
    ['message-search-submit', new Element('button')],
    ['message-search-status', new Element('div')],
    ['message-search-results', new Element('div')],
    ['message-search-modal', new Element('div')]
  ]);
  const loadedRows = [];
  const document = {
    createElement: tagName => new Element(tagName),
    getElementById: id => elements.get(id),
    querySelectorAll: selector => selector === '.msg[data-id]' ? loadedRows : []
  };
  const input = elements.get('message-search-input');
  const submit = elements.get('message-search-submit');
  const status = elements.get('message-search-status');
  const results = elements.get('message-search-results');
  const socketCalls = [];
  const timers = [];
  const canceledTimers = [];
  const socket = {
    emit(event, payload, callback) { socketCalls.push({ event, payload, callback }); }
  };
  const coordinator = helpers.createMessageReadCoordinator({
    onSearchPendingChange(value) { submit.disabled = value; }
  });
  coordinator.activate('ABC123', 12, null);

  const select = loadClientFunction('selectSearchResult', {
    document,
    messageSearchStatus: status,
    closeMessageSearch: () => elements.get('message-search-modal').classList.remove('active'),
    prefersReducedMotion: () => false,
    setTimeout(callback, delay) { timers.push({ callback, delay }); }
  });
  const render = loadClientFunction('renderSearchResults', {
    document,
    messageSearchResults: results,
    messageSearchStatus: status,
    formatExactDate: value => `date:${value}`,
    selectSearchResult: select.fn,
    ChatClientHelpers: helpers
  });
  const runtime = loadClientFunction('submitMessageSearch', {
    messageSearchInput: input,
    messageSearchStatus: status,
    messageSearchResults: results,
    searchRequestHandle: null,
    messageReadCoordinator: coordinator,
    socket,
    scheduleSearchAckTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancelSearchAckTimeout(timer) { canceledTimers.push(timer); },
    searchRequestTimeoutMs: 25,
    renderSearchResults: render.fn,
    ChatClientHelpers: helpers
  });

  input.value = ' first query ';
  assert.equal(runtime.fn(), true);
  assert.equal(socketCalls[0].event, 'search_messages');
  assert.deepEqual(structuredClone(socketCalls[0].payload), {
    serverCode: 'ABC123', clientContextId: 12, query: 'first query', requestId: 1
  });
  assert.equal(submit.disabled, true);

  input.value = 'second query';
  assert.equal(runtime.fn(), true);
  assert.deepEqual(structuredClone(socketCalls[1].payload), {
    serverCode: 'ABC123', clientContextId: 12, query: 'second query', requestId: 2
  });
  socketCalls[0].callback({
    serverCode: 'ABC123', clientContextId: 12, requestId: 1,
    results: [{ _id: 'stale', displayName: 'Stale', text: 'must not render', timestamp: 1 }]
  });
  assert.equal(results.children.length, 0);
  assert.equal(submit.disabled, true, 'older ack cannot enable the current Search button');

  socketCalls[1].callback({
    serverCode: 'ABC123', clientContextId: 12, requestId: 2,
    results: [{
      _id: 'hostile-id',
      displayName: '<img src=x onerror=alert(1)>',
      text: '<script>steal()</script> {{PING:everyone|everyone}}',
      timestamp: 99
    }]
  });
  assert.equal(submit.disabled, false);
  assert.equal(results.children.length, 1);
  const resultRow = results.children[0];
  assert.equal(resultRow.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(resultRow.children[2].children[0].textContent, '<script>steal()</script> ');
  assert.equal(resultRow.children[2].children[1].textContent, '@everyone');

  resultRow.onclick();
  assert.equal(status.textContent, 'This message is outside the loaded history.');
  const loaded = new Element('div');
  loaded.setAttribute('data-id', 'hostile-id');
  loadedRows.push(loaded);
  resultRow.onclick();
  assert.deepEqual(structuredClone(loaded.scrolledWith), { block: 'center', behavior: 'smooth' });
  assert.equal(loaded.classList.contains('search-highlight'), true);

  input.value = 'x';
  assert.equal(runtime.fn(), false);
  assert.equal(socketCalls.length, 2, 'short local validation never emits');
  assert.equal(status.textContent, 'Enter 2–80 characters.');

  input.value = 'lost acknowledgement';
  assert.equal(runtime.fn(), true);
  const ackTimer = timers.find(timer => timer.delay === 25 && !canceledTimers.includes(timer));
  assert.ok(ackTimer);
  ackTimer.callback();
  assert.equal(submit.disabled, false);
  assert.equal(status.textContent, 'Search timed out. Try again.');

  input.value = 'close and reopen';
  assert.equal(runtime.fn(), true);
  elements.get('message-search-modal').classList.add('active');
  const close = loadClientFunction('closeMessageSearch', {
    searchRequestHandle: runtime.context.searchRequestHandle,
    messageReadCoordinator: coordinator,
    messageSearchModal: elements.get('message-search-modal'),
    messageSearchInput: input,
    messageSearchResults: results,
    messageSearchStatus: status,
    messageSearchSubmit: submit
  });
  const closeTimer = timers.filter(timer => timer.delay === 25).at(-1);
  close.fn();
  assert.equal(canceledTimers.includes(closeTimer), true);
  assert.equal(submit.disabled, false);
  assert.equal(elements.get('message-search-modal').classList.contains('active'), false);

  const searchButton = new Element('button');
  searchButton.style.display = 'block';
  const open = loadClientFunction('openMessageSearch', {
    currentServerCode: 'ABC123',
    messageSearchButton: searchButton,
    messageReadCoordinator: coordinator,
    messageSearchInput: input,
    messageSearchResults: results,
    messageSearchStatus: status,
    messageSearchModal: elements.get('message-search-modal')
  });
  assert.equal(open.fn(), true);
  assert.equal(input.focused, true);
  socketCalls[3].callback({
    serverCode: 'ABC123', clientContextId: 12, requestId: 4,
    results: [{ _id: 'late-close', displayName: 'Late', text: 'private', timestamp: 3 }]
  });
  assert.equal(results.children.length, 0);
  assert.equal(status.textContent, 'Enter 2–80 characters to search this room.');
});

test('prepend scroll preserves the visible anchor and history rows deduplicate', () => {
  const helpers = loadHelpers();
  assert.equal(helpers.prependScrollTop({
    oldScrollHeight: 800, oldScrollTop: 120, newScrollHeight: 1100
  }), 420);
  assert.deepEqual(
    structuredClone(helpers.uniqueMessages(
      new Set(['2']),
      [{ _id: '1' }, { _id: '2' }, { _id: '1' }, { _id: null }]
    )),
    [{ _id: '1' }]
  );
});

test('older message request sends its frozen room context and ignores stale acknowledgements', () => {
  const helpers = loadHelpers();
  const calls = [];
  const applied = [];
  const socket = {
    emit(event, payload, callback) { calls.push({ event, payload, callback }); }
  };
  const coordinator = helpers.createMessageReadCoordinator();
  coordinator.activate('ABC123', 11, 'cursor-a');

  assert.ok(helpers.requestOlderMessages({
    coordinator, socket, onAccepted: response => applied.push(structuredClone(response))
  }));
  assert.deepEqual(structuredClone(calls[0].payload), {
    serverCode: 'ABC123', clientContextId: 11, cursor: 'cursor-a'
  });
  assert.equal(calls[0].event, 'list_messages');

  coordinator.activate('XYZ789', 12, 'cursor-b');
  calls[0].callback({
    serverCode: 'ABC123', clientContextId: 11,
    messages: [{ _id: 'old-room' }], nextCursor: null
  });
  assert.deepEqual(applied, []);
  assert.equal(coordinator.current().nextCursor, 'cursor-b');
});

test('older message timeout clears only its exact token and rejects a late acknowledgement', () => {
  const helpers = loadHelpers();
  const callbacks = [];
  const timers = [];
  const canceledTimers = [];
  const pending = [];
  const accepted = [];
  const coordinator = helpers.createMessageReadCoordinator({
    onOlderPendingChange: value => pending.push(value)
  });
  const socket = {
    emit(event, payload, callback) { callbacks.push({ event, payload, callback }); }
  };
  const options = {
    coordinator,
    socket,
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancelTimeout(timer) { canceledTimers.push(timer); },
    timeoutMs: 25,
    onAccepted(response) { accepted.push(structuredClone(response)); }
  };

  coordinator.activate('ABC123', 4, 'cursor-a');
  const firstHandle = helpers.requestOlderMessages(options);
  assert.ok(firstHandle);
  assert.equal(timers[0].delay, 25);
  assert.equal(coordinator.current().olderPending, true);

  timers[0].callback();
  assert.equal(coordinator.current().olderPending, false);
  assert.equal(firstHandle.cancel(), false, 'settled timeout cannot cancel again');

  const secondHandle = helpers.requestOlderMessages(options);
  assert.ok(secondHandle);
  timers[0].callback();
  assert.equal(coordinator.current().olderPending, true, 'late timeout cannot clear a newer token');
  callbacks[0].callback({
    serverCode: 'ABC123', clientContextId: 4,
    messages: [{ _id: 'late' }], nextCursor: 'wrong'
  });
  assert.deepEqual(accepted, [], 'late acknowledgement after timeout cannot render');
  assert.equal(coordinator.current().nextCursor, 'cursor-a');
  assert.equal(coordinator.current().olderPending, true);

  callbacks[1].callback({
    serverCode: 'ABC123', clientContextId: 4,
    messages: [{ _id: 'current' }], nextCursor: null
  });
  assert.deepEqual(accepted, [{
    serverCode: 'ABC123', clientContextId: 4,
    messages: [{ _id: 'current' }], nextCursor: null
  }]);
  assert.equal(coordinator.current().olderPending, false);
  assert.equal(canceledTimers.includes(timers[1]), true);
  assert.deepEqual(pending, [false, true, false, true, false]);
});

test('older message control is hidden without a cursor and disabled only while pending', () => {
  const helpers = loadHelpers();
  const control = { hidden: false, disabled: false };

  helpers.applyOlderControlState(control, {
    roomCode: null, nextCursor: null, olderPending: false
  });
  assert.deepEqual(control, { hidden: true, disabled: false });

  helpers.applyOlderControlState(control, {
    roomCode: 'ABC123', nextCursor: 'cursor-a', olderPending: true
  });
  assert.deepEqual(control, { hidden: false, disabled: true });
});

test('older message page prepends chronological unique rows and preserves its DOM anchor', () => {
  const helpers = loadHelpers();
  const historyControls = { id: 'history-controls' };
  const existing = {
    id: '2',
    getAttribute(name) { return name === 'data-id' ? this.id : null; }
  };
  const children = [historyControls, existing];
  const chatWindow = {
    scrollHeight: 800,
    scrollTop: 120,
    querySelectorAll() { return children.slice(1); }
  };
  Object.defineProperty(historyControls, 'nextSibling', {
    get() { return children[children.indexOf(historyControls) + 1] || null; }
  });

  const rendered = helpers.prependMessagePage({
    chatWindow,
    historyControls,
    messages: [{ _id: '0' }, { _id: '1' }, { _id: '2' }],
    renderMessage(message, anchor) {
      const index = anchor ? children.indexOf(anchor) : children.length;
      children.splice(index, 0, {
        id: message._id,
        getAttribute(name) { return name === 'data-id' ? this.id : null; }
      });
      chatWindow.scrollHeight += 150;
    },
    afterRender() {
      chatWindow.scrollHeight -= 40;
    }
  });

  assert.deepEqual(structuredClone(rendered).map(message => message._id), ['0', '1']);
  assert.deepEqual(children.slice(1).map(row => row.id), ['0', '1', '2']);
  assert.equal(chatWindow.scrollTop, 380, 'terminal control removal is included in the anchor correction');
});

test('older message anchor follows late image sizing until user scroll or room invalidation', () => {
  const helpers = loadHelpers();
  const listeners = new Map();
  const controls = { nextSibling: null };
  let anchorLayoutTop = 300;
  let current = true;
  let observerCallback;
  let disconnected = false;
  const anchor = {
    getAttribute: name => name === 'data-id' ? 'existing' : null,
    getBoundingClientRect: () => ({ top: anchorLayoutTop - chatWindow.scrollTop })
  };
  const children = [controls, anchor];
  controls.nextSibling = anchor;
  const chatWindow = {
    scrollHeight: 900,
    scrollTop: 120,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => children.filter(child => child !== controls),
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); }
  };
  const renderedRows = [];
  let cleanup;

  helpers.prependMessagePage({
    chatWindow,
    historyControls: controls,
    messages: [{ _id: 'remote-embed' }, { _id: 'attachment' }],
    renderMessage(message) {
      const row = {
        id: message._id,
        getAttribute: name => name === 'data-id' ? message._id : null
      };
      renderedRows.push(row);
      children.splice(children.indexOf(anchor), 0, row);
      anchorLayoutTop += 80;
      chatWindow.scrollHeight += 80;
      return row;
    },
    createResizeObserver(callback) {
      observerCallback = callback;
      return { observe() {}, disconnect() { disconnected = true; } };
    },
    isCurrent: () => current,
    onAnchorCleanup(value) { cleanup = value; }
  });
  assert.equal(anchor.getBoundingClientRect().top, 180, 'existing row retains its initial viewport offset');

  anchorLayoutTop += 140;
  chatWindow.scrollHeight += 140;
  observerCallback([{ target: renderedRows[0] }]);
  assert.equal(anchor.getBoundingClientRect().top, 180, 'late remote image sizing preserves the row offset');

  chatWindow.scrollTop += 25;
  listeners.get('scroll')();
  const intentionalTop = chatWindow.scrollTop;
  anchorLayoutTop += 90;
  observerCallback([{ target: renderedRows[1] }]);
  assert.equal(chatWindow.scrollTop, intentionalTop, 'late attachment sizing does not fight intentional scroll');
  assert.equal(disconnected, true);

  cleanup();
  current = false;
});

test('initial message history renders without motion and requests one bottom scroll', () => {
  const helpers = loadHelpers();
  const rendered = [];
  const scrolls = [];

  helpers.renderInitialMessagePage({
    messages: [{ _id: '1' }, { _id: '2' }],
    renderMessage(message, options) { rendered.push({ id: message._id, ...options }); },
    requestScroll(behavior) { scrolls.push(behavior); }
  });

  assert.deepEqual(rendered, [
    { id: '1', history: true },
    { id: '2', history: true }
  ]);
  assert.deepEqual(scrolls, ['auto']);
});

test('current-user room access fallback invalidates reads on membership loss', () => {
  const helpers = loadHelpers();
  const calls = [];

  assert.equal(helpers.syncCurrentUserRoomAccess({
    roomUsers: [{ username: 'Alice', roomRole: 'mod' }],
    username: 'Alice',
    globalRole: 'user',
    applyRole: role => calls.push(`role:${role}`),
    onAccessLoss: () => calls.push('lost')
  }), true);
  assert.deepEqual(calls, ['role:mod']);

  assert.equal(helpers.syncCurrentUserRoomAccess({
    roomUsers: [],
    username: 'Alice',
    globalRole: 'user',
    applyRole: role => calls.push(`role:${role}`),
    onAccessLoss: () => calls.push('lost')
  }), false);
  assert.deepEqual(calls, ['role:mod', 'lost', 'role:user']);

  helpers.syncCurrentUserRoomAccess({
    roomUsers: [],
    username: 'Alice',
    globalRole: 'admin',
    applyRole: role => calls.push(`role:${role}`),
    onAccessLoss: () => calls.push('admin-lost')
  });
  assert.equal(calls.includes('admin-lost'), false, 'admin ghost rooms do not imply access loss');
});

test('production message read lifecycle invalidates real lobby logout switch and socket paths', async () => {
  const invalidationCalls = [];
  const invalidation = loadClientFunction('invalidateMessageReads', {
    closeMessageSearch: () => invalidationCalls.push('search'),
    closeHistoryModal: () => invalidationCalls.push('detail'),
    stopOlderAnchor: () => invalidationCalls.push('anchor'),
    olderRequestHandle: { cancel: () => invalidationCalls.push('timer') },
    messageReadCoordinator: { invalidate: () => invalidationCalls.push('coordinator') },
    renderOlderControl: () => invalidationCalls.push('control'),
    renderSearchControl: forceHidden => invalidationCalls.push(`search-control:${forceHidden}`)
  });
  invalidation.fn();
  assert.deepEqual(invalidationCalls, [
    'search', 'detail', 'anchor', 'timer', 'coordinator', 'control', 'search-control:true'
  ]);
  assert.equal(invalidation.context.olderRequestHandle, null);

  const lobbyCalls = [];
  const lobbyDocument = createClientDocument();
  const lobby = loadClientFunction('enterLobby', {
    currentServerCode: 'ABC123',
    myRoomRole: 'mod',
    typingTimeout: null,
    typingUsers: new Map(),
    document: lobbyDocument,
    chatWindow: lobbyDocument.getElementById('chat-window'),
    msgInput: createClientElement(),
    sendBtn: createClientElement(),
    attachmentButton: createClientElement(),
    emojiButton: createClientElement(),
    fileUpload: createClientElement(),
    restrictionNotice: createClientElement(),
    compositionDisabled: false,
    invalidateMessageReads: () => lobbyCalls.push('reads'),
    compositionContextCoordinator: { invalidate: () => lobbyCalls.push('composition') },
    restrictionCoordinator: { clear() {} },
    clearTimeout() {},
    updateTypingUI() {},
    clearRenderedMessages: () => lobbyCalls.push('clear'),
    closeModeratorCenter() {},
    closeModerationPrompt() {},
    closeReportPrompt() {},
    closeResolutionPrompt() {},
    updateModeratorCenterAccess() {},
    renderSearchControl() {},
    cancelAction() {},
    ChatClientHelpers: { applyLobbyState() {} }
  });
  lobby.fn();
  assert.deepEqual(lobbyCalls.slice(0, 3), ['reads', 'composition', 'clear']);

  const logoutCalls = [];
  const logout = loadClientFunction('logoutApp', {
    showAppConfirm: async () => true,
    invalidateMessageReads: () => logoutCalls.push('reads'),
    localStorage: { removeItem: () => logoutCalls.push('storage') },
    location: { reload: () => logoutCalls.push('reload') }
  });
  await logout.fn();
  assert.deepEqual(logoutCalls, ['reads', 'storage', 'reload']);

  const replacementCalls = [];
  const oldSocket = { disconnect() { replacementCalls.push('disconnect'); } };
  const newSocket = {};
  const replacement = loadClientFunction('replaceClientSocket', {
    socket: oldSocket,
    socketUrl: 'https://old.test',
    io: () => newSocket,
    ChatClientHelpers: {
      replaceSocket(socket) {
        socket.disconnect();
        return { socket: newSocket, socketUrl: 'https://new.test' };
      }
    },
    invalidateMessageReads: () => replacementCalls.push('reads'),
    compositionContextCoordinator: { invalidate: () => replacementCalls.push('composition') },
    closeModerationPrompt() {},
    closeReportPrompt() {},
    invalidatePrivilegedAccess() {},
    setupSocket: () => replacementCalls.push('setup')
  });
  replacement.fn('https://new.test');
  assert.deepEqual(replacementCalls, ['disconnect', 'reads', 'composition', 'setup']);

  const switchCalls = [];
  const switchDocument = createClientDocument();
  const switching = loadClientFunction('handleSwitchResult', {
    currentServerCode: 'global',
    serversCache: { ABC123: { name: 'Room', owner: 'Owner' } },
    myRole: 'user',
    myRoomRole: 'user',
    myJoinedServers: ['global', 'ABC123'],
    myUsername: 'Alice',
    typingUsers: new Map(),
    document: switchDocument,
    showAppAlert() {},
    invalidateMessageReads: () => switchCalls.push('invalidate'),
    closeModeratorCenter() {},
    closeModerationPrompt() {},
    closeReportPrompt() {},
    compositionContextCoordinator: {
      activate: () => switchCalls.push('composition'),
      current: () => ({ clientContextId: 9 })
    },
    messageReadCoordinator: {
      activate: (...args) => switchCalls.push(['activate', ...args])
    },
    applyRestrictionState() {},
    renderServerAccess() {},
    updateModeratorCenterAccess() {},
    updateTypingUI() {},
    cancelAction() {},
    loadHistory: (...args) => switchCalls.push(['history', ...args]),
    renderOlderControl: () => switchCalls.push('control'),
    ChatClientHelpers: {
      applySwitchResult(options) {
        options.applySuccess(options.targetServerCode, options.response);
        return true;
      },
      appendTextElement(doc, parent) {
        const child = createClientElement();
        parent.appendChild(child);
        return child;
      }
    }
  });
  switching.fn('ABC123', {
    history: [{ _id: '1', username: 'Alice' }],
    nextCursor: 'cursor-a', roomRole: 'user', restriction: null
  });
  assert.equal(switchCalls[0], 'invalidate');
  assert.deepEqual(switchCalls[2], ['activate', 'ABC123', 9, 'cursor-a']);
  assert.deepEqual(structuredClone(switchCalls[3]), [
    'history', [{ _id: '1', username: 'Alice' }], { replace: true }
  ]);
  assert.equal(switchCalls[4], 'control');
});

test('production load older wiring handles terminal layout late images and stale callbacks', () => {
  const helpers = loadHelpers();
  const calls = [];
  const socketCalls = [];
  const timers = [];
  const listeners = new Map();
  const loadButton = { hidden: false, disabled: false };
  const historyControls = { hidden: false };
  let anchorLayoutTop = 240;
  let observerCallback;
  const existing = {
    id: '2',
    getAttribute: name => name === 'data-id' ? '2' : null,
    getBoundingClientRect: () => ({ top: anchorLayoutTop - chatWindow.scrollTop })
  };
  const children = [historyControls, existing];
  Object.defineProperty(historyControls, 'nextSibling', {
    get() { return children[children.indexOf(historyControls) + 1] || null; }
  });
  const chatWindow = {
    scrollHeight: 900,
    scrollTop: 120,
    children,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => children.filter(child => child.id),
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type) { listeners.delete(type); }
  };
  const coordinator = helpers.createMessageReadCoordinator({
    onOlderPendingChange(value) { loadButton.disabled = value; }
  });
  coordinator.activate('ABC123', 8, 'cursor-a');
  const renderControl = () => {
    calls.push('control');
    helpers.applyOlderControlState(loadButton, coordinator.current());
    const wasHidden = historyControls.hidden;
    historyControls.hidden = loadButton.hidden;
    if (!wasHidden && historyControls.hidden) {
      anchorLayoutTop -= 40;
      chatWindow.scrollHeight -= 40;
    }
  };
  const instrumentedHelpers = {
    requestOlderMessages(options) {
      calls.push('request');
      return helpers.requestOlderMessages(options);
    },
    prependMessagePage(options) {
      calls.push('prepend');
      return helpers.prependMessagePage(options);
    }
  };
  const runtime = loadClientFunction('loadOlderMessages', {
    olderRequestHandle: null,
    stopOlderAnchor: () => {},
    messageReadCoordinator: coordinator,
    socket: {
      emit(event, payload, callback) { socketCalls.push({ event, payload, callback }); }
    },
    scheduleOlderAckTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancelOlderAckTimeout() {},
    olderRequestTimeoutMs: 25,
    ChatClientHelpers: instrumentedHelpers,
    renderOlderControl: renderControl,
    chatWindow,
    historyControls,
    myUsername: 'Alice',
    appendMessage(message, isMe, { before }) {
      const row = {
        id: message._id,
        getAttribute: name => name === 'data-id' ? message._id : null
      };
      children.splice(children.indexOf(before), 0, row);
      anchorLayoutTop += 50;
      chatWindow.scrollHeight += 50;
      return row;
    },
    createOlderResizeObserver(callback) {
      observerCallback = callback;
      return { observe() {}, disconnect() {} };
    }
  });

  runtime.fn();
  assert.deepEqual(calls, ['request']);
  assert.equal(loadButton.disabled, true);
  assert.equal(socketCalls[0].event, 'list_messages');
  assert.deepEqual(structuredClone(socketCalls[0].payload), {
    serverCode: 'ABC123', clientContextId: 8, cursor: 'cursor-a'
  });

  socketCalls[0].callback({
    serverCode: 'ABC123', clientContextId: 8,
    messages: [{ _id: '0', username: 'Bob' }, { _id: '1', username: 'Bob' }, { _id: '2', username: 'Bob' }],
    nextCursor: null
  });
  assert.deepEqual(calls, ['request', 'prepend', 'control']);
  assert.deepEqual(children.map(child => child.id || 'controls'), ['controls', '0', '1', '2']);
  assert.equal(historyControls.hidden, true);
  assert.equal(loadButton.hidden, true);
  assert.equal(existing.getBoundingClientRect().top, 120, 'terminal flex removal is anchored');

  anchorLayoutTop += 110;
  chatWindow.scrollHeight += 110;
  observerCallback([{ target: children[1] }]);
  assert.equal(existing.getBoundingClientRect().top, 120, 'late remote image growth remains anchored');

  coordinator.activate('ABC123', 9, 'cursor-b');
  runtime.fn();
  coordinator.activate('XYZ789', 10, 'cursor-c');
  const childIds = children.map(child => child.id || 'controls');
  socketCalls[1].callback({
    serverCode: 'ABC123', clientContextId: 9,
    messages: [{ _id: 'stale', username: 'Bob' }], nextCursor: null
  });
  assert.deepEqual(children.map(child => child.id || 'controls'), childIds);
  assert.equal(calls.filter(call => call === 'prepend').length, 1);
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
    keywordsText: ' Spam\nspoilers ', mentionLimit: '4', repeatLimit: '5', repeatWindowSeconds: '60'
  }), {
    blockedKeywords: ['spam', 'spoilers'], mentionLimit: 4, repeatLimit: 5, repeatWindowSeconds: 60
  });
  assert.equal(client.normalizeAutoModPrompt({
    keywordsText: 'spam', mentionLimit: '21', repeatLimit: '5', repeatWindowSeconds: '60'
  }), null);
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
    repeatLimit: 3, repeatWindowSeconds: 30
  };
  const autoModSave = client.moderatorCenterMutationRequestFor('automod', autoModPayload);
  assert.equal(autoModSave.event, 'update_automod');
  assert.deepEqual(autoModSave.payload, autoModPayload);
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
    repeatLimit: 3, repeatWindowSeconds: 30
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
