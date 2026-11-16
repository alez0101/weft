---
title: Personal agents
parent: Weft admin
summary: Bringing someone's own AI agent (such as Hermes Agent) into Weft, and what it can see.
---
A personal agent is someone's own AI agent that Weft talks to on their behalf: anything with an OpenAI-compatible chat address, such as the API server of a self-hosted Hermes Agent or an OpenClaw gateway. Its owner gets it in their chat list, can start as many conversations with it as they like, and can @mention it in channels they are in.

### Adding one

In **Settings**, under **Personal agents**, choose **Add an agent**:

- **Name**: what people see on its replies, for example "Sam's Hermes".
- **@name**: how its owner mentions it in channels (2 to 30 lowercase letters, numbers or dashes; not "weft"). Each @name is used once.
- **Whose agent**: the one person who can talk to it.
- **Address**: the base of its chat API, ending in `/v1` (Weft calls `<address>/chat/completions`). It must be reachable from the Weft server. Only admins can set an address, so nobody else can make Weft call a place of their choosing.
- **Model**: the model name the agent expects. For Hermes Agent this is `hermes-agent`; for OpenClaw it is `openclaw` (its default agent) or `openclaw/<agent id>`.

Then paste its **Key** (for Hermes Agent: `API_SERVER_KEY`; for OpenClaw: the gateway token, which gives full operator access, so keep the gateway off the public internet) and press **Test connection**. The test only lists the agent's models, so it does not start a conversation or cost anything. Keys are encrypted and cannot be shown again.

**Enabled** off stops it answering and stops new conversations; its owner keeps the old ones. Changing **Whose agent** removes the previous owner's conversations with it. **Remove** deletes the agent and all its conversations; replies it left in channels stay, marked "(removed)". The card shows when it was last asked and the last error, if any.

### How it works

- Each conversation (and each channel) is its own session on the agent: Weft sends `weft-<space id>` as the `X-Hermes-Session-Id` header (Hermes Agent), the `x-openclaw-session-key` header and the OpenAI `user` field (OpenClaw), and the agent keeps the history. Weft sends only the new message. Agents that ignore the header still work, but each message reaches them on its own, without the earlier ones.
- In a channel or direct message, Weft also sends the last 15 messages there and says which channel it is. Nothing from other spaces is sent. The answer goes to the owner's **personal space**, starting "Answer to your question in #channel:", never to the channel (070, enforced by the database). If the channel's owners turned off **Allow AI agents to read this channel**, the question is refused and the agent is not called.
- Questions are answered in the background: the owner's message is accepted at once and the reply arrives live. One question at a time per conversation; different conversations can ask at the same time. Weft waits up to 10 minutes (`AGENT_TIMEOUT_MS` on the assistant service), then posts a short error reply.
- The agent has a Weft user row (marked as an assistant), so it cannot sign in, is not listed among people, and its replies are not indexed for search by meaning. Its replies are written with a token for its owner, and the database checks that the author really is that person's agent.
- Conversations are spaces of kind `agent` with only the owner as a member, so row-level security keeps them private like everything else.

The agent cannot read Weft. To let it read and edit its owner's documents, tasks and calendar, connect the agent to Weft's connector (see AI app connector) as its owner: it then sees exactly what they can see.

OpenClaw's chat address is off by default: turn on `gateway.http.endpoints.chatCompletions.enabled` in its config first.

### Weft access for an agent (075)

**Give access** on an agent's card makes a connector key for it, acting for its **owner**: the same kind of
grant Claude gets from the consent screen, so the same rules apply (every token is an AI-app token: it reads
what the owner can see, writes only in the owner's Personal space, never deletes, and skips channels whose
owners turned AI agents off). The key and the address (`<your Weft address>/mcp`) are shown once; configure
the agent's MCP client with them (HTTP transport, `Authorization: Bearer <key>`). Keys last a year; **Make a
new key** replaces the old one, **Disconnect** ends it, and so do removing the agent or giving it to another
owner. The owner sees it under Connected apps and can disconnect it there. Only the key's hash is stored.
