package subscription

import (
	"net/http"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

const chatGPTEndpoint = "https://chatgpt.com/backend-api/codex/responses"

// ChatGPTModelOverride replaces the catalog entry for an operator-configured model.
type ChatGPTModelOverride = ResponsesModelOverride

// ChatGPTOptions configures the ChatGPT plan Provider. A nil ClientIdentity uses
// "modular-agent". Models enroll unlisted IDs without reasoning controls.
// HTTPTransport is optional and trusted with the login, including the refresh token.
type ChatGPTOptions struct {
	Logins           Logins
	ClientIdentity   *string
	Models           []modular.ModelInfo
	CatalogOverrides []ChatGPTModelOverride
	HTTPTransport    http.RoundTripper
}

// ChatGPT constructs the chatgpt Provider. It reads the login file at request time.
func ChatGPT(opts ChatGPTOptions) (modular.Provider, error) {
	config := responsesConfig{id: "chatgpt", label: "ChatGPT", endpoint: chatGPTEndpoint, legacyID: "openai-codex"}
	return responsesProvider(config, opts.Logins, opts.ClientIdentity, opts.Models, opts.CatalogOverrides, opts.HTTPTransport)
}
