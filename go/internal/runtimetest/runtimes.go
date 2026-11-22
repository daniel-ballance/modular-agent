// Package runtimetest runs the same plugin-facing acceptance cases with either Runtime.
package runtimetest

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/transient"
	"strings"
	"testing"
)

// StopsOnCrash reports whether the installed working environment can confirm
// cleanup of prior work. Process-group containment does not make that promise.
func StopsOnCrash(t *testing.T, a api.API) bool {
	t.Helper()
	v, err := a.Get("working-environment")
	if err != nil {
		t.Fatal(err)
	}
	return v.(api.WorkingEnvironment).StopsOnCrash()
}

func Each(t *testing.T, run func(*testing.T)) {
	for _, name := range []string{"transient", "durable"} {
		t.Run(name, run)
	}
}
func Plugin(t *testing.T) api.Plugin {
	for _, part := range strings.Split(t.Name(), "/") {
		if part == "durable" {
			return durable.Plugin()
		}
	}
	return transient.Plugin()
}
