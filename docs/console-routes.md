# Console routes

The lab console (`dashboard/`) is a single-page app with real addresses. The Worker
(`dashboard/src/worker.js`) serves `index.html` for any address that is not a file once the
password gate is passed (`assets.not_found_handling: "single-page-application"`); the app reads
`location.pathname` and shows the screen it names.

The table lives in `dashboard/src/routes.js` (`parseRoute`, `buildRoute`, `routeTitle`, all pure and
unit tested), the History API glue in `dashboard/src/router.js`, and what each route shows in
`applyRoute` in `dashboard/src/app.js`.

## The table

| Address | Screen |
| --- | --- |
| `/` | The launcher (all paths). Also: a bare `/` walks back into the lab this browser was in (see below). |
| `/paths/<path>` | The launcher scrolled to that learning path. `<path>` is the path's slug from the catalogue (`other` for labs that belong to none). |
| `/paths/<path>/modules/<n>` | ... or to module `n` of it (opened, if it was condensed). |
| `/onboarding` | The platform quiz. With no quiz published it becomes `/`. |
| `/labs/<slug>` | The lab's entry: its first "Before you begin" step. A lab with nothing to read lands on the launcher at its card (nothing is started). |
| `/labs/<slug>/story` `/questions` `/lessons` | The steps before the lab starts: the story, then rounds of questions (`/questions`) alternating with chunks of lessons (`/lessons`). Without `?step=` each is the first step of its kind. A kind the lab does not have falls to the closest one it does. |
| `/labs/<slug>/questions?step=N` `/lessons?step=N` | The N-th step of the whole flow (1-based, as in "Step N of M"; the story is step 1 when there is one): a later round or lesson chunk. A number in range wins over the path word; one that is not a plain number from 1 to 999, or is past the last step, opens the first step. The address is corrected to the step actually shown. The first step of a kind has no `?step=` (so the simple labs keep `/story`, `/questions`, `/lessons`). `step` is the flow's own parameter: it is never carried to another screen, and other query parameters are kept. |
| `/labs/<slug>/session` | Starts the lab, or rejoins it when it is running (same as Start / Rejoin). Boot and ended states live here too. |
| `/labs/<slug>/session/brief` `questions` `hints` `checks` `solution` | The guide's tabs. |
| `/labs/<slug>/session/terminal` `editor` | The workspace window's tabs. |
| `/labs/<slug>/session/service/<name>` | A service's tab. |
| anything else | An in-app "Page not found" screen with a link back to the labs. The HTTP status stays 200 (the SPA fallback); `document.title` says "Not found". |

A tab the lab does not have, or one that does not exist (`/session/nope`), replaces the address
with `/labs/<slug>/session`. An unknown lab, at any of its addresses, is "not found".

Slugs are `^[a-z0-9][a-z0-9-]{0,80}$`; anything that does not fit (`..`, `%2e%2e`, `a//b`,
unicode, 82 characters) is "not found", never an error. Trailing slashes mean nothing. The query
string is kept from one address to the next.

**An address names a lab and a place in it, never a session.** No session id and no token is ever
put in one, so a link is safe to share: with no running session it starts the lab, with one
running it rejoins it. (If a different lab is running, you land in that one, with its own address
and a toast saying so; that is what Start has always done.)

## History

- Entering a step, the session, or the launcher from a button **pushes** an address.
- Tabs inside the session **replace** it in place, so Back does not step through every tab. Only a
  tab the learner chose is written; the guide's first tab and the explore lab's landing service are not.
- Every step of the flow pushes its own address, so the browser's Back walks the flow back one step (a round at its first unanswered question, or at its last when everything is answered) and Forward walks on; the answers are kept, so nothing is asked twice. A refresh on a step comes back to that step with the plan and answers this tab had (`sessionStorage`, `opalix.flow.<slug>`); with none (a new tab, a link sent to someone else) the flow is planned afresh and the step number is read against the new plan.
- Back out of a running lab goes to wherever the learner came from (the lessons, or the launcher).
  The lab is **not** ended: the launcher shows its "Pick up where you left off" card with Rejoin.
  Forward rejoins it without starting another.
- Ending the lab, "Back to labs" and the boot failure screen **replace** the session address with
  `/`, so Back cannot lead to a lab that is gone.
- A bare `/` with a remembered running lab (a fresh tab, a bookmark) walks back into it, as it always
  did; the lab's address is then pushed one step on from `/`. A learner who just left a lab with Back
  stays on the launcher on refresh (a per-tab flag, `opalix.leftSession` in sessionStorage).
- `/labs/<slug>/session` when the remembered session has *ended* does not start a new container on a
  refresh: it lands on the lab's card at `/labs/<slug>`.

## Phones

Starting or rejoining a lab is gated on a wide screen (`device.js`). On a phone, `/labs/<slug>/session`
shows the desktop notice, whose email and copy links are that lab's own address
(`/labs/<slug>`; the console's `/` when no lab is involved). Reading (the steps, the launcher) works.
Widening the window brings the address's own screen (the lab starts).

## Signing in

The Worker answers any address with the sign-in form (status 200, at the address that was asked for)
while there is no cookie, and names the page to return to in `<meta name="return-to">`. The page's
`login.js` goes there after a successful sign-in.

The target is `safeReturnPath` (`dashboard/src/return-path.js`): a path that starts with exactly one
`/`, with no backslash or control character (raw or percent-encoded), that is still a single-slash
path after dot segments are resolved (`/.//evil.example` is refused), and is not the Worker's own
(`/api`, `/auth`, `/dist`, `/login.js`); its query is kept, minus `next`. Anything else is `/`.
`?next=<path>` is accepted by the same rule (a bad one means `/`, never "whatever else is in the
URL"). `login.js` checks the value once more before it navigates. Unit tests cover the open-redirect
cases (`test/unit/console-return-path.test.ts`, `test/unit/console-worker.test.ts`) and
`test/e2e/20-routes.spec.ts` runs the real Worker in front of the static files.

## Titles and screen readers

| Screen | `document.title` |
| --- | --- |
| launcher, paths | `Opalix labs` |
| lab entry, story | `<Lab title> · Opalix labs` |
| questions (every round) | `Quick questions · <Lab title> · Opalix labs` |
| lessons (every chunk) | `Lessons · <Lab title> · Opalix labs` |
| session | `Session · <Lab title> · Opalix labs` |
| not found | `Not found · Opalix labs` |

Each screen moves focus to its heading (the steps through `before-you-begin.js`, which also says
"Step n of m" in a polite live region; the launcher's hero heading; the not-found heading; the
desktop notice's heading). Route changes the steps do not announce themselves (the launcher, a
session, not found) are said through `#routeLive`.

## Files

`index.html` references every asset with an absolute path (`/dist/app.js`, `/styles.css`): a relative
one would resolve under `/labs/<slug>/` and be answered with the app's own HTML by the fallback.
Specs 16 to 20 serve the files through `test/e2e/console-server.ts`, which has the same fallback
(and can put the real Worker in front for the password gate).
