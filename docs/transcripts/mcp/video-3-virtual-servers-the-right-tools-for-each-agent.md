# Video 3. Virtual servers: the right tools for each agent

437 spoken words, about 2:34 at 170 words a minute (page pauses come on top).

## Scene 1: Support's menu

1. **Hook.** Each AI agent should see only the tools it needs, without a separate server for each one. Here one catalogue of twelve tools feeds three agents, every menu shows all twelve, and Support can see issue_refund. What should Support's menu look like?
2. **A virtual server.** Five of the twelve. Pick the five Support needs into a box named support-tools, with its own address. That is a virtual server: a named pick of the catalogue's tools at its own address, and to Support it looks like one MCP server. issue_refund stays outside.
3. **Why one chip matters.** Because the model inside Support picks from whatever menu it is given, a refund was one wrong choice away, and issue_refund moves real money. Support only ever needed the weather tools and the calculator. Who else needs a box, and can two boxes share a tool?

## Scene 2: Two boxes, one catalogue

4. **Billing's box.** The catalogue again, support-tools beside it, and a second box for Billing, billing-tools, which does hold issue_refund, next to add. Add sits in both, one line from the same catalogue entry: a virtual server points at tools; it copies nothing and runs nothing. What does Support actually see?
5. **What the agent sees.** Support sees one address and, per tool, the name, description and input schema from the first video. Only the gateway knows the rest: the owner server, the original name, its address and the credential. So how does a call from Support find the weather server?
6. **Routing one call.** Support calls weather-tools-get-weather for Leeds. The gateway splits the name: weather-tools, the prefix from the last video, names the server; get_weather is the original name. Once looked up, the call goes on to the weather server as get_weather, Leeds. Support never sees where.
7. **A menu is not a lock.** One warning. Leaving issue_refund out only shortens Support's menu. It is a lock only if Support's credential is limited to that virtual server and Support cannot reach the orders server directly, this dashed line. A shorter menu is not a lock. What does the lab leave out?

## Scene 3: In the lab

8. **toy-tools.** Nothing. The lab's virtual server, toy-tools, holds all five tools of both toy servers, each with its prefix, and every scripted call carries the same admin identity. The lab shows the menu, not the lock.

## Scene 4: Recap

9. **Four facts on one picture.** Focus on what just happened. One, the catalogue holds every tool. Two, a virtual server is a named pick at its own address. Three, it points at tools, copying nothing. Four, the gateway keeps what agents never see; and a shorter menu is not a lock.
10. **Call to action.** Open the lab, See how tools reach an agent, and count the tools toy-tools offers. Next: a tool call that comes back 200 OK with a failure written inside it, and the one line of code that misses it.
