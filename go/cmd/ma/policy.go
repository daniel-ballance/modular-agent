package main

import "github.com/daniel-ballance/modular-agent/go/internal/operatorpolicy"

type operatorPolicy = operatorpolicy.Policy

func readPolicy(path string, optional bool) (operatorPolicy, error) {
	return operatorpolicy.Read(path, optional, false)
}
