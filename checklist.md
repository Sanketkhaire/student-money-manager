# Security Checklist — Student Money Manager

**Required for this repo.** Before merging any major change, check it against all 10 sections
below. Every test cycle (manual, automated, pre-release) must also include the **Test** items.

A change counts as **major** if it touches any of the following:
- `aws/lambda/**` or any API route
- how data is stored, or the data model
- rendering code that uses `innerHTML` or template strings
- `amplify.yml`, hosting, or headers
- IAM, CORS, or API Gateway settings
- dependencies
- the deploy pipeline
- privacy or user-facing data text

The checklist came from a security review on 2026-11-16 (OWASP Top 10 2021, OWASP API Security
Top 10 2023, CWE).

---

## How to use this checklist

1. **Author:** copy the "PR sign-off" block at the bottom into the PR description. Tick each
   section, or write `N/A` with a reason.
2. **Reviewer:** check every ticked item against the diff. Do not approve if any item is
   unticked without a reason.
3. **Tester:** run every **Test** item that applies. Record pass/fail and the date in the PR or
   test log.
4. **If a new class of issue is found:** add a section here in the same PR that fixes it.

---

## Part 1 — Root causes (why the 10 issues happened)

Most of the 10 findings come from six underlying causes:

| # | Root cause | Explanation | Findings it caused |
|---|-----------|-------------|--------------------|
| RC-1 | **The architecture changed but the threat model didn't** | The app was designed as a single-user app that keeps data in the browser (`localStorage`). It was moved to a public cloud API without rethinking who can reach the data. The old assumption ("only the owner can touch the data") no longer held. | #1, #6, #9 |
| RC-2 | **The client is trusted** | Validation, ID generation, `createdAt` and escaping all live in the browser. The server stores whatever it receives, and the browser renders whatever the server returns. Neither side treats the other as untrusted input. | #3, #4, #10 |
| RC-3 | **Insecure defaults were accepted for convenience** | An existing `PowerUserAccess` role was reused, CORS `*`, no throttling, no security headers, no PITR or logging. Each default was the quickest way to "make it work" on the free tier, and none was reviewed afterwards. | #2, #5, #6, #7, #8 |
| RC-4 | **HTML is built by string concatenation** | `innerHTML` with template literals is the main way the page renders. One missed `escapeHtml` call, or an attribute context the helper doesn't handle, creates XSS. | #3 |
| RC-5 | **No security gate in the dev and deploy process** | No review checklist, no branch protection, no dependency or secret scanning, and Lambda code deployed by hand from the console. Nothing stops an insecure change from shipping or detects drift. | #8, #10, and all others went undetected |
| RC-6 | **Docs and UI text were not updated with the code** | The footer still says "data stays on this device", and the spec non-goals still say "no backend". User-facing claims about data handling no longer match reality. | #9 |

**The core lesson:** every change that moves a trust boundary (browser ↔ network ↔ cloud) must
re-ask *who can call this, with what input, and what is the blast radius?*

---

## Part 2 — The 10-point security checklist

Each section lists **Review** checks (for code review) and **Test** checks (for every test cycle).

### 1. Authentication and access control
_OWASP A01, A07 · API1, API2, API5 · CWE-306/862 · Root cause RC-1_

**Review**
- [ ] Every API route (existing and new) requires authentication, such as a Cognito JWT
      authorizer on API Gateway. No route is public unless it's documented here with a reason.
- [ ] Every read, write and delete is scoped to the caller's `userId`, which comes from the
      verified token and **never** from the request body or query.
- [ ] No global or shared records (such as `id: "budget"`) that every user reads and writes.
- [ ] Delete and update check ownership before acting (conditional write on `userId`).

**Test**
- [ ] Calling each route with no token returns `401`.
- [ ] User A cannot read, update or delete User B's records by guessing or reusing an `id`;
      the result is `403` or `404`.
- [ ] Changing `userId` in the request body has no effect.

### 2. Least-privilege cloud permissions
_OWASP A01, A05 · CWE-250/269 · AWS Well-Architected SEC03 · Root cause RC-3_

**Review**
- [ ] The Lambda execution role is dedicated to this function. No AWS-managed broad policies
      (`PowerUserAccess`, `AdministratorAccess`, `AmazonDynamoDBFullAccess`).
- [ ] The policy lists only the DynamoDB actions the code actually calls, on the specific table
      ARNs, plus CloudWatch Logs write.
- [ ] A new AWS SDK call in the code comes with a matching, narrowly scoped IAM change (and no
      more than that).
- [ ] No AWS access keys or secrets in code, config or commits.

**Test**
- [ ] Run IAM Access Analyzer or the policy simulator on the role. Only the expected actions
      are allowed.
- [ ] Secret scanning (GitHub secret scanning or `gitleaks`) passes on the branch.

### 3. Output encoding and XSS prevention
_OWASP A03 · CWE-79 · Root cause RC-4_

