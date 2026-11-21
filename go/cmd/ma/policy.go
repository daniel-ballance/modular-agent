package main

import "github.com/daniel-ballance/modular-agent/go/modular"

type operatorPolicy = modular.ACPPolicy

func readPolicy(path string, optional bool) (operatorPolicy, error) {
	return modular.ReadACPPolicy(path, optional, false)
}
