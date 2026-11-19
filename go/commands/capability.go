package commands

import "modular/api"

func has(a api.API, name string) bool { _, err := a.Get(name); return err == nil }
