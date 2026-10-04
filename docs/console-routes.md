# Console routes

The lab console (`dashboard/`) is a single-page app with real addresses. The Worker
(`dashboard/src/worker.js`) serves `index.html` for any address that is not a file once the
password gate is passed (`assets.not_found_handling: "single-page-application"`); the app reads
`location.pathname` and shows the screen it names.

The table lives in `dashboard/src/routes.js` (`parseRoute`, `buildRoute`, `routeTitle`, all pure and
unit tested), the History API glue in `dashboard/src/router.js`, and what each route shows in
`applyRoute` in `dashboard/src/app.js`. What the pages are made of (paths, modules, trail, scope of
the filters) is `dashboard/src/launcher-model.js`.

## The table

| Address | Screen |
| --- | --- |
| `/` | **Home**: one card per learning path (title, a line about it, module and lab counts, progress) and nothing else: no modules, no lab list. Carries the "lab running" card. Above the cards, when the service has something to say (a failed call just leaves them out): a "Your path" band (next lab with its reason, the three steps after it, time left, "See the whole path"; or "Make my path" for a learner who took the quiz before paths) and a "Your progress" band (overall score and level, XP, streak, top three skills, last three awards, "View profile"; a new learner sees "Finish a lab to start your score."). Also: a bare `/` walks back into the lab this browser was in (see below). |
| `/paths/<path>` | **A path**: its modules as cards, each opening the module's page. `<path>` is the path's slug from the catalogue (`other` for labs that belong to none). A path with no module cards (one implicit module) lists its labs here instead. |
| `/paths/<path>/modules/<n>` | **A module**: on the left its number, title, intro, "You will learn to" and a progress meter; on the right its labs as rows (number, title, level and time chips, Start / Resume / Locked with its reason, and an "About this lab" link). For a path with no module cards the address leads to the path's page. |
| `/onboarding` | The platform quiz. With no quiz published it becomes `/`. It ends with two questions that build the learner's path: "What are you aiming for?" (be ready for a role / learn a specific skill / explore, and an optional goal line of up to 200 characters) and "How many hours a week can you give this?" (2, 4, 6, 10 or any whole number from 1 to 20). Both start from what was answered last time (or Explore and 4 hours), so they can always be passed; "Skip these questions" sends that. When they are done the console calls `PUT /api/path-inputs` with `{ areas, goal_text?, goal_kind, hours_per_week }` (`areas` is the quiz result, `ok` as the console spells it); a failure is silent and the path is simply not shown. A retake sends it again, which rebuilds the path. The last screen ("Where to start") names one area to begin with (the first that is new, else the first that is familiar, else the first), says why from the learner's own answer, recaps the goal with a "Change" link back to the goal question, and lists what they told us, one plain line per area, with no module numbers. "Start with <area>" leaves the quiz for `/paths/<path>/modules/<n>` (home when that page does not exist), "See my personal path" (shown once the save above succeeded) for `/paths/mine`, and "Browse all labs" for `/`; each replaces the quiz in the history. |
| `/profile` | **Profile**: level, XP bar and streak, the overall score, a card per skill (score ring, level name, the plain evaluation, labs done, "Next lab") and the awards shelf (earned, then locked with `have/need`). Reads `GET /api/profile` (with `?starting=` from the quiz result held in the browser). Header link "Profile". |
| `/paths/mine` | **Your path**: the learner's own ordered labs with each step's state in words (Done, Next up, Coming up, Locked), the reason for it, its area, its time and Start / Resume / "Part of the paid plan". "Recompute" (`POST /api/path?force=1`) and "Change my goal" (the same two questions, then `PUT /api/path-inputs`). `mine` is reserved among the paths' slugs. With no goal yet the page asks the two questions. |
| `/labs/<slug>` | **A lab's own page**: title, chips, summary, objectives, prerequisites (and whether each is passed), and Start / Resume / Locked. Archived labs have one too (they are only left out of the lists). |
| `/labs/<slug>/story` `/questions` `/lessons` | The steps before the lab starts: the story, then rounds of questions (`/questions`) alternating with chunks of lessons (`/lessons`). Without `?step=` each is the first step of its kind. A kind the lab does not have falls to the closest one it does. A lab with nothing to read has no steps: these addresses become `/labs/<slug>`. |
| `/labs/<slug>/questions?step=N` `/lessons?step=N` | The N-th step of the whole flow (1-based, as in "Step N of M"; the story is step 1 when there is one): a later round or lesson chunk. A number in range wins over the path word; one that is not a plain number from 1 to 999, or is past the last step, opens the first step. The address is corrected to the step actually shown. The first step of a kind has no `?step=` (so the simple labs keep `/story`, `/questions`, `/lessons`). `step` is the flow's own parameter: it is never carried to another screen, and other query parameters are kept. |
| `/u/<user>/labs/<slug>/session/<session>` | **A session**: the lab's workspace, as the learner whose id is `<user>` has it, for the session `<session>`. |
| `/u/<user>/labs/<slug>/session/<session>/brief` `questions` `hints` `checks` `solution` | The guide's tabs. |
| `/u/<user>/labs/<slug>/session/<session>/terminal` `editor` | The workspace window's tabs. |
| `/u/<user>/labs/<slug>/session/<session>/service/<name>` | A service's tab. |
| `/labs/<slug>/session[/<tab>]` | The **old** session address, still honoured: it starts the lab, or rejoins it when it is running (same as Start / Resume), and, once the session's id is known, is replaced (not pushed) with the new address, keeping its tab and its query. |
| anything else | An in-app "Page not found" screen with a link back to the labs. The HTTP status stays 200 (the SPA fallback); `document.title` says "Not found". |