**Review**
- [ ] Data from the server or the user is never put into `innerHTML`, `outerHTML`,
      `insertAdjacentHTML` or `document.write`. Use `textContent`, `setAttribute`
      or `dataset` instead.
- [ ] If an HTML template string can't be avoided, **every** interpolated value is
      encoded for its context (text vs. attribute vs. URL). `escapeHtml` that doesn't escape
      `"` and `'` must not be used inside attributes.
- [ ] Values used in `class`, `style`, `href` or `data-*` come from an allowlist (for example
      `type ∈ {income, expense}`).
- [ ] No `eval`, `new Function`, `setTimeout(string)` or inline event handlers.

**Test**
- [ ] Use the API to insert a record whose `category`, `description`, `type`, `id` and `date`
      each contain `<img src=x onerror=alert(1)>` and `"><svg onload=alert(1)>`. Load the app:
      no alert fires, and the text shows up literally or the record is rejected.
- [ ] With the CSP enabled (§7), the browser console shows no CSP violations during normal use.

### 4. Server-side input validation and mass assignment
_OWASP A04, A08 · API3, API6 · CWE-20/915 · Root cause RC-2_

**Review**
- [ ] The Lambda validates every field against the spec's rules V-1 to V-6, regardless of
      what the frontend checks:
  - `type` ∈ `{income, expense}`
  - `amount` is a finite number > 0 with at most 2 decimals and a sane maximum
  - `category` ∈ the 9 predefined categories
  - `date` matches `^\d{4}-\d{2}-\d{2}$` and is a real calendar date
  - `description` is a string of ≤ 200 characters
  - `monthlyLimit` is a finite number ≥ 0
- [ ] The stored item is **built from an allowlist of fields**. Never `Item: body` or a spread
      of the request.
- [ ] `id` and `createdAt` are generated on the server.
- [ ] Creates use `ConditionExpression: "attribute_not_exists(id)"`, so no silent overwrite.
- [ ] The frontend handles malformed records without crashing the whole render (a type check
      before `.split()` and similar calls).

**Test**
- [ ] Each of these returns `400` and nothing is stored: `amount` of `-5`, `0`, `"abc"`,
      `1e309`, or missing; an unknown `category`; `type: "refund"`; `date: 123` or
      `"2026-13-45"`; a 201-character description; extra fields.
- [ ] POSTing an existing `id` does not overwrite that record.
- [ ] A record with bad data inserted directly in DynamoDB doesn't break page rendering for
      the other records.

### 5. Resource limits and cost protection
_API4 · CWE-400/770 · Root cause RC-3_

**Review**
- [ ] API Gateway stage throttling is set (rate and burst). Lambda has reserved concurrency.
- [ ] The request body size is checked (for example, reject requests over 4 KB).
- [ ] No unbounded `Scan`. Use a `Query` on the user's partition, with `Limit` and pagination
      (`LastEvaluatedKey`).
- [ ] AWS Budgets or billing alarms are active for the account.

**Test**
- [ ] A burst above the throttle limit returns `429`.
- [ ] A 1 MB request body is rejected.
- [ ] With more than 1 MB of test data, the list paginates correctly and nothing is silently
      truncated.

### 6. CORS and cross-origin policy
_OWASP A05 · CWE-942 · Root cause RC-1, RC-3_

**Review**
- [ ] `Access-Control-Allow-Origin` is the exact production origin (plus `localhost` for
      dev only). Never `*`.
- [ ] The CORS config is the same in the Lambda `CORS_HEADERS` and in API Gateway.
- [ ] Allowed methods and headers are only the ones actually used (add `Authorization` once
      auth is in place).

**Test**
- [ ] A request with `Origin: https://evil.example` gets no matching
      `Access-Control-Allow-Origin` header.
- [ ] The production site still works (preflight and requests succeed).

### 7. Security headers and hosting configuration
_OWASP A05 · CWE-693/1021 · Root cause RC-3_

