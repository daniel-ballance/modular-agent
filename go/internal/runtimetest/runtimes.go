// Package runtimetest runs the same plugin-facing acceptance cases with either Runtime.
package runtimetest

import (
	"modular/api"
	"modular/durable"
	"modular/transient"
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