Every page below Home has a breadcrumb trail, a `nav` landmark labelled "Breadcrumb":
Home > Path > Module > Lab (a lab on a path with no module cards, or an archived lab, skips what it
does not have). The page itself is the last item, `aria-current="page"` and not a link.

A tab the lab does not have, or one that does not exist (`.../session/<session>/nope`), replaces the
address with the session's own. An unknown path, module or lab, at any of its addresses, is "not found".

Slugs are `^[a-z0-9][a-z0-9-]{0,80}$`; anything that does not fit (`..`, `%2e%2e`, `a//b`,
unicode, 82 characters) is "not found", never an error. `<user>` and `<session>` are opaque ids,
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Trailing slashes mean nothing. The query string is kept from one
address to the next.

## Search and filters

Search and the difficulty / family / status chips act on **the labs of the page that is open**: every
lab on Home, a path's on its page, a module's on its page; there are none on a lab's own page. A card
(or a row) with nothing that matches is left out, the count line reads "x of y labs" for that page,
and a card says how many of its labs match. The choice is one per browser (`localStorage`,
`opalixFilters`), as before, so it follows the learner from page to page. A deep link whose labs a
saved search would hide opens with the search cleared. Archived labs are in no list, count or match.

## The learner and the session in an address

`GET /api/me` answers `{ sub, user_id, can_admin }` (and `admin_url` when `can_admin` is true; see "Admin mode" below). `user_id` is the **opaque id** the Worker hands out for the
cookie's subject: the subject itself when it is already a plain token (today the console's one
subject is `console`), otherwise `u-` and 24 hex digits of its SHA-256, so an email never reaches a URL.
It is a label, not a credential: the API is still called with the subject, and the session token (held
in memory and `localStorage`, never in an address) is what every session call carries.

A session address is honoured only when:

1. its `<user>` is the signed-in learner's `user_id` (any other id, or no id, is "not found" and nothing
   is asked of the API);
2. its `<session>` is the learner's active session for that lab. This browser's own session is checked
   against the API with its token. Otherwise (a fresh browser, a link sent over) `GET /api/sessions/active`
   (`{ sessions: [{ id, lab, state }] }`, no tokens, no user) says which sessions are the learner's, and if
   the address names one for this lab, `POST /api/start` (which rejoins) hands out a token.

Anything else shows **"This session is not active"** with **Back to labs** (`/`) and, when the learner
has a *different* active session for that lab, **Rejoin**. Rejoin replaces the address with that
session's id. A phone is told labs need a desktop first, as for any start.

A refresh on a session address re-enters the same session (the remembered token is used; nothing is
started). A session's tabs replace the address in place and keep both ids.

## History

- Entering a step, the session, or a page from a link or a button **pushes** an address.
- Tabs inside the session **replace** it in place, so Back does not step through every tab. Only a
  tab the learner chose is written; the guide's first tab and the explore lab's landing service are not.
- Every step of the flow pushes its own address, so the browser's Back walks the flow back one step (a round at its first unanswered question, or at its last when everything is answered) and Forward walks on; the answers are kept, so nothing is asked twice. A refresh on a step comes back to that step with the plan and answers this tab had (`sessionStorage`, `opalix.flow.<slug>`); with none (a new tab, a link sent to someone else) the flow is planned afresh and the step number is read against the new plan.
- "Back to labs" in the steps goes to the lab's page (a step on in history). Start on a lab's page (or row)
  pushes the first step, so Back from it is the lab's page.