**Review**
- [ ] Amplify `customHeaders` set:
  - `Content-Security-Policy`: `default-src 'self'`, `connect-src` set to the API origin only,
    `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`
  - `Strict-Transport-Security`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-Frame-Options: DENY`
- [ ] New external scripts, fonts or APIs are added to the CSP on purpose and pinned with
      SRI (`integrity=`).
- [ ] `amplify.yml` still publishes only the public frontend files. No `aws/`, `.git`, docs
      or config.

**Test**
- [ ] Scan the deployed site with `securityheaders.com` or `curl -I`. All the headers above
      are present.
- [ ] The page can't be loaded in an `<iframe>` on another origin.
- [ ] Requesting `/aws/lambda/index.mjs`, `/CLAUDE.md` or `/.git/config` on the hosted site
      returns 404.

### 8. Logging, monitoring and recoverability
_OWASP A09 · CWE-778 · Root cause RC-3, RC-5_

**Review**
- [ ] State changes (create, delete, budget update) write a structured audit log with
      `userId`, action, record id, timestamp and request id. **No** amounts or descriptions,
      to avoid leaking personal data into logs.
- [ ] Errors are logged on the server only. Clients get generic messages with no stack traces.
- [ ] API Gateway access logging is enabled.
- [ ] CloudWatch alarms exist for 5xx rate, 4xx spikes, throttles and Lambda errors.
- [ ] DynamoDB point-in-time recovery (PITR) is on for all tables.

**Test**
- [ ] Performing a create or delete produces a matching audit log entry.
- [ ] Forcing an error triggers the alarm, or the alarm is visible in the console.
- [ ] A restore from PITR has been tried at least once per semester or release.

### 9. Privacy and data-handling transparency
_OWASP A04 · CWE-359 · GDPR-style transparency and data minimisation · Root cause RC-1, RC-6_

**Review**
- [ ] UI text, the footer, the README and the spec (`CLAUDE.md`) accurately describe where data
      is stored and who can access it.
- [ ] Any change to storage location, retention or data sharing updates that text **in the same
      PR**.
- [ ] Only the fields the app needs are collected. No new personal data fields without a
      documented reason.
- [ ] Users can delete their own data.

**Test**
- [ ] The footer and help text match the deployed architecture.
- [ ] Deleting a record removes it from the database, not just the UI.

### 10. Supply chain and deployment integrity
_OWASP A06, A08 · CWE-494/1104 · Root cause RC-5_

**Review**
- [ ] `master` is protected: PRs are required, at least 1 review, no force-push, and status
      checks pass.
- [ ] Lambda code is deployed from the repo by IaC or CI (SAM, CDK or a GitHub Action with
      OIDC), not pasted into the console. The deployed code matches git.
- [ ] Lambda dependencies are declared in `package.json` with a committed lockfile.
- [ ] Dependabot (or similar) and secret scanning are enabled. No PR merges with known
      high or critical vulnerabilities.
- [ ] Security-sensitive values (IDs, tokens) use `crypto.randomUUID()` or come from the
      server. No `Math.random`.

**Test**
- [ ] `npm audit --audit-level=high` (or the Dependabot report) is clean.
- [ ] Comparing the deployed Lambda code to `aws/lambda/` at the release commit shows no
      differences.

---

## PR sign-off (copy into every major PR)

```markdown
### Security checklist (see checklist.md)
- [ ] 1. Authentication & access control
- [ ] 2. Least-privilege cloud permissions
- [ ] 3. Output encoding / XSS
- [ ] 4. Server-side validation / mass assignment
- [ ] 5. Resource limits / cost protection
- [ ] 6. CORS
- [ ] 7. Security headers / hosting config
- [ ] 8. Logging, monitoring, recoverability
- [ ] 9. Privacy & data-handling transparency
- [ ] 10. Supply chain & deployment integrity

Items marked N/A (with reason):
Security tests run (date / result):
```

---

## Current status

Legend: ✅ done · 🟡 code done, needs the one-time AWS deploy in `aws/README.md` · ❌ open

| # | Area | Status | Where it's fixed |
|---|------|--------|------------------|
| 1 | Authentication & access control | 🟡 | Cognito + JWT authorizer (`aws/template.yaml`); per-user partition keys and token-derived `userId` (`aws/lambda/handler.mjs`); sign-in flow (`auth.js`) |
| 2 | Least-privilege IAM | 🟡 | Dedicated `smm-api-secure-role` with 5 DynamoDB actions on 2 tables (`aws/template.yaml`); CI guard against broad policies |
| 3 | XSS / output encoding | ✅ | `app.js` renders only via `createElement`/`textContent`; CI guard bans HTML-string DOM APIs |
| 4 | Server-side validation | 🟡 | `aws/lambda/validation.mjs` (allowlist, V-1–V-6), server-side `id`/`createdAt`, no-overwrite condition, 4 KB body limit; frontend skips malformed records |
| 5 | Rate limits / cost | 🟡 | API throttling 10 rps / burst 20, paginated `Query` instead of `Scan`, AWS Budget alert (`aws/template.yaml`) |
| 6 | CORS | 🟡 | Exact-origin CORS in API Gateway and the Lambda; Lambda refuses to start with `*`; CI guard |
| 7 | Security headers | ✅ | `customHttp.yml` (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy); `amplify.yml` publishes only frontend files |
| 8 | Logging / monitoring / PITR | 🟡 | Structured audit logs (`handler.mjs`), API access logs, 4 CloudWatch alarms + SNS, PITR on both tables |
| 9 | Privacy transparency | ✅ | Footer text corrected; spec §1.5 documents the cloud architecture |
| 10 | Supply chain / deployment | ✅ / 🟡 | Pinned SDK + lockfile, Dependabot, CI tests and `npm audit`, PR template, branch protection; Lambda deployed by GitHub OIDC workflow (needs the stack) |
