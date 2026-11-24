package modular

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"net/http"
)

func AGUIFixtureProbe(opt *ServeAGUIOptions, f func(string, string, string)) { opt.probe = f }

// Only the compiled conformance test program can install fixture hooks or observe writes.
func (a *Agent) AGUIFixturePorts() (api.API, func(api.Plugin) error) { return a.a, a.h.Load }
func (a *Agent) AGUIFixtureListener(ctx context.Context, opt ServeAGUIOptions, wrap func(http.ResponseWriter) http.ResponseWriter) (*Service, error) {
	return a.serveAGUI(ctx, opt, wrap)
}
