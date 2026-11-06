# Fenwick Patient Portal

A small local web app for a QA automation training exercise. Trainees write Cucumber and Playwright (TypeScript) tests against it.

The app is deterministic by default. Selectors and messages are fixed, because the training material refers to them.

> **Training app only.** Users live in a plain in-memory object and passwords are compared in plain text. Do not copy this as a security example. All names and data are fictional.

## How to run

Requires Node.js 20 or later. There are no dependencies, so `npm install` is not needed.

```bash
npm start
```

Then open http://localhost:3000/login.

Run the self-check, which starts its own server on a spare port:

```bash
npm test
```

Example with options:

```bash
PORT=4000 LOCK_THRESHOLD=5 FLAKY_BANNER=on ENABLE_TEST_RESET=on npm start
```

## Test user

| Username   | Password               |
|------------|------------------------|
| `tomsmith` | `SuperSecretPassword!` |

## Routes

| Method | Path            | Auth     | Behaviour |
|--------|-----------------|----------|-----------|
| GET    | `/`             | none     | Redirects (302) to `/login`. |
| GET    | `/login`        | none     | Login page. Shows the pending flash message, if any. |
| POST   | `/login`        | none     | Form-encoded `username` and `password`. On success, sets the `session` cookie and redirects (303) to `/secure`. On failure, redirects (303) to `/login` with the error shown. |
| GET    | `/secure`       | session  | Secure area with a Logout link. With no session, redirects (302) to `/login` with no flash message. |
| GET    | `/logout`       | none     | Clears the session and redirects (303) to `/login` with the logout message. |
| GET    | `/appointments` | session  | Three appointments, each with a "Confirm appointment" checkbox, plus a status line. With no session, redirects (302) to `/login`. |
| POST   | `/appointments` | session  | Form-encoded `confirmed` values (`1`, `2`, `3`, repeatable). Saves the checked boxes for this session and redirects (303) to `/appointments`. |
| POST   | `/__reset`      | none     | Only when `ENABLE_TEST_RESET=on`. Clears all lock state and sessions. Returns 200 `reset`. Otherwise 404. |
| any    | anything else   | none     | 404 with a plain page. |

Flash messages travel in a one-time cookie named `flash` across the redirect, and the page that shows them clears it. A client must keep cookies (browsers and Playwright do; for curl use `-c jar -b jar -L`).

## Selectors and messages

### Flash element (all messages)

One element shows every message: `<div id="flash">`, with class `success` or `error`. When there is no message it is an empty `<div id="flash"></div>`. No other element on the page has id `flash`.

| Situation                         | Text                                        | Class     |
|-----------------------------------|---------------------------------------------|-----------|
| Successful login                  | `You logged into a secure area!`            | `success` |
| Logout                            | `You logged out of the secure area!`        | `success` |
| Unknown username                  | `Your username is invalid!`                 | `error`   |
| Known username, wrong password    | `Your password is invalid!`                 | `error`   |
| Account locked                    | `Your account is locked. Try again later.`  | `error`   |
| No session on a protected page    | Redirect to `/login`, no flash message      | none      |

### Login page (`/login`)

| Element         | Selector / detail |
|-----------------|-------------------|
| Heading         | `h1` with text "Login Page" |
| Form            | `#login`, `method="post"`, `action="/login"` |
| Username input  | `#username`, `name="username"`, type `text` |
| Password input  | `#password`, `name="password"`, `type="password"` |
| Submit button   | `#login button[type="submit"]` with text "Login". The form has exactly one. The button has no id. |

The inputs have no `required` attribute, so an empty submit reaches the server and shows the username error.

### Secure page (`/secure`)

| Element      | Selector / detail |
|--------------|-------------------|
| Heading      | `h1` with text "Secure Area" |
| Logout link  | `a[href="/logout"]` with text "Logout" (an anchor, not a button) |
| Appointments | `a[href="/appointments"]` |
| Banner       | `#flash.success`. Present in the first HTML response, unless `FLAKY_BANNER=on` (see below). |

### Appointments page (`/appointments`)

| Element      | Selector / detail |
|--------------|-------------------|
| Heading      | `h1` with text "Appointments" |
| Items        | `li.appointment` (with `data-appointment-id` 1-3) |
| Checkboxes   | `#appointment-1`, `#appointment-2`, `#appointment-3`, each labelled "Confirm appointment" via `<label for>` |
| Save button  | `#appointments button[type="submit"]` with text "Save" |
| Status line  | `#appointment-status`, reading `Confirmed: N of 3` |

Checking a box and pressing **Save** posts the form. The page reloads with the saved state, and the status line reflects it. Saved state is kept in memory per session and survives a reload. It resets on logout, because logout ends the session. The page needs no JavaScript.

## Login and lock behaviour

- An unknown username or a wrong password is a failed attempt and counts toward the lock for the username that was entered.
- Correct credentials on an unlocked account succeed and reset the failure count to zero.
- After `LOCK_THRESHOLD` consecutive failures, that username is locked for `LOCK_MINUTES`. The attempt that reaches the threshold still shows its normal error. The next attempt shows the locked message.
- While locked, every attempt (including the correct password) shows "Your account is locked. Try again later." and does not count as a new failure.
- When the lock period has passed, the account unlocks and the failure count resets.
- Lock state is per username and kept in memory. Restarting the server, or `POST /__reset` when enabled, clears it.

## Configuration

| Variable            | Default | What it does |
|---------------------|---------|--------------|
| `PORT`              | `3000`  | Port the server listens on. |
| `LOCK_THRESHOLD`    | `3`     | Consecutive failed logins before the account locks. |
| `LOCK_MINUTES`      | `1`     | How long the lock lasts, in minutes. Fractions work, for example `0.1` is 6 seconds. |
| `FLAKY_BANNER`      | off     | Set to `on` to insert the login success banner on `/secure` with a client-side script after a random 0-1500 ms delay. |
| `ENABLE_TEST_RESET` | off     | Set to `on` to expose `POST /__reset`, which clears all lock state and sessions between test runs. |

Invalid or non-positive values for `LOCK_THRESHOLD` and `LOCK_MINUTES` fall back to the defaults.

### Notes for trainers

- **`LOCK_THRESHOLD` is a configuration value, not a decided requirement.** The trainer can change it. Tests should not hard-code `3` without saying where it comes from.
- **`FLAKY_BANNER` is off by default** and is intended for the advanced layer of the exercise. With it on, the login always succeeds and the banner always appears. Only the time it takes to appear varies. The banner element is not in the initial HTML. A test that reads it without waiting fails sometimes; a test that waits for it (for example Playwright's `expect(locator).toBeVisible()`) passes every time. The banner needs JavaScript; every other page works with JavaScript disabled.
- **Plain-text passwords are for training only.**