- Back out of a running lab goes to wherever the learner came from (the lessons, or the lab's or module's page).
  The lab is **not** ended: its row and page say **Resume**, and Home shows its "Pick up where you left
  off" card with Rejoin. Forward rejoins it without starting another. The header's "← Back to labs" in a
  running lab does the same, to the lab's page.
- Ending the lab, "Back to labs" on an ended session and the boot failure screen **replace** the session
  address with the lab's page (`/labs/<slug>`), so Back cannot lead to a session that is gone.
- A bare `/` with a remembered running lab (a fresh tab, a bookmark) walks back into it, as it always
  did; the session's address is then pushed one step on from `/`. A learner who just left a lab with
  Back stays on Home on refresh (a per-tab flag, `opalix.leftSession` in sessionStorage).
- `/labs/<slug>/session` when the remembered session has *ended* does not start a new container on a
  refresh: it lands on the lab's page at `/labs/<slug>`.
- A session address whose session has ended is "not active" (its record is dropped), never a restart.

## Phones

Starting or rejoining a lab is gated on a wide screen (`device.js`). On a phone, a session address
shows the desktop notice, whose email and copy links are that lab's own page (`/labs/<slug>`; the
console's `/` when no lab is involved). Reading (the pages, the steps) works. Widening the window brings
the address's own screen (the lab starts).

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
| home | `Opalix labs` |
| profile | `Your profile · Opalix labs` |
| your path | `Your path · Opalix labs` |
| a path | `<Path title> · Opalix labs` |
| a module | `<Module title> · <Path title> · Opalix labs` |
| a lab's page, the story | `<Lab title> · Opalix labs` |
| questions (every round) | `Quick questions · <Lab title> · Opalix labs` |
| lessons (every chunk) | `Lessons · <Lab title> · Opalix labs` |
| session | `Session · <Lab title> · Opalix labs` |
| session not active | `Session not active · Opalix labs` |
| not found | `Not found · Opalix labs` |

Each screen moves focus to its heading (the steps through `before-you-begin.js`, which also says
"Step n of m" in a polite live region; Home's hero heading, a path's, a module's and a lab's `h1`; the
not-found and not-active headings; the desktop notice's heading). Route changes the steps do not
announce themselves are said through `#routeLive` (Home says "Labs", the other pages their title).
The first page of a load is not focused or announced: nothing moves under a reader who has just arrived.

## Files

`index.html` references every asset with an absolute path (`/dist/app.js`, `/styles.css`): a relative
one would resolve under `/labs/<slug>/` and be answered with the app's own HTML by the fallback.
Specs 16 to 20 serve the files through `test/e2e/console-server.ts`, which has the same fallback
(and can put the real Worker in front for the password gate). `test/e2e/browse.ts` has what they share
for getting around the pages.

## Admin mode (the owner's developer view)

A switch labelled "Admin" in the header, beside the theme toggle, for the owner to use while developing. It is
a **client-side view mode**: it never grants server-side power. The API and the graders stay gated by the
service key and per-session tokens, and a session was already startable by lab slug (`createSession` checks
neither a plan tier nor a prerequisite), so nothing the API accepts changes.

**Who is shown the switch** is the one thing the Worker decides. `GET /api/me` carries `can_admin`, true only
when the signed-in subject is listed in the Worker var `CONSOLE_ADMIN_SUBJECTS` (a comma list, spaces ignored,
exact match; unset it is `console`, today's one subject, the owner; set to an empty string nobody is an admin).
`admin_url` (the Worker var `ADMIN_URL`, default `https://opalix-admin.soubenz94.workers.dev`, https or
localhost only) is sent only to an admin. **When real accounts arrive, their subjects (an email, say) must be
listed in `CONSOLE_ADMIN_SUBJECTS` by hand**, or they never see the switch. Without `can_admin: true` the
switch is not built at all, and a stored "on" is ignored and removed.

When on (kept in `localStorage` `opalixAdminMode`; code in `dashboard/src/admin-mode.js` and
`dashboard/public/admin-mode.css`, with one-line hooks in `app.js` and `path-view.js`):

- the header shows a persistent "Admin mode on" pill (a dashed ring, an icon and words), the page edge carries
  a dashed ring, and an "Admin panel" link opens the admin Worker in a new tab;
- a lab (a row, its page, its session address) or a path step locked by a prerequisite or by the plan is
  startable. The lock is still shown, as "Locked for learners — open anyway (admin)";
- the screens before a lab have "Admin: skip to Start", which presses "Skip all, just start the lab";
- the session screen has a collapsible Admin strip under the dock: session id, user id, lab and version, state
  and expiry (each with a Copy button) and the live event log. The session token is never shown or copied: the
  strip is built from named fields, and the log scrubs anything named like a credential and the token itself.
