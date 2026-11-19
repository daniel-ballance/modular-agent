// Package runtimetest runs the same plugin-facing acceptance cases with either Runtime.
package runtimetest

import (
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/durable"
	"github.com/OWNER/modular-agent/go/transient"
	"strings"
	"testing"
)

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
