// Package anthropic provides the Anthropic Messages API Provider.
package anthropic

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"

	base "github.com/OWNER/modular-agent/go/anthropic"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/modular"
	"github.com/OWNER/modular-agent/go/portable"
)

type Option func(*options)
type options struct {
	endpoint string
	client   *http.Client
}

func WithEndpoint(url string) Option            { return func(o *options) { o.endpoint = url } }
func WithHTTPClient(client *http.Client) Option { return func(o *options) { o.client = client } }
func New(opts ...Option) modular.Provider {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	return modular.Provider{
		ID: "anthropic",
		Models: func() []modular.ModelInfo {
			b := base.NewAccess(o.endpoint, o.client, nil).Model()
			return []modular.ModelInfo{{ModelRef: modular.ModelRef{Provider: "anthropic", ID: b.ID}, ContextWindow: b.Context, MaxOutput: b.Output, Input: []string{"text"}, Reasoning: true}}
		},
		Available: func() bool { return os.Getenv("ANTHROPIC_API_KEY") != "" },
		Request: func(ctx context.Context, _ modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
			var request portable.Object
			if err := json.Unmarshal(api.JSON(r), &request); err != nil {
				return modular.AssistantMessage{}, err
			}
			access := base.NewAccess(o.endpoint, o.client, func(context.Context) (string, error) { return pc.Credential() })
			response, err := access.Generate(ctx, portable.ReadRequest(request), func(p api.Part) { pc.Piece(p.Type, p.Text) })
			if err != nil {
				var m *api.ModelError
				if errors.As(err, &m) {
					kind := modular.ModelErrorKind(m.Kind)
					if m.Kind == "context_too_large" {
						kind = modular.ContextTooLarge
					}
					return modular.AssistantMessage{}, &modular.ModelError{Kind: kind, Message: m.Message}
				}
				return modular.AssistantMessage{}, err
			}
			var out modular.AssistantMessage
			err = json.Unmarshal(api.JSON(portable.Response(response)), &out)
			return out, err
		},
	}
}
