# Invisible Security Hardening Design

**Date:** 2026-08-13  
**Status:** Approved direction; implementation pending plan review  
**Base:** `fb84aab648a363f2ca05116727910d756df1795e`  
**Deployment target:** GitHub branch `deploy-chat`, Render backend, MongoDB, one Node process

## Goal

Strengthen the public chat against credential guessing, hostile browser origins, oversized or repeated Socket.IO work, and free-tier resource exhaustion without adding CAPTCHA, mandatory two-factor authentication, extra login steps, or normal-use friction.

The design must remain safe for schools, offices, apartments, and families whose users share one public network address. A network address is a coarse abuse signal, never an account identity and never a reason to impose a small user-count ceiling.

## Scope and constraints

- Keep runtime application code in `backend/server.js` and `chat.html`.
- Keep `<title>Chat v1.3.2</title>` unchanged.
- Preserve the current message, moderation, AutoMod, appearance, image, and keyboard behavior.
- Do not restore room information, pins, unread indicators, per-room notifications, blocking, search, or pagination.
- Do not introduce persistent login tokens or a durable device/session subsystem in this phase.
- Do not log passwords, supplied message text, attachments, authorization material, complete network addresses, or raw Socket.IO payloads.
- Preserve the current public GitHub Pages frontend and configurable Render backend model.
- Use the existing dependencies unless a measured requirement cannot be met without another package. Security headers and limiters do not require a new dependency.

## Architecture

The hardening is divided into four isolated owners:

1. **Origin policy** validates browser origins for Express and Socket.IO from one shared configuration.
2. **Authentication protection** provides generic login failures, timing normalization, bcrypt-cost migration, and layered account/network throttling.
3. **Transport admission** bounds connection churn, packet size, and concurrent or repeated expensive events before application handlers perform database work.
4. **Privacy-safe security telemetry** records only bounded event categories and hashed network buckets for operational diagnosis.

Each owner is exposed as a small dependency-injected helper so direct tests can use a fake clock, fake environment, fake sockets, and controlled bcrypt/database boundaries.

## 1. Origin and HTTP policy

### Configuration

`ALLOWED_ORIGINS` is a comma-separated set of exact HTTP(S) origins. Values are normalized through `new URL(value).origin`; entries containing paths, credentials, queries, fragments, wildcards, or non-HTTP(S) schemes are rejected.

The deployed default allowlist contains `https://nathanielzhang999.github.io`, the origin that serves the public GitHub Pages application. Operators may replace or extend it with `ALLOWED_ORIGINS` for a custom domain.

Development additionally permits loopback HTTP origins on `localhost` or `127.0.0.1` with any valid port. Production is detected by `NODE_ENV=production` or Render's platform marker and does not permit loopback or the opaque `null`/`file://` origin. Native/no-Origin requests are rejected at the public Socket.IO boundary unless an explicit test-only injected policy permits them.

Malformed configured origins fail startup before Mongo connection or `listen()`. There is no production wildcard fallback.

### Enforcement

One `createOriginPolicy()` result supplies the callback used by both Express CORS and Socket.IO CORS/handshake admission. Rejection returns a generic origin-not-allowed response and never echoes the supplied origin.

