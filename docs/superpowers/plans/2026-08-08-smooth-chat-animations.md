# Smooth Chat Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the single-file chat frontend subtle, consistent motion and eliminate competing automatic scroll animations.

**Architecture:** Keep presentation changes in the existing CSS block and add small pure scheduling/policy helpers to `ChatClientHelpers`. Live messages use one coalesced smooth scroll only when the viewer is near the bottom; history renders without per-message animation or scrolling and performs one final instant scroll.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js built-in test runner

## Global Constraints

- Keep all production animation and scroll changes in `chat.html`.
- Keep the main application architecture at three production files: `chat.html`, `backend/server.js`, and `backend/package.json`.
- Do not add dependencies or change backend, authentication, message, room, or Socket.IO behavior.
- Use subtle, non-overshooting motion and explicit transition properties; do not use `transition: all`.
- Preserve editable backend URL and existing `pro_chat_url` behavior.
- Respect `prefers-reduced-motion: reduce` by disabling entrance motion and smooth scrolling.
- Preserve the viewer's reading position when live updates arrive while they are away from the bottom.

---

### Task 1: Establish the polished CSS motion system

**Files:**
- Modify: `chat.html:9-285`
- Test: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: existing component selectors and `.active`/`.show` state classes
- Produces: shared `--motion-fast`, `--motion-base`, `--motion-slow`, and `--ease-standard` CSS variables; `.no-enter-animation`; reduced-motion overrides

- [ ] **Step 1: Add failing motion-policy smoke coverage**

Add this test to `backend/test/client-smoke.test.js`:

```js
test('client motion policy avoids broad transitions and respects reduced motion', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.doesNotMatch(source, /transition:\s*all\b/);
  assert.match(source, /--ease-standard:\s*cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\)/);
  assert.match(source, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(source, /\.no-enter-animation\s*\{[^}]*animation:\s*none/s);
  assert.match(source, /#chat-window\s*\{[^}]*scroll-behavior:\s*auto/s);
});
```

The break this catches is reintroducing broad property animation or removing the accessibility fallback from the shipped frontend.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="client motion policy" backend/test/client-smoke.test.js`

Expected: FAIL because `transition: all` exists and the shared motion/reduced-motion rules do not.

- [ ] **Step 3: Add shared motion variables and explicit transitions**

Extend `:root` with these exact variables:

```css
--motion-fast: 140ms;
--motion-base: 220ms;
--motion-slow: 280ms;
--ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
```

Replace every `transition: all` with only the properties the selector changes. Use these declarations for the main animated surfaces:

```css
.modal { transition: opacity var(--motion-base) var(--ease-standard), visibility 0s linear var(--motion-base); }
.modal.active { transition-delay: 0s; }
.modal-box { transition: transform var(--motion-slow) var(--ease-standard), opacity var(--motion-base) ease; }
.server-icon { transition: border-radius var(--motion-base) var(--ease-standard), background-color var(--motion-base) ease, color var(--motion-fast) ease, transform var(--motion-fast) var(--ease-standard), opacity var(--motion-fast) ease; }
.tooltip, .msg-actions, .emoji-picker-container, .context-menu { transition: opacity var(--motion-fast) ease, transform var(--motion-base) var(--ease-standard), visibility 0s linear var(--motion-base); }
.tooltip, .msg-actions, .emoji-picker-container, .context-menu { will-change: opacity, transform; }
.no-enter-animation { animation: none !important; }
```

For `.active` and `.show` states that reveal hidden surfaces, set `transition-delay: 0s`. Replace overshooting cubic-bezier values throughout the CSS with `var(--ease-standard)`. Reduce entrance distances to 8px or less, initial scales to at least `0.98`, hover scales to at most `1.05`, and message entrance duration to `var(--motion-base)`.

Remove `scroll-behavior: smooth` from `#chat-window` and set `scroll-behavior: auto`; Task 2 will request smooth behavior only for appropriate live updates.

- [ ] **Step 4: Add reduced-motion behavior**

Append this rule after the component animation rules:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  #chat-window { scroll-behavior: auto !important; }
  .msg, .system-msg, .server-icon, .user-item, .reaction-bubble {
    animation: none !important;
    transform: none !important;
  }
}
```

- [ ] **Step 5: Verify and commit Task 1**

Run: `node --test backend/test/client-smoke.test.js`

Expected: PASS.

Run: `git diff --check`

Expected: exit code 0.

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "style: smooth chat motion"
```

