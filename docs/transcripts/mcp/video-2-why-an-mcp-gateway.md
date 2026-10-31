# Video 2. Why an MCP gateway?

458 spoken words, about 2:42 at 170 words a minute (page pauses come on top).

## Scene 1: Two hundred lines

1. **Hook.** Ten AI agents, twenty MCP servers, each wired to all: two hundred connections, each with its own secret. One box in the middle, and it needs thirty. So where did the other hundred and seventy go?
2. **Zoom in: three by five.** To see where, lift the box out and frame three agents, named Support, Billing and Ops, against five servers: weather, calculator, orders, docs, maps. Fifteen lines, redrawn one by one.
3. **What each line costs.** Each line is an address and a credential, a secret proving who asks, kept in the agent. Fifteen across three agents, and a sixth server changes all three again. Who should hold them instead?

## Scene 2: One program in the middle

4. **An MCP gateway.** Between the same three agents and five servers, one program: an MCP gateway. A gateway is a proxy: it receives each call and passes it to the owning server. How does it learn the servers?
5. **Registration.** An operator registers each server once, by name and address, this card; the servers stay unchanged. The gateway connects to each, these five lines, and fetches each menu with tools/list. Where do five menus go?
6. **Catalogue and two faces.** Into one list, its catalogue. Towards the servers the gateway acts as an MCP client; towards the agents, wired to it with three lines, it looks like one MCP server. One tools/list from Support returns every tool in one reply.
7. **One address, one credential.** So each agent keeps one address, the gateway's, and one credential, its own badge. The five secrets move in here, and a sixth server is registered once, touching no agent. Three plus five: eight connections, not fifteen.
8. **One place to watch.** Every call crosses that point, so the gateway writes a row for each: the tool, the time, how long it took, whether it worked and, read off the badge, who asked. Here, Ops, 2.4 seconds.
9. **What it is not.** Two things it is not. It runs no tools, the servers do; it chooses none, the model does. Nor an AI gateway: that carries calls to language models. What does one look like in the lab?

## Scene 3: In the lab

10. **One tools/list.** In the lab the MCP gateway is ContextForge, IBM's open-source gateway, with two toy MCP servers registered. One tools/list to its address returns five tools, each carrying a prefix, the registered server's name, so two servers' tools never collide.
11. **One row in the lab.** Then calculator-tools-add, seventeen plus twenty-five, returns forty-two, and the view tab shows a new row: tool, time, success, response time. No caller column: every scripted lab call is the same admin identity.

## Scene 4: Recap

12. **Four changes on one picture.** Focus on what changed. One, each server registered once. Two, one address per agent. Three, one credential each, the secrets behind the gateway. Four, one row per call. Ten agents, twenty servers: thirty connections, not two hundred.
13. **Call to action.** Open the lab, See how tools reach an agent, and find your own calls in the view tab. Next: every agent sees every tool in that catalogue, including one that moves money.
