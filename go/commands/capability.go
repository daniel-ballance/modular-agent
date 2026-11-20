package commands

import "github.com/daniel-ballance/modular-agent/go/api"

func has(a api.API, name string) bool { _, err := a.Get(name); return err == nil }