The Express app also applies dependency-free headers:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`
- a restrictive `Permissions-Policy`
- `Cross-Origin-Resource-Policy: same-site`
- `Strict-Transport-Security` only in production

The backend does not serve the frontend, so it does not add a page Content Security Policy.

## 2. Authentication protection

### Generic failures and timing

Login returns `Invalid username or password.` for an unknown account, a wrong password, or an account that disappears during the serialized transition. Input-shape errors remain `Invalid input format.` and cooldown errors remain generic.

The backend owns one valid dummy bcrypt hash at the configured current cost. Unknown-account login performs `bcrypt.compare()` against the dummy hash before responding. Existing accounts continue to use their stored hash. Tests require the unknown-account and wrong-password paths to cross the same comparison boundary, but do not assert wall-clock equality.

Registration may still report that a username or display name is unavailable because uniqueness feedback is required to create an account. Registration receives the same layered throttling and bounded lookup behavior as login.

### Password hashing

The current bcrypt work factor is 11, chosen as a modest increase from 10 for the free Render CPU budget. Registration and password changes create cost-11 hashes. After a successful login, a stored bcrypt hash with a lower cost is rehashed at cost 11 and saved under the account lock before the successful acknowledgement. Hashes at the current or a higher valid cost are not rewritten.

Rehash failure fails the login closed with a generic error and publishes no authenticated socket state. Passwords and hashes never enter logs or acknowledgements.

### Shared-network-safe throttling

All state is bounded in process because deployment uses one Node process. Keys are NFKC-normalized and size-limited. Expired keys are pruned, and the combined limiter map has a hard 10,000-key cap with deterministic oldest-key eviction.

Login and registration attempts consume these rolling-window buckets:

- **Account:** 10 failed/admitted attempts per 15 minutes for login; 6 attempts per 15 minutes for registration.
- **Account plus network:** 6 attempts per 15 minutes for either login or registration.
- **Network aggregate:** 60 attempts per 15 minutes across all accounts.

The most restrictive exhausted bucket rejects the attempt. A successful login clears only that account's login bucket and its account-plus-network bucket. It does not clear the aggregate network history, which prevents one successful account from resetting an ongoing distributed guessing burst.

Rejected cooldown attempts do not extend the cooldown window. A single network cannot permanently ban itself; every timestamp expires naturally. Normal authenticated chat events are not charged to a network-wide authentication bucket.

The network key comes from the trusted proxy-derived peer address, normalized for IPv4-mapped IPv6. It is hashed with a per-process random salt before storage or telemetry. Raw forwarded headers are not trusted directly by application code and are never logged.

## 3. Transport and resource admission

### Packet bounds

Retain the current 10,000,000-byte Socket.IO transport ceiling because the existing backend contract accepts data-URL attachments up to 8,000,000 characters. Add event-specific shape and size checks before handlers perform database reads:

- authentication/profile/control payloads: at most 8 KiB;
- ordinary text-only message and mutation payloads: at most 16 KiB;
- `chat_message` with an attachment: at most 8.1 MiB and still subject to the existing attachment validator;
- unknown events or extra unapproved envelope fields: rejected without dispatch.

Sizing is byte-based, bounded, and does not log or retain serialized payloads.

### Connection and request pressure

Admission uses generous shared-network thresholds:

- at most 60 new Socket.IO connection attempts per network per minute;
- at most 100 simultaneous sockets per network as an emergency process-protection ceiling;
- at most 8 authenticated sockets per account.

The network ceilings are intentionally much larger than household or classroom use. Reaching the account ceiling rejects the newest authentication without disconnecting established sessions.

Authenticated events use category budgets rather than a single global limiter:

- lightweight room/chat controls: 120 per account per minute;
- database-heavy reads or room switches: 30 per account per minute;
- profile, password, preference, and moderation configuration writes: 10 per account per 15 minutes;
- moderation listing/audit reads: 30 per moderator account per minute.

Existing AutoMod message-rate behavior remains authoritative for accepted messages and is not duplicated by the generic event budget.

For database-heavy request/ack events, only one request per socket and operation key may be in flight. A duplicate receives `Request already in progress.` and starts no second database operation. Every acquired in-flight slot is released on success, error, thrown callback, disconnect, and socket replacement.

### Database deadlines

Read-heavy Mongo queries introduced to the admission map use an injected 2-second deadline (`maxTimeMS(2000)` where supported). A timeout produces a generic retryable acknowledgement and releases limiter/in-flight state. Mutating transactions are not interrupted with client-side races; their existing lock/transaction correctness remains unchanged.

## 4. Error behavior and telemetry

Security rejection messages are intentionally generic:

- `Connection unavailable.`
- `Too many requests. Try again later.`
- `Invalid username or password.`
- `Request already in progress.`

The server may log the bounded categories `origin_rejected`, `auth_throttled`, `connection_throttled`, `payload_rejected`, `duplicate_request`, and `query_deadline`. Metadata is limited to the event category, operation class, hashed network bucket, and numeric count/window. It excludes usernames for origin/network events and excludes message/profile/password contents everywhere.

Expected security rejections are not logged through the generic unexpected-error path and cannot amplify persistent audit writes.

## Data flow and ordering

1. HTTP/Socket.IO origin policy rejects an untrusted browser before creating application session state.
2. Connection admission checks the hashed network bucket and emergency concurrent ceiling.
3. Packet admission validates the event name, exact envelope, byte budget, account/network category budget, and in-flight key.
4. Authentication performs layered throttling, lookup, dummy or real bcrypt comparison, account locking, optional hash migration, session publication, and synchronous acknowledgement in that order.
5. Request handlers release all admission state in `finally`; disconnect also clears socket-owned in-flight state and decrements concurrent counters.

No acknowledgement reports success before required durable state and same-account session publication complete.

## Testing strategy

### Origin and headers

- deployed GitHub Pages origin accepted;
- configured custom HTTPS origins accepted after exact normalization;
- hostile suffix, credential, path, wildcard, opaque/null, file, and malformed origins rejected;
- loopback allowed only in development;
- malformed production configuration fails before Mongo/listen;
- Express and Socket.IO use the identical policy;
- every required header is present, with HSTS production-only.

### Authentication

- unknown and wrong-password login return the same error and each execute one bcrypt comparison;
- successful cost-10 login upgrades once to cost 11 before acknowledgement;
- current/higher-cost hashes do not rewrite;
- failed migration publishes no authenticated socket/session state;
- layered limiter exact boundaries, expiry, no rejected-attempt extension, pruning, and 10,000-key union bound;
- shared-network matrix proves many distinct valid accounts can log in while one attacked account is throttled;
- a successful account does not reset the aggregate network abuse bucket;
- logs and acknowledgements contain no password/hash/raw-address sentinels.

### Transport and availability

- exact byte boundaries for every event class, including the existing maximum attachment contract;
- oversized/malformed/unknown packets perform zero database work and broadcast nothing;
- connection and session ceilings preserve existing sessions and reject only the newest excess request;
- different accounts on one network remain independent below the generous emergency ceiling;
- per-category exact boundaries and expiry;
- duplicate in-flight operations execute once and release on every terminal path;
- query deadline returns a generic error and does not poison the next request;
- disconnect/reconnect and same-socket generation races cannot retain admission state.

### Release gate

- full backend suite;
- server and changed-test syntax checks;
- inline browser script compilation and unique HTML IDs;
- exact `Chat v1.3.2` title;
- credential/privacy scan;
- no dependency or package-file changes unless separately approved;
- runtime file scope remains `backend/server.js` and `chat.html`;
- removed-feature marker scan remains clean.

## Deployment and rollback

Before publication, configure `ALLOWED_ORIGINS` on Render if the frontend uses any origin beyond `https://nathanielzhang999.github.io`. Deploy backend and existing frontend compatibility tests together, push normally to `deploy-chat`, and verify the remote SHA equals the tested commit. Never force-push.

Rollback is a normal revert of the security commit series. Origin configuration can be widened only to another explicit trusted origin; rollback must not replace it with `*` as an emergency shortcut.

## Non-goals

- CAPTCHA, mandatory 2FA, email/SMS delivery, passkeys, or recovery codes.
- Persistent access/refresh tokens, durable device lists, or individual device revocation.
- IP bans, geolocation, fingerprinting, or storing raw network addresses.
- A WAF, Redis, another process, horizontal scaling, or paid infrastructure.
- Visual redesign or changes to normal chat workflows.
