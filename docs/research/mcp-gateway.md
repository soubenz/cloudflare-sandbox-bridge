# Research brief: MCP, MCP gateways and ContextForge

For the explainer videos of the lab `labs/see-how-tools-reach-an-agent` (path ai-platform,
module 2, "Tools and MCP"). Researched 2026-10-25 from primary sources: the MCP
specification and docs, the ContextForge source at tag `v1.0.10` (the version the lab
installs), the MCP Python SDK wheel ContextForge depends on, vendor documentation, and the
lab's own files. Every claim below has a source. Anything not confirmed is marked
**UNVERIFIED**.

The scripts built from this brief are in [mcp-gateway-scripts.md](mcp-gateway-scripts.md).

## 0. Versions that matter

| Thing | Version | Source |
|---|---|---|
| MCP specification, current revision | **2026-07-28** ("The current protocol version is 2026-07-28") | https://modelcontextprotocol.io/specification/versioning |
| Previous revision | 2025-11-25 (handshake-based) | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| ContextForge in the lab | `mcp-contextforge-gateway==1.0.10` (git tag `v1.0.10`, commit f5763448, 2026-09-07) | `labs/see-how-tools-reach-an-agent/manifest.yaml`; `git ls-remote https://github.com/IBM/mcp-context-forge` |
| Protocol version ContextForge 1.0.10 speaks by default | `protocol_version: str = "2025-11-25"` in `mcpgateway/config.py` | ContextForge source, tag v1.0.10 |
| MCP Python SDK ContextForge needs | `mcp>=1.28.1,<2`; SDK 1.28.1 has `LATEST_PROTOCOL_VERSION = "2025-11-25"` | ContextForge `pyproject.toml`; `mcp-1.28.1` wheel, `mcp/types.py` |
| Exact `mcp` SDK version installed in the lab image | `mcp==1.30.0` (used by the toy servers and by ContextForge); its `LATEST_PROTOCOL_VERSION` is also `"2025-11-25"`, and ContextForge answers `initialize` with `2025-11-25` even when asked for `2026-07-28` | `images/agent/requirements-contextforge.txt:48`, `images/agent/requirements-system.txt:63`; live run (§10, A13-A14) |

Consequence: the lab runs the **2025-11-25 era** of MCP. The current spec (2026-07-28)
removed the `initialize` handshake and protocol sessions. The videos therefore avoid
describing a handshake at all: it is not visible in the lab (`call_tool.py` sends
`tools/list` and `tools/call` directly, and ContextForge accepts them because it runs
Streamable HTTP in stateless mode, `use_stateful_sessions: bool = False`), and it no
longer exists in the current spec.

## 1. Glossary: the exact terms the videos use

Use these words, with these meanings, every time. Define each one in the sentence where it
first appears.

| Term (say it this way) | Meaning, in plain words | Never say |
|---|---|---|
| **language model** / **model** | The part that reads text and writes text. It chooses a tool by writing a request; it runs nothing. | "the AI runs the tool" |
| **agent** | The program around the model: keeps the conversation, asks the model what to do next, carries it out. In MCP terms the agent application is the **host**. | |
| **host** | MCP's name for the AI application that contains one or more MCP clients (spec: "LLM applications that initiate connections"). Mention once, in video 1. | |
| **MCP client** | The part inside the host that holds the connection to exactly one MCP server. | "the client is the model" |
| **MCP server** | A program that offers tools (and optionally resources and prompts) over MCP. Can run locally or remotely. | "tool server" as the main term (allowed once as a plain-English gloss), "plugin" |
| **tool** | A named function an MCP server offers, described by a name, a description and an input schema. | |
| **input schema** (`inputSchema`) | The JSON Schema listing the inputs a tool takes and their types. | |
| **`tools/list`** | The request that asks a server for its tools ("the menu"). | |
| **`tools/call`** | The request that runs one tool by name with arguments. | |
| **result**, **content** | A successful JSON-RPC reply carries a `result`; for a tool call its `content` array holds the output (usually text). `structuredContent` is the same output as JSON data. | |
| **JSON-RPC** | The message format MCP uses: a request has a `method` and `params`; a reply has either a `result` or an `error`. | |
| **protocol error** | A JSON-RPC `error` object (code + message) in place of a `result`. | |
| **tool execution error** / **tool error** | A normal `result` with `"isError": true` and a text message in `content`. | "exception", "crash" |
| **MCP gateway** | A proxy that sits between agents and many MCP servers: it looks like one MCP server to agents and acts as an MCP client to the real servers; it centralises registration, discovery, access, credentials and logging. | **"tool gateway"** (never), "AI gateway" (that is the model-traffic gateway) |
| **register** (an MCP server with the gateway) | An operator gives the gateway the server's name and URL; the gateway connects and discovers its tools. | "the server signs up" (the server does nothing) |
| **catalogue** | The gateway's list of everything it discovered from registered servers. ContextForge's UI also has a separate **MCP Registry** panel (a list of public servers you can add); do not mix the two. | |
| **virtual server** | ContextForge's (and the industry's) name for a named bundle of tools picked from the catalogue, exposed at its own MCP address. To an agent it is an ordinary MCP server. | "bundle" alone (use "bundle" only as the gloss) |
| **prefix** / **namespacing** | The gateway puts the registered server's name in front of a tool name so two servers' tools cannot collide: `get_weather` on `weather-tools` becomes `weather-tools-get-weather`. | |
| **ContextForge** | IBM's open-source MCP gateway and registry used in the lab. Its API calls a registered MCP server a **gateway**; its admin UI calls them **MCP Servers**. In narration, say "registered MCP server" and explain the API word only on screen. | |
| **Streamable HTTP**, **stdio** | The two standard transports: HTTP POST to one endpoint, or a local subprocess's standard input/output. | |

## 2. Facts per topic (MCP specification)

### 2.1 What MCP is, who runs it

- "MCP (Model Context Protocol) is an open-source standard for connecting AI applications to
  external systems." The official analogy: "Think of MCP like a USB-C port for AI
  applications." https://modelcontextprotocol.io/docs/getting-started/intro
- Introduced by Anthropic in November 2024; on 2025-12-09 Anthropic donated MCP to the
  Agentic AI Foundation, a directed fund under the Linux Foundation, co-founded with Block
  and OpenAI. https://anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ,
  https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
  Anthropic announced and open-sourced MCP on 25 November 2024 ("Published Nov 25, 2024";
  "Today, we're open-sourcing the Model Context Protocol"),
  https://www.anthropic.com/news/model-context-protocol (§10, B10).
- "MCP focuses solely on the protocol for context exchange—it does not dictate how AI
  applications use LLMs or manage the provided context."
  https://modelcontextprotocol.io/docs/learn/architecture

### 2.2 Architecture: host, client, server

Source: https://modelcontextprotocol.io/specification/2026-07-28/architecture and
https://modelcontextprotocol.io/docs/learn/architecture

- Hosts: "LLM applications that initiate connections"; clients: "Connectors within the
  host application"; servers: "Services that provide context and capabilities."
- "Each client is created by the host and communicates with exactly one server" (a 1:1
  relationship). One host, many clients.
- "MCP server refers to the program that serves context data, regardless of where it runs"
  (local over stdio, or remote over Streamable HTTP).
- Design principle: servers "should not be able to read the whole conversation, nor 'see
  into' other servers"; the full conversation stays with the host.
- The docs' own example: VS Code is a host; connecting to the Sentry MCP server creates one
  MCP client object; connecting to the filesystem server creates another.

### 2.3 Messages: JSON-RPC 2.0

- "The protocol uses JSON-RPC 2.0 messages." A request has `jsonrpc`, `id`, `method`,
  `params`; a response has either `result` or `error`.
  https://modelcontextprotocol.io/specification/latest
- Standard JSON-RPC codes used in examples: `-32601` Method not found, `-32602` Invalid
  params. https://www.jsonrpc.org/specification

### 2.4 Lifecycle and capabilities (two eras)

