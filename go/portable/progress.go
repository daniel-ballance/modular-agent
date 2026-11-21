package portable

import (
	"encoding/json"

	"github.com/daniel-ballance/modular-agent/go/api"
)

// ToolOutput converts progress to the binding event payload. Older sources
// emit only a string; content-bearing sources also expose the original parts.
func ToolOutput(call string, raw json.RawMessage) Object {
	out := Object{"toolCallId": call}
	var content api.Content
	if json.Unmarshal(raw, &content) == nil {
		out["chunk"] = content.Text()
		if content != nil {
			out["content"] = Content(content)
		}
	} else {
		out["chunk"] = api.Decode[string](raw)
	}
	return out
}
