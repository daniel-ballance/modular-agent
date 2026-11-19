// Package transient runs turns only while its process lives.
package transient

import (
	"modular/api"
	"modular/turnrun"
)

type Runtime = turnrun.Runner

func Plugin() api.Plugin {
	return api.Plugin{Name: "transient", Setup: func(a api.API) error {
		for name, rule := range api.RuntimeHooks() {
			if err := a.Define(name, rule); err != nil {
				return err
			}
		}
		return a.Provide("runtime", &Runtime{})
	}}
}
