# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 07-terminal.spec.ts >> the terminal >> attaches and echoes what the learner types
- Location: test/e2e/07-terminal.spec.ts:4:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=f2e1]:
  - banner [ref=f2e2]:
    - generic [ref=f2e3]:
      - text: ▣
      - strong [ref=f2e4]: Opalix
      - text: lab console
    - generic [ref=f2e5]:
      - generic [ref=f2e6]: running
      - generic [ref=f2e7]: hello
      - generic [ref=f2e8]: 01m3a45ev7ke4qxjsab8h0tzx0
      - generic "Time until the hard timeout" [ref=f2e9]: 59:26 left
    - generic [ref=f2e10]:
      - button "Run checks" [ref=f2e11] [cursor=pointer]
      - button "Snapshot" [ref=f2e12] [cursor=pointer]
      - button "End session" [ref=f2e13] [cursor=pointer]
      - button "Operator" [ref=f2e14] [cursor=pointer]
  - main [ref=f2e15]:
    - complementary [ref=f2e16]:
      - generic [ref=f2e17]:
        - heading "Checks" [level=2] [ref=f2e18]
        - paragraph [ref=f2e20]: Not run yet.
      - generic [ref=f2e21]:
        - heading "Hints" [level=2] [ref=f2e22]
        - paragraph [ref=f2e24]: Hints unlock on a timer.
      - generic [ref=f2e25]:
        - heading [level=2] [ref=f2e26]:
          - text: Workspace
          - button "↻" [ref=f2e27] [cursor=pointer]
        - list [ref=f2e28]:
          - listitem [ref=f2e29] [cursor=pointer]:
            - generic [ref=f2e30]: brief.md
            - generic [ref=f2e31]: 180 B
          - listitem [ref=f2e32] [cursor=pointer]:
            - generic [ref=f2e33]: index.html
            - generic [ref=f2e34]: 945 B
          - listitem [ref=f2e35] [cursor=pointer]:
            - generic [ref=f2e36]: README.md
            - generic [ref=f2e37]: 65 B
    - generic [ref=f2e38]:
      - navigation [ref=f2e39]:
        - button "Terminal" [ref=f2e40] [cursor=pointer]
        - button "Editor" [ref=f2e41] [cursor=pointer]
        - button "echo" [ref=f2e43] [cursor=pointer]
      - generic [ref=f2e48]:
        - generic:
          - textbox "Terminal input" [active]
    - complementary [ref=f2e90]:
      - generic [ref=f2e91]:
        - heading "Events 4" [level=2] [ref=f2e92]:
          - text: Events
          - generic [ref=f2e93]: "4"
        - list [ref=f2e94]:
          - listitem [ref=f2e95]:
            - generic [ref=f2e96]: 16:32:22
            - generic [ref=f2e97]: terminal
            - generic [ref=f2e98]: Terminal disconnected.
          - listitem [ref=f2e99]:
            - generic [ref=f2e100]: 16:32:22
            - generic [ref=f2e101]: session.state
            - generic [ref=f2e102]: running
          - listitem [ref=f2e103]:
            - generic [ref=f2e104]: 16:32:22
            - generic [ref=f2e105]: service.health
            - generic [ref=f2e106]: "echo: healthy"
          - listitem [ref=f2e107]:
            - generic [ref=f2e108]: 16:32:18
            - generic [ref=f2e109]: session.state
            - generic [ref=f2e110]: starting
  - contentinfo [ref=f2e111]:
    - generic [ref=f2e112]: API https://opalix-sandbox.soubenz94.workers.dev
    - button "change" [ref=f2e113] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect, consoleErrorsFor, upgradeHeaderStripped } from './fixtures';
  2  | 
  3  | test.describe('the terminal', () => {
  4  |   test('attaches and echoes what the learner types', async ({ session }) => {
  5  |     await session.locator('.tab[data-view="terminal"]').click();
  6  |     await expect(session.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 });
  7  | 
  8  |     // Let the shell draw its prompt before typing, or the first keystrokes
  9  |     // land before the PTY is listening.
  10 |     await session.waitForTimeout(2500);
  11 |     await session.locator('.xterm-screen').click();
  12 |     await session.keyboard.type('echo playwright-terminal-ok');
  13 |     await session.keyboard.press('Enter');
  14 | 
  15 |     const echoed = await session
  16 |       .waitForFunction(
  17 |         () => document.querySelector('.xterm-screen')?.textContent?.includes('playwright-terminal-ok'),
  18 |         null,
  19 |         { timeout: 30_000 }
  20 |       )
  21 |       .then(() => true)
  22 |       .catch(() => false);
  23 | 
  24 |     // Only skip on the specific evidence of a stripped handshake: a
  25 |     // genuinely broken terminal must still fail.
  26 |     test.skip(
  27 |       !echoed && upgradeHeaderStripped(consoleErrorsFor(session)),
  28 |       'the network between here and the API strips the WebSocket Upgrade header'
  29 |     );
> 30 |     expect(echoed).toBe(true);
     |                    ^ Error: expect(received).toBe(expected) // Object.is equality
  31 |   });
  32 | 
  33 |   test('renders an xterm viewport sized to its pane', async ({ session }) => {
  34 |     await session.locator('.tab[data-view="terminal"]').click();
  35 |     const screen = session.locator('.xterm-screen');
  36 |     await expect(screen).toBeVisible({ timeout: 30_000 });
  37 | 
  38 |     const box = await screen.boundingBox();
  39 |     expect(box?.width ?? 0).toBeGreaterThan(200);
  40 |     expect(box?.height ?? 0).toBeGreaterThan(100);
  41 |   });
  42 | });
  43 | 
```