---

### Task 2: Coalesce scrolling and suppress bulk-history motion

**Files:**
- Modify: `chat.html:458-585, 1690-1875`
- Test: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: Task 1's `.no-enter-animation` class and `#chat-window { scroll-behavior: auto; }`
- Produces: `ChatClientHelpers.isNearScrollEnd(element, threshold)`, `ChatClientHelpers.messageRenderPolicy(options)`, and `ChatClientHelpers.createScrollCoordinator(scheduleFrame, getScroller)`

- [ ] **Step 1: Add failing behavior tests**

Add these tests to `backend/test/client-smoke.test.js`:

```js
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
```

The first test catches history messages accidentally animating/scrolling individually or live updates stealing the reader's position. The second catches overlapping scroll frames and incorrect priority when a history jump and live update coincide.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern="scroll policy|scroll coordinator" backend/test/client-smoke.test.js`

Expected: FAIL because the three helper methods do not exist.

- [ ] **Step 3: Implement the pure helpers**

Add these methods to `ChatClientHelpers`:

```js
isNearScrollEnd(element, threshold = 96) {
  if (!element) return false;
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining <= threshold;
},

messageRenderPolicy({ history = false, wasNearBottom = false } = {}) {
  return {
    animate: !history,
    shouldScroll: !history && wasNearBottom,
    behavior: history ? 'auto' : 'smooth'
  };
},

createScrollCoordinator(scheduleFrame, getScroller) {
  let scheduled = false;
  let pendingBehavior = null;

  return {
    request(behavior = 'smooth') {
      pendingBehavior = pendingBehavior === 'auto' || behavior === 'auto' ? 'auto' : 'smooth';
      if (scheduled) return;
      scheduled = true;
      scheduleFrame(() => {
        const requestedBehavior = pendingBehavior;
        pendingBehavior = null;
        scheduled = false;
        const scroller = getScroller();
        if (!scroller) return;
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: requestedBehavior });
      });
    }
  };
},
```

- [ ] **Step 4: Wire one coordinator into production rendering**

After `chatWindow` is assigned, create one coordinator with a compatibility fallback:

```js
const scheduleAnimationFrame = window.requestAnimationFrame
  ? callback => window.requestAnimationFrame(callback)
  : callback => setTimeout(callback, 0);
const chatScrollCoordinator = ChatClientHelpers.createScrollCoordinator(
  scheduleAnimationFrame,
  () => chatWindow
);
```

Change the message signature and policy setup to:

```js
function appendMessage(data, isMe, { history = false } = {}) {
  const renderPolicy = ChatClientHelpers.messageRenderPolicy({
    history,
    wasNearBottom: ChatClientHelpers.isNearScrollEnd(chatWindow)
  });
```

Before appending either a normal or deleted wrapper, apply:

```js
if (!renderPolicy.animate) wrapper.classList.add('no-enter-animation');
```

Replace both per-message `setTimeout(...scrollTo...)` calls with:

```js
if (renderPolicy.shouldScroll) chatScrollCoordinator.request(renderPolicy.behavior);
```

Change history rendering to suppress individual motion and request exactly one final instant scroll:

```js
function loadHistory(msgs) {
  if (!msgs || !Array.isArray(msgs)) return;
  msgs.forEach(message => appendMessage(message, message.username === myUsername, { history: true }));
  chatScrollCoordinator.request('auto');
}
```

For `appendSystemMessage`, capture `const wasNearBottom = ChatClientHelpers.isNearScrollEnd(chatWindow);` before appending, then request one smooth scroll only when `wasNearBottom` is true. Do not change user-triggered reply navigation with `scrollIntoView`.

- [ ] **Step 5: Verify Task 2 and the complete project**

Run: `node --test backend/test/client-smoke.test.js`

Expected: PASS.

Run: `npm test --prefix backend`

Expected: all four test files PASS.

Run: `node --check backend/server.js`

Expected: exit code 0.

Run: `git diff --check`

Expected: exit code 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "perf: coalesce chat scrolling"
```
