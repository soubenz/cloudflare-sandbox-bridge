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
| Exact `mcp` SDK version installed in the lab image | **UNVERIFIED** (the toy servers and ContextForge both use it; only the `>=1.28.1,<2` bound is known) | |

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
  (The "November 2024" introduction date is from the same Anthropic post's "one year after"
  framing; exact day **UNVERIFIED** here.)
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
  JSON-RPC error `-32601 "Tool not found: ..."`. The videos must say which shape the lab
  shows and that the spec files this case differently.

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
  `"transport": "STREAMABLEHTTP"`, endpoint `/servers/<id>/mcp`).
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
  header `X-Authenticated-User: admin@example.com` (manifest.yaml). Every call in the lab is
  the same admin identity.

## 3. The MCP gateway pattern

### 3.1 Definition (synthesised from the products below; consistent across all of them)

An **MCP gateway** is a proxy in the call path between MCP clients and many MCP servers. To
agents it presents one MCP endpoint (it "runs as a fully compliant MCP server", ContextForge
README); to the real servers it is an MCP client. Around that it centralises:

| Function | Who says so |
|---|---|
| One endpoint instead of one per server | ContextForge ("federates tools, agents, and APIs into one clean endpoint"); Cloudflare ("centralizes multiple MCP servers onto a single HTTP endpoint"); Docker ("Applications connect to the Gateway rather than being configured separately for each server") |
| Registration and discovery (a catalogue) | ContextForge ("registry and proxy", "Unified Registries"); Microsoft (`POST /tools` "Register and deploy a tool") |
| Federation with namespacing | ContextForge ADR-0011 (`{gateway-slug}{separator}{original_name}`); Cloudflare (`{server_id}_{original_name}`, e.g. `github_list_issues`) |
| Per-agent tool lists / allow-lists | ContextForge virtual servers; Cloudflare (admins choose tools per portal, allowlist); Kong (global and per-tool ACLs by Consumer and Consumer Group); agentgateway ("scope which tools each identity may invoke"); Docker (`--profile`) |
| Central authentication, credential isolation | Docker ("supplies required credentials to servers"); Cloudflare ("attaches the appropriate credentials"); ContextForge (stored credentials encrypted with `AUTH_ENCRYPTION_SECRET`, "Encryption key for stored credentials"); MCP spec forbids token passthrough |
| Rate limits / quotas | ContextForge (`tool_rate_limit: int = 100  # requests per minute`, rate-limiting middleware); Kong; MCP spec (servers MUST rate limit) |
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
| Docker MCP Gateway | "Docker's open source solution for orchestrating Model Context Protocol (MCP) servers" | MCP Gateway, MCP Toolkit, MCP Catalog, profile | https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/ |
| Microsoft MCP Gateway | "a reverse proxy and management layer for MCP servers"; "Tool gateway router" is a component name | MCP Gateway, control plane, data plane, tool router | https://github.com/microsoft/mcp-gateway |
| Cloudflare MCP server portals | "An MCP server portal centralizes multiple Model Context Protocol (MCP) servers onto a single HTTP endpoint" (formerly "Agents Gateway", per secondary sources, **UNVERIFIED**) | MCP server portal | https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ |
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
  server,' never just 'server'" (https://ibm.github.io/mcp-context-forge/latest/overview/terminology/;
  that page is newer than 1.0.10 and is not in the v1.0.10 tree).
