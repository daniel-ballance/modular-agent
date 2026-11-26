export const HELP = `ma, the standard Modular Agent

Usage:
  ma [options]                 talk to the agent in this folder
  ma [options] -p PROMPT       answer one prompt and exit
  ma login PROVIDER [--device] sign in: chatgpt, grok or claude
  ma logout PROVIDER
  ma auth                      show what is signed in
  ma models                    list the models on offer
  ma skills                    list the skills found for this folder
  ma mcp                       list the configured MCP servers
  ma sessions [--all]          list saved sessions

Options:
  --model PROVIDER/ID   for example chatgpt/gpt-6.1-sol, grok/grok-4.7, claude/claude-sonnet-5-5
  --thinking LEVEL      off, minimal, low, medium, high or xhigh, as the model allows
  --session ID          reopen a session
  -c, --continue        reopen this folder's most recent session
  --project DIR         work in DIR instead of the current folder
  --trust-project       let this project's .mcp.json start programs
  --runtime KIND        durable (default: a turn cut off by a crash carries on) or transient
  -v, --verbose         also show each call the code makes and what commands print
  --json                print every event as a JSON line
  --history             print the session's history
  --declaration         print what this agent declares it supports
  --acp                 serve the Agent Client Protocol on stdio, for an editor or host
  --agui                serve AG-UI over HTTP and SSE; requires --listen
  --approval POLICY     set each new session's default approval policy: off, ask, all or never
  --resume-open         reopen interrupted turns before serving --acp or --agui
  --listen ADDR         loopback listener for --agui, --acp, or both
  --token-file FILE     configure a single local token for --listen
  --policy FILE         read operator policy instead of policy.json

While the agent works, a line you type steers it; /after TEXT queues a new
turn; /cancel or Ctrl-C stops the turn. /commands lists the rest, including
/model, /thinking, /compact, /skills and /skill:NAME.

Files: settings.json, mcp.json, models.json, AGENTS.md and skills/ in
~/.config/modular-agent. Sessions are kept in ~/.local/state/modular-agent/typescript.`;
