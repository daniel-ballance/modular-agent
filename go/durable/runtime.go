// Package durable resumes interrupted turns from committed history boundaries.
package durable

import (
	"modular/api"
	"modular/turnrun"
)

type Runtime = turnrun.Runner

func Plugin() api.Plugin {
	return api.Plugin{Name: "durable", Setup: func(a api.API) error {
		for name, rule := range api.RuntimeHooks() {
			if err := a.Define(name, rule); err != nil {
				return err
			}
		}
		return a.Provide("runtime", &Runtime{Durable: true})
	}}
}
