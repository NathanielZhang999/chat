# Default Render Backend URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefill the single-file chat frontend with `https://chat-backend-iekp.onrender.com` for new users.

**Architecture:** Add the deployed URL as the initial value of the existing Backend URL input. Preserve the current editable input, URL normalization, local-storage override, and Socket.IO connection flow.

**Tech Stack:** HTML, browser JavaScript, Node.js built-in test runner

## Global Constraints

- Keep the main application architecture at three production files: `chat.html`, `backend/server.js`, and `backend/package.json`.
- Use the exact default URL `https://chat-backend-iekp.onrender.com`.
- Keep the Backend URL field editable.
- Preserve `pro_chat_url` local-storage values as the returning user's override.
- Do not change backend behavior or dependencies.

---

### Task 1: Prefill the deployed backend URL

**Files:**
- Modify: `chat.html:352`
- Test: `backend/test/client-smoke.test.js`

**Interfaces:**
- Consumes: the existing `#url-input` field and `pro_chat_url` page-load restoration
- Produces: an editable input whose initial HTML value is exactly `https://chat-backend-iekp.onrender.com`

- [ ] **Step 1: Write the failing test**

Add this test to `backend/test/client-smoke.test.js`:

```js
test('new users receive the deployed Render backend URL by default', () => {
  const source = fs.readFileSync(chatPath, 'utf8');
  assert.match(
    source,
    /id="url-input"[^>]*value="https:\/\/chat-backend-iekp\.onrender\.com"/
  );
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test backend/test/client-smoke.test.js --test-name-pattern="new users receive"`

Expected: FAIL because `#url-input` has no `value` attribute containing the deployed URL.

- [ ] **Step 3: Add the default value**

Change the existing Backend URL input in `chat.html` to:

```html
<input type="text" id="url-input" class="text-input" value="https://chat-backend-iekp.onrender.com" placeholder="https://your-app.onrender.com">
```

Do not change the existing local-storage restoration logic; it must continue to overwrite the HTML default when `pro_chat_url` exists.

- [ ] **Step 4: Run focused and complete client verification**

Run: `node --test backend/test/client-smoke.test.js`

Expected: all client smoke tests PASS.

Run: `node --check backend/server.js`

Expected: exit code 0.

Run: `git diff --check`

Expected: exit code 0.

- [ ] **Step 5: Commit the implementation**

```bash
git add -- chat.html backend/test/client-smoke.test.js
git commit -m "config: set default Render backend URL"
```