- **Discovery.** On registration ContextForge connects to the server, asks for its tools and
  stores them (federation). ADR-0011: tools changed upstream show up after a
  deactivate/activate or edit (https://ibm.github.io/mcp-context-forge/architecture/adr/011-tool-federation/).
- **Naming.** Exposed name = `slugify(gateway name)` + `GATEWAY_TOOL_NAME_SEPARATOR` (default
  `-`; allowed `-`, `--`, `_`, `.`) + tool name; the server-side `original_name` is kept and
  used when the call is forwarded (ADR-0011). In the lab the tool name is slugified too:
  `get_weather` → `weather-tools-get-weather` (real `tools/list` output in short.yaml).
- **Virtual servers.** "Create a virtual server bundling those tools" (README). A virtual
  server is the `Server` model, "ORM model for MCP Servers Catalog ... a server that composes
  catalog items (tools, resources, prompts)"; tools and servers are linked many-to-many
  (`server_tool_association`), so one tool can be in several virtual servers. Endpoint
  `/servers/<id>/mcp` (Streamable HTTP) and `/servers/<id>/sse`. `tools/list` on it returns
  only its associated tools.
- **Auth.** JWT bearer tokens, Basic, OAuth, SSO; RBAC with teams; "Server-scoped tokens are
  restricted to specific MCP servers and cannot access admin endpoints" (securing.md).
  Upstream credentials stored encrypted with `AUTH_ENCRYPTION_SECRET`. Lab: trusted-proxy
  header, no tokens.
- **Rate limiting.** `tool_rate_limit = 100` requests/minute and a rate-limiting middleware
  (`rate_limiting_enabled` default true). Lab: `RATE_LIMITING_ENABLED=false`.
- **Metrics and logs.** Per-call rows in table `tool_metrics` with `tool_id`, `timestamp`,
  `response_time`, `is_success`, `error_message` (no caller, no result value). An optional
  `AuditTrail` table records `user_email`, `action`, `resource_type`..., but
  `audit_trail_enabled` defaults to **false**; the lab does not enable it. Also
  OpenTelemetry tracing and optional Prometheus metrics.
- **Unknown tool** through `/servers/<id>/mcp`: HTTP 200 + `isError: true` (see 2.6).

## 5. Real in the lab vs illustrative

| Claim a video might make | Lab-real? | Evidence |
|---|---|---|
| Two toy MCP servers, `weather-tools` (`get_weather`, `get_forecast`) and `calculator-tools` (`add`, `subtract`, `multiply`), Streamable HTTP | Real | `workspace/tools/*.py`, manifest |
| Weather data | **Made up**: deterministic from the city name; Leeds → 10 °C, cloudy | `weather_tool_server.py` (`10 + seed % 25`, seed 525 for "leeds") |
| ContextForge 1.0.10 is the MCP gateway; both servers registered | Real | manifest, `seed_contextforge.py` |
| Virtual server `toy-tools` with all **5** tools, nothing left out | Real | seed script (all tools of both gateways), real `--list` output |
| Endpoint `/servers/<id>/mcp`; the id is a uuid4 hex created at seed time | Real; the exact id differs per lab session (**UNVERIFIED** that it is stable) | seed script; ContextForge ids default `uuid.uuid4().hex` |
| Prefixed names `calculator-tools-add`, `weather-tools-get-weather` | Real | real output |
| `calculator-tools-add` 17 + 25 → `42.0`, with `structuredContent: {"result": 42.0}` | Real | real output in short.yaml |
| `does-not-exist` → HTTP 200, `isError: true`, "Tool not found: does-not-exist" | Real | real output; `_harness.py`; solution answers.json |
| View tab call log: tool, time, success, response time, error | Real | `view_service.py` reads `tool_metrics` |
| The log shows **who** called | **Not in the lab**: no caller column, and every call is the same admin identity | `view_service.py` SQL; manifest |
| The log records the result value (42.0) | **No** | `tool_metrics` has no result column |
| A call to `does-not-exist` adds a row to the view log | **Probably not** (`tool_metrics.tool_id` is a NOT NULL foreign key to an existing tool); **UNVERIFIED** by a live run | ContextForge `db.py` |
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
   to an unknown tool most likely adds no row (UNVERIFIED).
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

**`brief.md`**: "Every call adds a row to the log in the view tab." → most likely not for a
call to an unregistered tool (UNVERIFIED; check live). "MCP servers (the registered
gateways)" is correct.

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

- Exact `mcp` SDK version installed in the lab image (only `>=1.28.1,<2` known).
- Whether a call to `does-not-exist` adds a row to `tool_metrics` / the view tab (schema
  says no; not run live).
- What HTTP status and body ContextForge 1.0.10 returns through `/servers/<id>/mcp` for a
  misspelt *method* (e.g. `tools/calll`); the spec example `-32601 Method not found` is used
  in the scripts as an illustration.
- Whether the virtual server id is the same across lab sessions.
- MCP's exact introduction day in November 2024.
- Cloudflare MCP server portals' release stage and the "formerly Agents Gateway" name
  (secondary sources only).
- How much of ContextForge's admin UI metrics page the learner sees in 1.0.10 (not opened
  live).
