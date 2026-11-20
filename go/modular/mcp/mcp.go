// Package mcp configures the SDK's MCP tool source. The source keeps tool
// lists current and also serves ACP's per-session MCP attachments.
package mcp

import "github.com/daniel-ballance/modular-agent/go/modular"

type Server = modular.MCPServer

// WithServers adds trusted MCP servers over stdio or Streamable HTTP.
// With a warning handler, a failed server is skipped and the others start.
func WithServers(servers []Server, warn func(error)) modular.Option {
	return modular.WithMCP(servers, warn)
}
