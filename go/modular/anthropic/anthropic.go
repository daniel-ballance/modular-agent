// Package anthropic provides the Anthropic Messages API Provider.
package anthropic

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	base "github.com/daniel-ballance/modular-agent/go/anthropic"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/modelcatalog"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type Option func(*options)
type options struct {
	endpoint string
	model    string
	client   *http.Client
	custom   []modular.ModelInfo
}

func WithEndpoint(url string) Option            { return func(o *options) { o.endpoint = url } }
func WithHTTPClient(client *http.Client) Option { return func(o *options) { o.client = client } }
func WithModel(id string) Option                { return func(o *options) { o.model = id } }

// WithModels enrolls additional models, including their limits and input types.
func WithModels(models ...modular.ModelInfo) Option {
	return func(o *options) { o.custom = append(o.custom, models...) }
}

func New(opts ...Option) modular.Provider {
	var o options
	for _, opt := range opts {
		opt(&o)
	}
	models := func() []modular.ModelInfo { return modelcatalog.Models("anthropic", o.model, o.custom) }
	return modular.Provider{
		ID:     "anthropic",
		Models: models,
		Request: func(ctx context.Context, model modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
			var request portable.Object
			if err := json.Unmarshal(api.JSON(r), &request); err != nil {
				return modular.AssistantMessage{}, err
			}
			var maxOutput int
			for _, info := range models() {
				if info.ID == model.ID {
					maxOutput = info.MaxOutput
					break
				}
			}
			access := base.NewModelAccessWithLimit(model.ID, maxOutput, o.endpoint, o.client, func(context.Context) (string, error) { return pc.Credential() })
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