- **2025-11-25 (what the lab's software implements):** three phases, Initialization,
  Operation, Shutdown. The client "MUST initiate this phase by sending an `initialize`
  request" with protocol version, capabilities and client info; the server answers with its
  capabilities (`tools`, `resources`, `prompts`, ...) and `serverInfo`; the client then
  sends `notifications/initialized`. "The client SHOULD NOT send requests other than pings
  before the server has responded to the initialize request."
  https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- **2026-07-28 (current):** "Make MCP stateless: remove the `initialize` /
  `notifications/initialized` handshake. Every request now carries its protocol version and
  client capabilities in `_meta`." Servers MUST implement `server/discover`; clients MAY call
  it first. Protocol-level sessions and `Mcp-Session-Id` were removed.
  https://modelcontextprotocol.io/specification/2026-07-28/changelog
- A server that supports tools "MUST declare the `tools` capability".
  https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- In the lab: `call_tool.py` does no handshake and sends no `_meta`; ContextForge 1.0.10
  accepts this (stateless Streamable HTTP, JSON responses: `use_stateful_sessions = False`,
  `json_response_enabled = True` in `mcpgateway/config.py`). Do not present the lab's
  bare requests as fully spec-conformant for 2026-07-28 (which also requires the
  `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers).

### 2.5 Tools

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools (wording of
the essentials is the same in 2025-06-18 and 2025-11-25 unless noted).

- Tools are "model-controlled": the model discovers and invokes them based on context and
  the user's prompt. "There SHOULD always be a human in the loop with the ability to deny
  tool invocations."
- `tools/list` returns `tools`, each with `name`, optional `title`, `description`,
  `inputSchema` (a JSON Schema, MUST be a valid object), optional `outputSchema`, optional
  `annotations`. Supports pagination (`cursor`/`nextCursor`).
- The set returned "MAY vary by the authorization presented on the request — for example,
  returning only the tools the caller's granted scopes permit" (2026-07-28). This is the spec
  hook for per-agent tool lists.
- Naming: names SHOULD be 1-128 characters of `A-Z a-z 0-9 _ - .`, unique within a server.
  "Clients or proxies that aggregate tools from multiple servers MAY encounter naming
  collisions ... and SHOULD implement a disambiguation strategy such as prefixing tool names
  with a server identifier." This is exactly what ContextForge does.
- `tools/call` request: `params.name` and `params.arguments`. Result: `content` (array of
  text, image, audio, resource_link or embedded resource items), optional
  `structuredContent` (JSON matching `outputSchema` if one is given; "a tool that returns
  structured content SHOULD also return the serialized JSON in a TextContent block"),
  and `isError`.
- "Clients MUST consider tool annotations to be untrusted unless they come from trusted
  servers."
- Server MUSTs: validate inputs, implement access controls, rate limit invocations,
  sanitise outputs. Client SHOULDs include: confirm sensitive operations, show inputs before
  calling, "Implement timeouts for tool calls", "Log tool usage for audit purposes".

### 2.6 Errors: protocol errors vs tool execution errors

Source: the "Error Handling" section of the tools page, 2026-07-28 (and 2025-06-18 for the
older wording).

1. **Protocol errors** "indicate issues with the request structure itself that models are
   less likely to be able to fix: Unknown tool; Malformed requests (requests that fail to
   satisfy CallToolRequest schema); Server errors." They are standard JSON-RPC errors; the
   spec's example is `{"code": -32602, "message": "Unknown tool: invalid_tool_name"}`.
2. **Tool execution errors** "contain actionable feedback that language models can use to
   self-correct and retry with adjusted parameters: API failures; Input validation errors
   (e.g., date in wrong format, value out of range); Business logic errors." They are a
   normal `result` with `"isError": true` and a text `content`.
- "Clients MAY provide protocol errors to language models, though these are less likely to
  result in successful recovery. Clients SHOULD provide tool execution errors to language
  models to enable self-correction."
- Change to note: 2025-06-18 listed "Invalid arguments" under protocol errors; 2025-11-25 and
  2026-07-28 moved input validation errors to tool execution errors. Only arguments that
  break the `CallToolRequest` shape itself are protocol errors now.
- HTTP status: in 2025-11-25-era Streamable HTTP a request's reply (result or error) comes
  back as a normal JSON or SSE response; ContextForge returned HTTP 200 for both the
  successful call and the unknown-tool call in the lab. In 2026-07-28 some protocol errors
  have their own HTTP status: unknown method → `404` with `-32601`; unsupported protocol
  version and header mismatch → `400`.
  https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
  So the safe teaching line is: **HTTP 200 does not mean the tool worked; read the body.**
  Do not teach "every MCP error is HTTP 200".
- **The lab differs from the spec on one point.** A call to an unknown tool
  (`does-not-exist`) through ContextForge's virtual server returns HTTP 200 and a *tool
  execution error* (`"isError": true`, text `Tool not found: does-not-exist`), not the
  protocol error the spec lists. Why: ContextForge's Streamable HTTP handler
  (`mcpgateway/transports/streamablehttp_transport.py`, `call_tool`) re-raises the
  `ToolNotFoundError`, and the MCP Python SDK's low-level server turns any exception from a
  tool handler into an error result (`except Exception as e: return
  self._make_error_result(str(e))` in `mcp/server/lowlevel/server.py`, SDK 1.28.1). Other
  ContextForge code paths (`mcpgateway/main.py`, the plain JSON-RPC endpoint) do return a
  JSON-RPC error `-32601 "Tool not found: ..."` (`main.py:10578`, `:10808`). The videos must
  say which shape the lab shows and that the spec files this case differently. Re-checked
  2026-10-25 with the lab's pinned SDK, `mcp` 1.30.0 (same conversion,
  `mcp/server/lowlevel/server.py:589-590`), and against the 2026-07-28 tools page, which still
  lists "Unknown tool" under protocol errors (§10, A1, B1).
- **A misspelt method in the lab** (`tools/calll`) gets a real protocol error: HTTP 200 with
  `{"code":-32601,"message":"Method not found: tools/calll"}` and no `result`, answered by
  ContextForge itself (`transports/streamablehttp_transport.py:4848-4870`). The 2026-07-28
  spec would want HTTP 404 for this; ContextForge 1.0.10 is a 2025-11-25-era server (§10, A2).
- **Invalid arguments in the lab** (`{"a": "x"}` for `calculator-tools-add`) come back as a
  tool execution error (`isError: true`, a validation message from the toy server), matching
  the spec (§10, A4).

### 2.7 Transports

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports and
https://modelcontextprotocol.io/docs/learn/architecture

- **stdio**: "newline-delimited messages over the standard streams of a client-launched
  subprocess." Local, typically one client.
- **Streamable HTTP**: "each message is an HTTP POST to a single MCP endpoint; replies arrive
  as a JSON object or a request-scoped SSE stream." Remote, typically many clients.
  Servers MUST validate `Origin`; local servers SHOULD bind to 127.0.0.1.
- The lab: both toy servers and ContextForge's virtual server use Streamable HTTP
  (`mcp.run(transport="streamable-http")`, gateways registered with
  `"transport": "STREAMABLEHTTP"`, endpoint `/servers/<id>/mcp`; also served at
  `/v1/virtual-servers/<id>/mcp`, and the legacy HTTP+SSE stream at `GET /servers/<id>/sse`,
  §10 A11).
- The old HTTP+SSE transport (2024-11-05) is deprecated.

### 2.8 Resources, prompts and the rest (one line each)

Source: https://modelcontextprotocol.io/docs/learn/architecture

- **Resources**: "Data sources that provide contextual information to AI applications (e.g.,
  file contents, database records, API responses)"; read, not executed.
- **Prompts**: "Reusable templates that help structure interactions with language models";
  chosen by the user.
- **Elicitation**: lets a server ask the user for more input.
- **Sampling**, **Roots**, **Logging**: deprecated as of 2026-07-28.
- The lab uses tools only. The videos mention resources and prompts at most once.

### 2.9 Authorization (high level)

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

- "Authorization is OPTIONAL for MCP implementations." HTTP transports SHOULD follow it;
  stdio SHOULD NOT and gets credentials from the environment.
- Based on OAuth 2.1: a protected MCP server is an OAuth resource server; the MCP client is
  an OAuth client; a separate authorization server issues tokens. MCP servers MUST publish
  Protected Resource Metadata (RFC 9728); clients MUST send the `resource` parameter (RFC
  8707) naming the server; tokens go in `Authorization: Bearer`.
- Servers "MUST validate that access tokens were issued specifically for them" and "MUST NOT
  accept or transit any other tokens." Token passthrough (forwarding a client's token to a
  downstream API) is "explicitly forbidden".
  https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- The lab uses no OAuth: ContextForge runs in trusted-proxy mode, and every script sends the
  header `X-Authenticated-User: admin@example.com` (manifest.yaml). Every scripted call in the
  lab is the same admin identity. Because the lab sets `AUTH_REQUIRED=false`, the MCP endpoint
  also accepts a call with no header at all, as an anonymous caller with public-only access,
  and every lab tool is public; only the REST API answers such a call with 403 (§10, A17).
- Re-checked against 2026-07-28 (§10, B4-B6): token passthrough is still forbidden, and the
  spec's "confused deputy" is specifically an OAuth consent attack on MCP proxy servers
  ("MCP proxy servers **MUST** implement per-client consent").

## 3. The MCP gateway pattern

### 3.1 Definition (synthesised from the products below; consistent across all of them)

An **MCP gateway** is a proxy in the call path between MCP clients and many MCP servers. To
agents it presents one MCP endpoint (it "runs as a fully compliant MCP server", ContextForge
README); to the real servers it is an MCP client. Around that it centralises:

| Function | Who says so |
|---|---|
| One endpoint instead of one per server | ContextForge ("federates tools, agents, and APIs into one clean endpoint"); Cloudflare ("centralizes multiple MCP servers onto a single HTTP endpoint"); Docker ("With the MCP Gateway, you configure applications to connect to the Gateway"); agentgateway (multiplexing, "One MCP server whose `tools/list` response federates the tools of every target"); Kong (listener mode, "a single MCP endpoint that aggregates tools"); Microsoft (`POST /mcp` tool gateway router) |
| Registration and discovery (a catalogue) | ContextForge ("registry and proxy", "Unified Registries"); Microsoft (`POST /tools` "Register and deploy a tool") |
| Federation with namespacing | ContextForge ADR-0011 (`{gateway-slug}{separator}{original_name}`); Cloudflare (`{server_id}_{original_name}`, e.g. `github_list_issues`) |
| Per-agent tool lists / allow-lists | ContextForge virtual servers; Cloudflare (admins choose tools per portal, allowlist, Access policies per server); Kong (global and per-tool ACLs by Consumer and Consumer Group); agentgateway ("MCP authorization controls which tools, prompts, and resources a client can reach"); Microsoft (Entra ID roles decide which servers and tools a principal can read). Docker's `--profile` picks the servers for a gateway run; its page does not describe it as per agent |
| Central authentication, credential isolation | Docker ("supplies required credentials to servers"); Cloudflare ("attaches the appropriate credentials"); ContextForge (stored credentials encrypted with `AUTH_ENCRYPTION_SECRET`, "Encryption key for stored credentials"); MCP spec forbids token passthrough |
| Rate limits / quotas | ContextForge (rate-limiting middleware on by default; MCP paths 100 requests a minute plus a burst of 20, per IP and per user, §10 A16); Kong (Rate Limiting plugins); Azure API Management (rate limit and quota policies); agentgateway (route rate-limit policy); MCP spec (servers MUST rate limit). Not documented on the Microsoft gateway, Cloudflare portal or Docker gateway pages |
| Audit logging, metrics, tracing | ContextForge (tool metrics, OpenTelemetry, optional audit trail); Cloudflare ("Cloudflare Access logs the individual requests"); Kong (logs JSON-RPC method calls, metrics); Docker (logging and call tracing) |
| Protocol bridging (REST/gRPC to MCP) | ContextForge ("REST-to-MCP Tool Adapter", "gRPC-to-MCP translation"); Kong ("converts API schemas into MCP-compatible tool definitions"); Azure API Management ("Expose REST API in API Management as an MCP server") |
| Server lifecycle and isolation | Docker ("runs MCP servers in isolated Docker containers"); Microsoft ("control plane for managing the MCP server lifecycle") |

The spec itself anticipates gateways: Streamable HTTP mirrors fields into headers "so that
intermediaries (load balancers, gateways, observability tooling) can route and inspect
requests without parsing the body" (2026-07-28 streamable-http page), and the tools page
tells aggregating "proxies" to prefix tool names.

### 3.2 How products describe themselves

| Product | Its own words | Terms it uses | Source |
|---|---|---|---|
| IBM ContextForge | "An open source registry and proxy that federates MCP, A2A, and REST/gRPC APIs with centralized governance, discovery, and observability"; PyPI: "ContextForge AI Gateway — an AI gateway, registry, and proxy" | gateway (= registered MCP server, API name), MCP Servers (UI), virtual server, federation, Tools Gateway, MCP Registry (UI panel) | https://github.com/IBM/mcp-context-forge (README at v1.0.10); `pyproject.toml` |
| Docker MCP Gateway | "Docker's open source solution for orchestrating Model Context Protocol (MCP) servers. It acts as a centralized proxy between clients and servers, managing configuration, credentials, and access control." (the page notes the Docker AI Governance version is invite-only) | MCP Gateway, MCP Toolkit, MCP Catalog, profile | https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/ |
| Microsoft MCP Gateway | "a reverse proxy and management layer for MCP servers"; "Tool Gateway Router" is a component name; the current README says it "requires MCP `2026-07-28` clients" | MCP Gateway, control plane, data plane, tool router | https://github.com/microsoft/mcp-gateway |
| Cloudflare MCP server portals | "An MCP server portal centralizes multiple Model Context Protocol (MCP) servers onto a single HTTP endpoint"; "MCP server portals were previously referred to as **Agents Gateway** in some contexts" (Cloudflare's own page) | MCP server portal | https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ |
| Kong AI Gateway | AI MCP Proxy plugin: proxies MCP, converts REST APIs to MCP tools, groups tools as an MCP server; per-tool ACLs (3.13) | AI MCP Proxy, MCP tool ACLs | https://developer.konghq.com/plugins/ai-mcp-proxy/ , https://developer.konghq.com/mcp/ |
| agentgateway (Linux Foundation / AAIF) | "One high-performance gateway for service, LLM, and MCP traffic" | MCP auth, tool access policies | https://agentgateway.dev/ |
| Azure API Management | exposes managed REST APIs as remote MCP servers; policies (rate limit, JWT validation) apply | MCP server (in API Management), AI gateway | https://learn.microsoft.com/azure/api-management/mcp-server-overview |

"MCP gateway" is the common industry term. "Tool gateway" appears only as a component name
inside Microsoft's project; we never use it.

### 3.3 What an MCP gateway is NOT

- **Not the model.** It never chooses a tool; the model chooses, the agent's client sends
  the call, the gateway forwards it.
- **Not where tools run.** The MCP servers behind it still do the work (except tools it
  synthesises from REST/gRPC APIs, which call those APIs). It adds a hop; it does not make
  calls faster.
- **Not an LLM/AI gateway.** An AI gateway routes model traffic (prompts to OpenAI,
  Anthropic, ...); an MCP gateway routes tool traffic. Some products do both (ContextForge,
  agentgateway, Kong), but the two jobs are distinct. Cloudflare keeps them in separate
  products (MCP server portals in Cloudflare One, separately from AI Gateway; secondary
  source, **UNVERIFIED** wording).
- **Not the official MCP Registry.** The MCP Registry
  (https://modelcontextprotocol.io/registry/about) is "the official centralized metadata
  repository for publicly accessible MCP servers"; it stores metadata only and is not in the
  call path. It is in preview.
- **Not automatically a security boundary.** Hiding a tool from a virtual server removes it
  from that menu. It stops an agent only if the agent's credential is limited to that
  virtual server (ContextForge "server-scoped tokens ... restricted to specific MCP servers",
  `docs/docs/manage/securing.md`) and the agent cannot reach the MCP server directly.

## 4. ContextForge 1.0.10 specifics

All from the source tree at tag `v1.0.10` unless a URL is given.

- **Registered MCP server = "gateway" in the API.** Routes `/v1/gateways` (the lab's
  `seed_contextforge.py` POSTs `{"name", "url", "description", "transport":
  "STREAMABLEHTTP"}`). The admin UI sidebar calls them **"MCP Servers"**
  (`mcpgateway/templates/admin.html`). Later ContextForge docs rename the routes to
  `/v1/mcp-servers` and `/v1/virtual-servers` and say "Always write 'virtual server' or 'MCP
  server,' never just 'server'" (https://ibm.github.io/mcp-context-forge/latest/overview/terminology/).
  Correction (§10, A12): 1.0.10 already serves both names as aliases
  (`api/v1/__init__.py:374-375`); `/v1/gateways` and `/v1/servers` still work.
- **Discovery.** On registration ContextForge connects to the server, asks for its tools and
  stores them (federation). ADR-0011: tools changed upstream show up after a
  deactivate/activate or edit (https://ibm.github.io/mcp-context-forge/architecture/adr/011-tool-federation/).
- **Naming.** Exposed name = `slugify(gateway name)` + `GATEWAY_TOOL_NAME_SEPARATOR` (default
  `-`; allowed `-`, `--`, `_`, `.`) + tool name; the server-side `original_name` is kept and
  used when the call is forwarded (ADR-0011). In the lab the tool name is slugified too:
  `get_weather` → `weather-tools-get-weather` (real `tools/list` output in short.yaml).
  Confirmed in the 1.0.10 source (`db.py:3415-3427`, `config.py:3267-3296`). Inside a virtual
  server ContextForge also accepts the unprefixed original name (`add` resolved and returned
  3.0 live; `tool_service.py:4850-4854`), though `tools/list` shows only prefixed names (§10,
  A8-A9).
- **Virtual servers.** "Create a virtual server bundling those tools" (README). A virtual
  server is the `Server` model, "ORM model for MCP Servers Catalog ... a server that composes
  catalog items (tools, resources, prompts)"; tools and servers are linked many-to-many
  (`server_tool_association`, composite key `(server_id, tool_id)`, `db.py:2531-2536`), so one
  tool can be in several virtual servers. Endpoint `/servers/<id>/mcp` (Streamable HTTP; alias
  `/v1/virtual-servers/<id>/mcp`) and `GET /servers/<id>/sse` (legacy HTTP+SSE), confirmed
  live. `tools/list` on it returns only its associated tools. The id is a fresh
  `uuid4().hex` on every install (§10, A10, A11, A18).
- **Auth.** JWT bearer tokens, Basic, OAuth, SSO; RBAC with teams; "Server-scoped tokens are
  restricted to specific MCP servers and cannot access admin endpoints" (securing.md).
  Upstream credentials stored encrypted with `AUTH_ENCRYPTION_SECRET`. Defaults:
  `AUTH_REQUIRED=true`, `MCP_CLIENT_AUTH_ENABLED=true`. Lab: trusted-proxy header, no tokens,
  and `AUTH_REQUIRED=false`, so header-less MCP calls are allowed as anonymous public-only
  callers (§10, A17).
- **Rate limiting.** Middleware on by default (`rate_limiting_enabled = True`,
  `config.py:3839`); `/servers/...` and `/mcp` fall in the MEDIUM tier,
  `rate_limit_medium_rpm = 100` with a burst of 20, counted per IP and per user, with a
  15-minute lockout after 5 violations. `tool_rate_limit = 100` is the older name for the same
  figure and is now only displayed (§10, A16). Lab: `RATE_LIMITING_ENABLED=false`.
- **Metrics and logs.** Per-call rows in table `tool_metrics` with `tool_id`, `timestamp`,
  `response_time`, `is_success`, `error_message` (no caller, no result value). An optional
  `AuditTrail` table records `user_email`, `action`, `resource_type`..., but
  `audit_trail_enabled` defaults to **false**; the lab does not enable it. Also
  OpenTelemetry tracing and optional Prometheus metrics. Verified live (§10, A5-A7): a call
  to a tool that does not exist adds **no** row; a failed call (isError) adds a row with
  `is_success = 0` and an **empty** `error_message`; rows are buffered and written up to 60 s
  after the call (`metrics_buffer_flush_interval`), stamped with the call time.
- **Unknown tool** through `/servers/<id>/mcp`: HTTP 200 + `isError: true` (see 2.6).
  **Misspelt method**: HTTP 200 + JSON-RPC error `-32601 Method not found: <method>`.
- **Protocol era.** No `initialize` needed (stateless); `initialize` is answered with
  `2025-11-25`; `server/discover` (2026-07-28) is `Method not found` (§10, A3, A14, A15).

## 5. Real in the lab vs illustrative

| Claim a video might make | Lab-real? | Evidence |
|---|---|---|
| Two toy MCP servers, `weather-tools` (`get_weather`, `get_forecast`) and `calculator-tools` (`add`, `subtract`, `multiply`), Streamable HTTP | Real | `workspace/tools/*.py`, manifest |
| Weather data | **Made up**: deterministic from the city name; Leeds → 10 °C, cloudy | `weather_tool_server.py` (`10 + seed % 25`, seed 525 for "leeds") |
| ContextForge 1.0.10 is the MCP gateway; both servers registered | Real | manifest, `seed_contextforge.py` |
| Virtual server `toy-tools` with all **5** tools, nothing left out | Real | seed script (all tools of both gateways), real `--list` output |
| Endpoint `/servers/<id>/mcp`; the id is a uuid4 hex created at seed time | Real; the id is **not** stable: three fresh installs gave three ids. Never show a fixed id as "the" lab id | seed script; `db.py:4426`; §10 A18 |
| Prefixed names `calculator-tools-add`, `weather-tools-get-weather` | Real | real output |
| `calculator-tools-add` 17 + 25 → `42.0`, with `structuredContent: {"result": 42.0}` | Real | real output in short.yaml |
| `does-not-exist` → HTTP 200, `isError: true`, "Tool not found: does-not-exist" | Real | real output; `_harness.py`; solution answers.json |
| View tab call log: tool, time, success, response time, error | Real, but a new row can take up to about a minute to appear (metrics buffer), and the error column stays empty for isError failures | `view_service.py` reads `tool_metrics`; §10 A6-A7 |
| The log shows **who** called | **Not in the lab**: no caller column, and every call is the same admin identity | `view_service.py` SQL; manifest |
| The log records the result value (42.0) | **No** | `tool_metrics` has no result column |
| A call to `does-not-exist` adds a row to the view log | **No** (verified live: no row; the lookup fails before metrics are recorded) | `tool_service.py:5287`, `:7118-7130`; `db.py:2595`; §10 A5 |
| A misspelt method (`tools/calll`) returns a protocol error | Real: HTTP 200, `-32601 Method not found: tools/calll`, no result | live run; `streamablehttp_transport.py:4848-4870`; §10 A2 |
| Agents with their own keys / tokens | Illustrative | lab uses a trusted-proxy header |
| An admin server with a risky tool left out of a bundle | Illustrative | not in the lab |
| An upstream weather API timing out | Illustrative | the toy weather server calls nothing |
| A model choosing the tool | Illustrative | the lab has no model; `call_tool.py` is the learner acting as the agent's client |
| An `initialize` handshake | Not shown in the lab | `call_tool.py` |

## 6. Corrections to our earlier drafts

Exact claims that the research contradicts or that need a qualifier.

**`learn/short.yaml`**
1. "A tool gateway fixes this." and node labels `"Tool gateway"` → the term is **MCP gateway**.
2. "Each tool server registers with the gateway, once: here is my address." → the server
   does nothing; an operator (here `seed_contextforge.py`) registers it with the gateway.
3. "The function lives on a tool server, here a weather server." / "MCP: one way to ask any
   tool server" → introduce the standard term **MCP server** (and the MCP client inside the
   agent); the draft never names client, host or JSON-RPC.
4. "Leeds, ten degrees, cloudy ... A real answer, instead of a guess." and the chip "real
   data, not a guess" → the lab's weather is invented by a toy server. Say the answer came
   *from a tool* instead of from the model's memory, and say the lab's numbers are made up.
5. "Then the agent calls it by name ... You can make exactly this call in the lab" while the
   board shows agent → weather server directly → the lab call goes through ContextForge and
   uses `weather-tools-get-weather`, not `get_weather`. Say so.
6. "So the same agent can use ... a calendar server tomorrow, without new code." → it needs
   configuration (the new server's address, or a gateway entry); say "without new code for
   that tool".
7. "The bundle leaves it out, so the support agent cannot even see it, let alone call it."
   → true for that menu only; it holds as a control only when the agent's credential is
   limited to that virtual server and the MCP server is not reachable directly. In the lab
   nothing is left out, and there is no admin server.
8. "And the support agent gets its own key, so the gateway always knows who is asking." /
   "Each agent gets one address, its own key" → illustrative; the lab has no keys and logs no
   caller.
9. Log card `"result: 42.0 ✓"` and "it can record every call: which tool was called, when,
   and whether it worked ... one row per call" → the lab's log has no result value; a call
   to an unknown tool adds no row (verified live, §10 A5).
10. "If the request itself is broken, say the method name is wrong ... You get a protocol
    error" followed by "You can see the tool error shape in the lab. Call a tool that does
    not exist." → the spec lists an *unknown tool* as a **protocol error**
    (`-32602 Unknown tool`); ContextForge returns it as a tool error because of the MCP Python
    SDK. The video must say this, or a careful viewer learns the wrong rule.
11. "Ask an AI agent ... But how could it know?" / "What went wrong?" → narrated rhetorical
    questions break docs/video-prompt.md; keep the question on the board.
12. The weather-API timeout story is illustrative; mark it so.

**`learn/concepts/mcp.what-is-mcp.md`**
- "MCP uses JSON-RPC 2.0 over HTTP." → JSON-RPC 2.0 over **stdio or Streamable HTTP**; the lab
  uses HTTP.
- "A **server** offers tools. A **client**, inside the agent, talks to the server." → fine, but
  add that each client talks to exactly one server and that the application is the host.
- "A gateway puts one endpoint in front of them" → "An **MCP gateway** ...".

**`learn/concepts/mcp.virtual-servers.md`**
- "A tool gateway is that door" → MCP gateway.
- "ContextForge calls this a gateway too ... think of it as a registration" → correct for the
  API; add that the admin UI shows them under **MCP Servers**.
- "The gateway is also where logging lives ... who called what" → in the lab the log has no
  caller; ContextForge's audit trail (with user) is off by default.

**`learn/concepts/mcp.tool-errors.md`**
- "This layer is for protocol-level trouble: a malformed request, a method the server does
  not have, arguments that do not fit the input schema." → since 2025-11-25, input
  validation errors are **tool execution errors**; only requests that break the
  `CallToolRequest` shape are protocol errors. Add "unknown tool" (spec) to the protocol list.
- "MCP has two places for it, and both can arrive inside an HTTP 200." → true for the lab's
  2025-11-25-era server; under 2026-07-28 some protocol errors use 400/404. Keep "HTTP 200 is
  not proof of success", drop any implication that errors are always 200.
- Missing: that the lab's unknown-tool `isError` result is ContextForge/SDK behaviour, not
  the spec's classification.

**`learn/quiz.yaml`**: "What is a virtual server in a tool gateway?" and "one tool gateway"
→ MCP gateway. `q-mcp-roles` option a is fine.

**`learn/story.md`, `learn/comic.yaml`, `learn/audio.json`**: "So we have set up a tool
gateway" / caption "A tool gateway." → MCP gateway (audio clip must be regenerated).
"Tool servers sign up with it" → "we registered the tool servers with it".

**`brief.md`**: "Every call adds a row to the log in the view tab." → not for a call to an
unregistered tool (verified live, §10 A5), and a row can take up to a minute to appear.
"MCP servers (the registered gateways)" is correct.

**`manifest.yaml` comments** (noted only; not changed in this pass): the `view` service
comment says `tool_metrics` "is written within a second or two of each call" → it is
buffered, up to 60 s (§10 A7). The header comment says that "with trusted proxy mode on, a
request with no header is anonymous and gets 403" → true for the REST API; the MCP endpoint
`/servers/<id>/mcp` answers a header-less call with 200 and public-only access (§10 A17).

**`packages/catalogue/diagrams.json`** `mcp-virtual-servers` and `mcp-tool-errors` label the
gateway "Tool hub"; "The agent has one address and one key" is illustrative.

## 7. Misconceptions to address

1. **"The model runs the tool."** The model writes a request; the agent's code (the MCP
   client) sends it; the MCP server runs it. Anthropic: Claude "returns a structured call that
   your application runs". https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
2. **"MCP is function calling."** Function calling (tool use) is a model API feature: the model
   emits a structured call. MCP is the protocol between the application and the programs that
   offer tools. An agent typically uses both: MCP to fetch the menu and make the call,
   function calling to let the model pick.
3. **"An MCP server is a machine."** It is a program; it can be a local subprocess (stdio).
4. **"A tool is an MCP server."** A server offers one or more tools (the lab's calculator
   offers three).
5. **"HTTP 200 means the tool worked."** A tool error arrives as a normal 200 reply with
   `isError: true`.
6. **"isError and a JSON-RPC error are the same thing."** One is a result, the other replaces
   the result; models are meant to read the first.
7. **"An MCP gateway is an AI gateway / the model."** Different traffic, different job.
8. **"The registry is the gateway."** The official MCP Registry is metadata for public
   servers; a gateway is in the call path. ContextForge has both (a catalogue panel and the
   proxy).
9. **"A virtual server runs or copies tools."** It is a selection plus an address.
10. **"Leaving a tool out is enough security."** Only with scoped credentials and no direct
    route to the MCP server.
11. **"Tool descriptions are trustworthy."** The spec says annotations are untrusted unless
    the server is trusted; descriptions are read by the model like a prompt.
12. **"The gateway makes calls faster."** It adds a hop.

## 8. Analogies, and where each one breaks

| Idea | Analogy | Where it breaks (say so if used) |
|---|---|---|
| MCP | USB-C port (the official one): one plug shape for many devices | USB-C says nothing about what a device does; MCP also carries the menu (names, descriptions, input schemas) |
| `tools/list` / `tools/call` | A restaurant menu and an order slip: the menu lists dishes and what you must specify; the order names a dish and the choices | The diner (model) only points at the menu; the waiter (client) places the order. A kitchen can answer "out of stock" on a normal slip (tool error) |
| MCP gateway | A company switchboard/reception: one number, a directory of who is behind it, calls put through, a visitor log | Reception does not do the work; and the "directory" each caller hears can differ (virtual servers) |
| Virtual server | A playlist: a named pick of songs from one library; one song can be on many playlists; deleting a playlist deletes no songs | A playlist does not stop you opening the library; a virtual server only restricts access if credentials are scoped to it |
| Prefixing | Surnames: two people called Sam become Sam Weather and Sam Calculator | The prefix is the registration name chosen by the operator, not something the server picks |
| Tool error vs protocol error | A courier: the parcel was delivered (HTTP 200) and the letter inside says "sorry, out of stock" (isError); versus a parcel returned "no such address" (protocol error) | In the current spec some protocol errors also change the HTTP status |

Avoid "the gateway is the brain" and "the gateway is a firewall".

## 9. UNVERIFIED items

Settled on 2026-10-25 (see §10): the lab's `mcp` SDK version (1.30.0), whether
`does-not-exist` adds a view-tab row (it does not), what a misspelt method returns (HTTP 200,
`-32601`), whether the virtual server id is stable (it is not), MCP's announcement day
(25 November 2024), and Cloudflare's "formerly Agents Gateway" name (on Cloudflare's own page).

Still open:

- Cloudflare MCP server portals' release stage (the page does not state one; Logpush export
  is Enterprise-only).
- How much of ContextForge's admin UI metrics page the learner sees in 1.0.10 (not opened
  live).
- The rest of the list in §10.3.

## 10. Verification pass, 2026-10-25

A second pass settled the items an earlier deep-research run left open. Method:

- **ContextForge source.** `pip download --no-deps --no-binary :all:
  mcp-contextforge-gateway==1.0.10` into an empty directory, read only. Every file cited below
  (`config.py`, `db.py`, `main.py`, `api/v1/__init__.py`, `services/tool_service.py`,
  `services/metrics_buffer_service.py`, `transports/streamablehttp_transport.py`,
  `middleware/rate_limit_middleware.py`) is byte-identical to the installed 1.0.10 wheel that
  was run. Paths are relative to `mcpgateway/`.
- **MCP Python SDK.** `mcp` 1.30.0, the version the lab image pins and the version installed in
  the run.
- **Live run.** The lab's own `workspace/` copied unchanged, run under Python 3.12 with the
  manifest's exact environment (trusted-proxy auth, `AUTH_REQUIRED=false`,
  `RATE_LIMITING_ENABLED=false`, SQLite), fresh database each time. Requests sent with the
  lab's header `X-Authenticated-User: admin@example.com` unless noted. Output quoted below is
  captured, not retyped.
- **Spec and vendor pages.** Fetched as raw Markdown or HTML on 2026-10-25 and quoted
  verbatim.

### 10.1 Claims settled

| Claim | Verdict | Evidence | Version |
|---|---|---|---|
| **A1.** A call to an unknown tool through `/servers/<id>/mcp` returns HTTP 200 and a *tool execution error*, not a JSON-RPC error | VERIFIED | Live: `<-- HTTP 200` / `{"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "Tool not found: does-not-exist"}], "isError": true}}` (the lab's own `call_tool.py`). The lookup raises `ToolNotFoundError` (`services/tool_service.py:5287`, `_resolve_tool_for_invocation`); the Streamable HTTP `call_tool` handler re-raises it (`transports/streamablehttp_transport.py:2132-2136`; its docstring at :1772 expects a "JSON-RPC error response"), and the SDK turns any handler exception into an `isError` result (`mcp/server/lowlevel/server.py:589-590`, `except Exception as e: return self._make_error_result(str(e))`) | ContextForge 1.0.10, `mcp` 1.30.0 |
| **A2.** A misspelt JSON-RPC method gets a protocol error with HTTP 200 | VERIFIED | Live: `tools/calll` → `HTTP 200`, `{"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: tools/calll"},"id":4}`, no `result`. Source: ContextForge peeks at session-less POSTs and answers unknown methods itself with `status_code=200` and `-32601` (`transports/streamablehttp_transport.py:4848-4870`; only for methods containing `/` and carrying an `id`). The 2026-07-28 spec would require `404` here (row B3); ContextForge 1.0.10 is a 2025-11-25-era server | ContextForge 1.0.10 |
| **A3.** Other protocol-level replies seen live | VERIFIED | `server/discover` (2026-07-28's required method) → HTTP 200, `-32601 Method not found`. A body without `"jsonrpc"` → HTTP 400, `-32602 Validation error`. Unknown virtual-server id → HTTP 404 `{"detail":"Server not found"}` | ContextForge 1.0.10 |
| **A4.** Invalid arguments come back as a tool execution error | VERIFIED (in the lab) | Live: `calculator-tools-add` with `{"a": "x", "b": 2}` → HTTP 200, `isError: true`, text `Error executing tool add: 1 validation error for addArguments ...`; `weather-tools-get-weather` with `{}` → `isError: true`, `Field required`. The text comes from the toy server's SDK, forwarded by ContextForge | ContextForge 1.0.10, `mcp` 1.30.0 |
| **A5.** A call to a nonexistent tool adds no row to `tool_metrics` (the view tab's source) | VERIFIED | Live: four calls that resolved to a tool produced four rows; `does-not-exist` and `tools/calll` produced none. Source: the lookup (`tool_service.py:5287`) runs before the metrics phase, which records only `if tool_id:` (`tool_service.py:7118-7130`); `tool_metrics.tool_id` is a NOT NULL foreign key (`db.py:2595`) | ContextForge 1.0.10 |
| **A6.** A *failed* tool call (isError result) does add a row, with `is_success = 0` and **no** error message | VERIFIED | Live rows: `('calculator-tools-add', 0, None)` and `('weather-tools-get-weather', 0, None)` for the two invalid-argument calls. Source: for an MCP upstream, `success = not is_err` and `error_message` stays `None` (`tool_service.py:6676-6686`). The view tab's "error" column (`workspace/view_service.py:69`) is therefore empty for these failures | ContextForge 1.0.10 |
| **A7.** `tool_metrics` rows appear within a second or two of a call (manifest comment on the `view` service) | REFUTED | Metrics are buffered: `metrics_buffer_enabled` default true, `metrics_buffer_flush_interval` default 60 s (`config.py:2388-2389`; boot log `flush_interval=60s`). Live: 0 rows immediately after the calls, 4 rows after 75 s, each timestamped with the call time. A new row can take up to about a minute to show in the view tab | ContextForge 1.0.10 |
| **A8.** Tool-name prefix rule | VERIFIED | Name = `slugify(gateway name)` + `GATEWAY_TOOL_NAME_SEPARATOR` + `slugify(custom_name_slug)`, where the custom name defaults to the server's own tool name (`db.py:3415-3427`; refresh path `db.py:803-809`). Separator default `-`; allowed `-`, `--`, `_`, `.`, anything else falls back to `-` with a warning (`config.py:3267-3296`). Live: `get_weather` on `weather-tools` → `weather-tools-get-weather`; `original_name` stored as `get_weather` | ContextForge 1.0.10 |
| **A9.** Inside a virtual server the unprefixed original name also resolves | VERIFIED (new) | Live: `tools/call` with `"name": "add"` → `{"content":[{"type":"text","text":"3.0"}],"structuredContent":{"result":3.0},"isError":false}`. Source: with a `server_id`, lookup matches `DbTool.name == name` **or** `DbTool.original_name == name`, joined to that server's tools (`tool_service.py:4850-4854`). `tools/list` shows only prefixed names | ContextForge 1.0.10 |
| **A10.** One tool can belong to several virtual servers | VERIFIED (schema; not exercised live) | `server_tool_association` has composite primary key `(server_id, tool_id)` (`db.py:2531-2536`); `Tool.servers` and `Server.tools` are many-to-many through it (`db.py:3374`, `db.py:4459`) | ContextForge 1.0.10 |
| **A11.** Virtual-server MCP endpoint forms | VERIFIED | Live, POST `tools/list`: `/servers/<id>/mcp` 200, `/servers/<id>/mcp/` 200, `/v1/virtual-servers/<id>/mcp` 200, `/servers/<id>` 405, `/v1/servers/<id>/mcp` 404. `GET /servers/<id>/sse` → 200 `text/event-stream` (legacy HTTP+SSE). `GET /servers/<id>/mcp` → 405 `"Stateful sessions disabled on this gateway; passive SSE stream is not available."` Source: `main.py:3084` (`/servers/([^/]+)/mcp/?`), `main.py:3092-3093`, `main.py:4576` (`/{server_id}/sse`). The global `/mcp` endpoint also answers and lists every tool | ContextForge 1.0.10 |
| **A12.** The REST names `/v1/mcp-servers` and `/v1/virtual-servers` are newer than 1.0.10 (§4 of this brief) | REFUTED | 1.0.10 already mounts them as aliases: `v1_router.include_router(gateway_router, prefix="/mcp-servers")` and `(server_router, prefix="/virtual-servers")` (`api/v1/__init__.py:374-375`). Live `GET /v1/mcp-servers` and `GET /v1/virtual-servers` → 200. `/v1/gateways` and `/v1/servers` still work | ContextForge 1.0.10 |
| **A13.** `mcp` SDK version | VERIFIED | Lab image pins `mcp==1.30.0` (`images/agent/requirements-contextforge.txt:48`, `images/agent/requirements-system.txt:63`); ContextForge declares `mcp>=1.28.1,<2` (`pyproject.toml:87`). Live `initialize` reply: `"serverInfo":{"name":"mcp-streamable-http","version":"1.30.0"}` | `mcp` 1.30.0 |
| **A14.** Protocol version ContextForge negotiates | VERIFIED | `protocol_version: str = "2025-11-25"` (`config.py:256`); SDK `LATEST_PROTOCOL_VERSION = "2025-11-25"` (`mcp/types.py:27`), supported `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` (`mcp/shared/version.py:3`). Live: `initialize` asking for `2026-07-28` → `"protocolVersion":"2025-11-25"` | ContextForge 1.0.10, `mcp` 1.30.0 |
| **A15.** No `initialize` handshake is needed; `call_tool.py` sends none | VERIFIED | `use_stateful_sessions = False`, `json_response_enabled = True` (`config.py:3106-3107`); session manager built with `stateless=True` (`transports/streamablehttp_transport.py:4088-4097`). `workspace/call_tool.py:78` (`mcp_call`) POSTs `tools/list` / `tools/call` directly, no `_meta`, no `MCP-Protocol-Version`. Live: both return 200 | ContextForge 1.0.10 |
| **A16.** Default rate limiting | VERIFIED | `rate_limiting_enabled` default **true** (`config.py:3839`), Redis with in-memory fallback (`config.py:3840`). `/servers/...`, `/mcp`, `/tools`, `/gateways` are the MEDIUM tier: `rate_limit_medium_rpm = 100`, burst 20 (`config.py:3853-3854`; tier regex `rate_limit_middleware.py:129-133`). Counted per client IP and per user (`rate_limit_middleware.py:203-212`); lockout after 5 violations for 15 minutes (`config.py:3860-3862`). `tool_rate_limit = 100` (`config.py:2690`) is the legacy name, now only shown in the admin settings (`admin.py:2775`). The lab turns rate limiting off (`RATE_LIMITING_ENABLED: "false"`, manifest) | ContextForge 1.0.10 |
| **A17.** Auth for `/servers/<id>/mcp` in the lab, and the identity calls carry | VERIFIED | Defaults: `auth_required = True` (`config.py:366`), `mcp_client_auth_enabled = True` (`config.py:629`); `mcp_require_auth` unset inherits `AUTH_REQUIRED` (`config.py:4041-4042`). The lab sets `AUTH_REQUIRED=false`, so MCP endpoints are permissive: "Requests without auth are allowed but get public-only access" (`streamablehttp_transport.py:5185-5186`, `:5291-5307`). Live: header-less `tools/list` and `tools/call` on `/servers/<id>/mcp` → 200 with all five tools (the seed makes every tool and the virtual server `public`); header-less `GET /v1/servers` → 403 `Access denied`; `X-Authenticated-User: mallory@example.com` → 401 `User not found in database`. Every lab script sends `admin@example.com`, so every scripted call is that admin | ContextForge 1.0.10, lab config |
| **A18.** The virtual server id is stable across fresh installs of the lab | REFUTED | `Server.id` defaults to `uuid.uuid4().hex` (`db.py:4426`); `seed_contextforge.py:121-130` POSTs no id. Three fresh installs gave `66fb78f21dc64587af61e4c36fe54b1f`, `6d00628e7d494b2bb3b6ad4524d2bbee`, `6241a19e75134cb08f3cfe7335652971`. `call_tool.py:65` looks the id up by the name `toy-tools` every time | ContextForge 1.0.10 |
| **A19.** ContextForge acts as an MCP client to the registered servers | VERIFIED | `tool_service.py:52-54` imports `ClientSession`, `sse_client`, `streamablehttp_client` from the `mcp` SDK | ContextForge 1.0.10 |
| **B1.** Unknown tool is still a protocol error, and input validation errors are still tool execution errors | VERIFIED | Tools page, Error Handling: "**Protocol Errors** indicate issues with the request structure itself that models are less likely to be able to fix: Unknown tool; Malformed requests ...; Server errors. They are returned as standard JSON-RPC errors" (example `-32602`, `"Unknown tool: invalid_tool_name"`); "**Tool Execution Errors** ... API failures; Input validation errors (e.g., date in wrong format, value out of range); Business logic errors. They are reported in tool results with `isError: true`". The example result now carries `"resultType": "complete"`. https://modelcontextprotocol.io/specification/2026-07-28/server/tools | spec 2026-07-28 |
| **B2.** The standard transports are stdio and Streamable HTTP | VERIFIED | "The binding pages specify the standard transports: 1. stdio: newline-delimited messages over the standard streams of a client-launched subprocess. 2. Streamable HTTP: each message is an HTTP POST to a single MCP endpoint; replies arrive as a JSON object or a request-scoped SSE stream." https://modelcontextprotocol.io/specification/2026-07-28/basic/transports | spec 2026-07-28 |
| **B3.** On Streamable HTTP an unknown method is a 404 | VERIFIED | "If the server does not implement the requested RPC method, it **MUST** respond with `404 Not Found` and a JSON-RPC error with code `-32601` (`Method not found`)." https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http | spec 2026-07-28 |
| **B4.** Token passthrough is forbidden | VERIFIED | Authorization: "MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience" ... "MCP servers **MUST NOT** accept or transit any other tokens." https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization . Security best practices: "Token passthrough is explicitly forbidden in the authorization specification"; mitigation: "MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server." https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices (same text at https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices ) | spec 2026-07-28 |
| **B5.** High-level OAuth model | VERIFIED | "Authorization is **OPTIONAL** for MCP implementations." HTTP transports "**SHOULD** conform"; stdio "**SHOULD NOT** follow this specification, and instead retrieve credentials from the environment." "A protected *MCP server* acts as an OAuth 2.1 resource server"; "An *MCP client* acts as an OAuth 2.1 client"; "The *authorization server* is responsible for interacting with the user (if necessary) and issuing access tokens". Clients "**MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707". Same authorization URL as B4 | spec 2026-07-28 |
| **B6.** What the spec calls the confused deputy problem | VERIFIED | "Attackers can exploit MCP proxy servers that connect to third-party APIs, creating 'confused deputy' vulnerabilities. This attack allows malicious clients to obtain authorization codes without proper user consent by exploiting the combination of static client IDs, dynamic client registration, and consent cookies." Mitigation: "MCP proxy servers **MUST** implement per-client consent". Token passthrough "can potentially cause the 'confused deputy' problem, where the downstream API may incorrectly trust the token as if it came from the MCP server". Security best practices URL as B4. Note: the spec's confused deputy is an OAuth consent problem for proxies, not "the model was tricked into misusing a tool" | spec 2026-07-28 |
| **B7.** Over-broad credentials | VERIFIED | Scope Minimization: "Poor scope design increases token compromise impact, elevates user friction, and obscures audit trails"; mitigation "Implement a progressive, least-privilege scope model". Security best practices URL as B4 | spec 2026-07-28 |
| **B8.** Spec duties relevant to a gateway | VERIFIED | Tools page, Security Considerations: servers **MUST** "Validate all tool inputs", "Implement proper access controls", "Rate limit tool invocations", "Sanitize tool outputs"; clients **SHOULD** "Validate tool results before passing to LLM", "Log tool usage for audit purposes". "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers." `tools/list` "**MAY** vary by the authorization presented on the request". Aggregating proxies "**SHOULD** implement a disambiguation strategy such as prefixing tool names with a server identifier." | spec 2026-07-28 |
| **B9.** The spec names "tool poisoning" and "prompt injection" | REFUTED | Neither phrase occurs on the 2026-07-28 tools, authorization, transports, Streamable HTTP or security best-practices pages (searched). Use OWASP for these terms (S1, S2) | spec 2026-07-28 |
| **B10.** MCP was announced and open-sourced by Anthropic on 25 November 2024 | VERIFIED | Anthropic news post "Published Nov 25, 2024": "Today, we're open-sourcing the Model Context Protocol (MCP)"; "MCP was created at Anthropic by David Soria Parra and Justin Spahr-Summers." https://www.anthropic.com/news/model-context-protocol | n/a |
| **C1.** Microsoft MCP Gateway (`microsoft/mcp-gateway`) | VERIFIED (README, main branch, 2026-10-25) | Definition: "a reverse proxy and management layer for Model Context Protocol (MCP) servers, enabling scalable, stateless request routing, authorization and lifecycle management of MCP servers in Kubernetes environments." Documents: single endpoint (`POST /mcp` "Route requests to the tool gateway router"; per server `POST /adapters/{name}/mcp`); registry (`POST /adapters` "Deploy and register a new MCP server", `POST /tools` "Register and deploy a tool"); per-principal filtering (Entra ID app roles: read access only for the creator, `requiredRoles` holders and `mcp.admin`; "every list call already filters down to the resources the signed-in user is allowed to see"); observability ("telemetry, access control and observability" integration points; `GET /adapters/{name}/logs`). Not documented on the page: upstream credential injection, rate limiting, REST-to-MCP bridging. The README says this version "requires MCP `2026-07-28` clients" with no legacy initialization. "Tool Gateway Router" is a component name. https://github.com/microsoft/mcp-gateway | README fetched 2026-10-25 |
| **C2.** Azure API Management | VERIFIED (page dated 2026-09-11) | "Use API Management to securely expose and govern MCP servers and their backends ... API Management provides centralized control over MCP server authentication, authorization, and monitoring." Documents: protocol bridging ("Expose any REST API managed in API Management as an MCP server ... API operations become MCP tools"); rate limiting and quotas; JWT validation; inbound and outbound "key-based or OAuth authentication"; Azure Monitor / Application Insights. Limits: "policies apply to all API operations exposed as tools in the MCP server" (no per-tool policy); tools only, "doesn't support MCP resources or prompts". Not documented: aggregation of several MCP servers into one endpoint. https://learn.microsoft.com/en-us/azure/api-management/mcp-server-overview | page ms.date 2026-09-11 |
| **C3.** Cloudflare MCP server portals | VERIFIED (page updated 2026-10-22) | "An MCP server portal centralizes multiple Model Context Protocol (MCP) servers onto a single HTTP endpoint." Documents: registration (add servers to Access; tools synced); credentials ("attaches the appropriate credentials, and proxies the request"; per-user OAuth or a shared admin credential); per-portal tool choice, allowlist mode (`default_disabled`), Access policies per server ("Turned-off tools will not appear in the portal's tool list. Users will not be able to call them."); namespacing `{server_id}_{original_name}`; observability ("Cloudflare Access logs the individual requests"; optional Gateway HTTP logging and DLP); protocol ("supports stateless MCP `2026-07-28` and earlier 2025 Streamable HTTP clients and servers"). "MCP server portals were previously referred to as **Agents Gateway** in some contexts." Not documented on the page: rate limiting. https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ | page updated 2026-10-22 |
| **C4.** Kong AI MCP Proxy | VERIFIED | "It acts as a protocol bridge, translating between MCP and HTTP so that MCP-compatible clients can either call existing APIs or interact with upstream MCP servers through Kong." Documents: REST-to-MCP conversion; single endpoint (listener mode "a single MCP endpoint that aggregates tools"); per-tool ACLs by Consumer and Consumer Group (3.13+); rate limiting via the Rate Limiting plugins; authentication (OpenID Connect, Key Auth, AI MCP OAuth2 plugin); audit logs and metrics ("Logs capture session IDs, JSON-RPC method calls, payloads, latencies, and errors"); "MCP Registry (tech preview)" catalogue in Konnect. Enterprise-only plugin, Kong Gateway 3.12+. https://developer.konghq.com/plugins/ai-mcp-proxy/ , https://developer.konghq.com/mcp/ | Kong Gateway 3.12/3.13 docs |
| **C5.** agentgateway (Solo.io) | VERIFIED | "One high-performance gateway for service, LLM, and MCP traffic." Documents: one federated endpoint (multiplexing: "One MCP server whose `tools/list` response federates the tools of every target"); prefixing ("Tool names are prefixed with the target name by default"); per-client filtering ("MCP authorization controls which tools, prompts, and resources a client can reach", CEL rules; "Tools that a client is not allowed to call are filtered out of `list` responses"); MCP authentication as a resource server; backend credentials incl. RFC 8693 token exchange; rate limiting (route policy page); observability (`mcp_requests_total` with server, method, tool labels; logs; traces); bridging between MCP spec versions ("translates between them automatically"). The earlier quote "scope which tools each identity may invoke" was not found on these pages. https://agentgateway.dev/ , https://agentgateway.dev/docs/standalone/latest/documentation/mcp/configuration-modes/ , .../mcp/mcp-authz/ , .../mcp/mcp-observability/ , .../mcp/spec-compatibility/ | docs "latest", 2026-10-25 |
| **C6.** Docker MCP Gateway | VERIFIED | "The MCP Gateway is Docker's open source solution for orchestrating Model Context Protocol (MCP) servers. It acts as a centralized proxy between clients and servers, managing configuration, credentials, and access control." Documents: one endpoint ("you configure applications to connect to the Gateway"); server choice by profile ("specify which profile to use with the `--profile` flag to determine which servers are made available to clients"; per gateway run, not described as per agent); credential injection ("The Gateway then injects any required credentials"); isolation ("runs MCP servers in isolated Docker containers with restricted privileges, network access, and resource usage"); "built-in logging and call-tracing". Not documented on the page: rate limiting, protocol bridging. Note at the top: "MCP Gateway as part of Docker AI Governance is an invite-only feature." https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/ | page fetched 2026-10-25 |
| **S1.** Tool poisoning | VERIFIED (OWASP, list in beta) | OWASP MCP03:2025: "Tool poisoning occurs when an adversary compromises the tools, plugins, or their outputs that an AI model depends on - injecting malicious, misleading, or biased context to manipulate model behavior." Static indicators include "Model-directed imperatives", "Sensitive-path references", hidden zero-width characters. The project says it is at "Phase 3 – Beta Release". Found via Invariant Labs, "MCP Security Notification: Tool Poisoning Attacks" (2025-04-01). https://owasp.org/www-project-mcp-top-10/ , https://owasp.org/www-project-mcp-top-10/2025/MCP03-2025%E2%80%93Tool-Poisoning , https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks | OWASP MCP Top 10 2025 (beta) |
| **S2.** Prompt injection through tool results | VERIFIED | OWASP LLM01:2025: "Indirect prompt injections occur when an LLM accepts input from external sources, such as websites or files"; "it is unclear if there are fool-proof methods of prevention for prompt injection." OWASP MCP06:2025 "Prompt Injection via Contextual Payloads". Spec: clients SHOULD "Validate tool results before passing to LLM" (B8). https://genai.owasp.org/llmrisk/llm01-prompt-injection/ | OWASP LLM Top 10 2025 |
| **S3.** Over-broad credentials | VERIFIED | Spec Scope Minimization (B7); OWASP MCP02:2025 "Privilege Escalation via Scope Creep"; OWASP LLM06:2025 Excessive Agency, root causes include "excessive permissions". https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ | OWASP 2025, spec 2026-07-28 |
| **S4.** Hiding a tool is a control, not a lock | VERIFIED (ContextForge, lab config) | Inside one virtual server a call only resolves tools associated with that server (`tool_service.py:4853-4854`), so a left-out tool cannot be called *through that address*. But in the lab's configuration the same gateway also serves every tool at `/mcp` and accepts header-less calls (A11, A17): any other route or broader credential reaches the tool. Cloudflare enforces hidden tools at the portal ("Users will not be able to call them") | ContextForge 1.0.10 |

### 10.2 What a gateway can and cannot do about each risk

Our synthesis from the rows above; each line names its source.

| Risk | A gateway can | A gateway cannot |
|---|---|---|
| Tool poisoning (S1) | Keep untrusted servers out (registration is an operator act); show each agent a reviewed subset of tools (C3, C4, C5, ContextForge virtual servers); let admins override descriptions (Cloudflare aliases, C3); run the static checks OWASP lists | Stop a model from following a malicious description that it is shown; detect every poisoned description (OWASP calls its indicators "pre-connection, static" and not a replacement for runtime controls) |
| Prompt injection through results (S2) | Log and inspect results (C3 DLP scanning, C4 audit logs, C5 guardrails via external processing); apply the spec's "sanitize tool outputs" / "validate tool results" duties (B8) at one choke point | Guarantee prevention: OWASP says it is "unclear if there are fool-proof methods of prevention" |
| Confused deputy (B6) | As an OAuth proxy, implement per-client consent (a spec MUST for MCP proxy servers); refuse token passthrough (B4); exchange tokens instead (C5, RFC 8693) | Fix a downstream API that trusts forwarded tokens; protect anything reached around it |
| Over-broad credentials (S3) | Hold upstream credentials centrally and give each agent its own narrow credential and tool list | Narrow an upstream credential it was given: Cloudflare's shared admin credential (C3) gives every portal user that credential's reach |
| Hidden tools (S4) | Refuse calls to tools outside the agent's virtual server | Act as a lock if the agent has another route (another endpoint, a broader credential, or direct network reach to the MCP server) |

### 10.3 Still UNVERIFIED after this pass

- ContextForge's `docs/docs/manage/securing.md` wording on server-scoped tokens (the 1.0.10
  sdist ships no `docs/` tree; not re-checked).
- agentgateway's "Linux Foundation / AAIF" stewardship in §3.2 (not re-checked; the pages
  read only say Solo.io publishes distributions).
- A per-tool rate limit in ContextForge (the source shows only per-path tiers).
- How much of ContextForge's admin metrics page the learner sees (not opened).
- agentgateway REST/OpenAPI-to-MCP conversion (not found on the pages read; may exist
  elsewhere in its docs).
