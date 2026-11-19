package mcptools_test

import (
	"modular/mcptools"
	"strings"
	"testing"
)

func TestMCPInvalidNamesAndClosedSourceCannotStartPrograms(t *testing.T) {
	_, m := newAgent(t)
	ctx := deadline(t)
	for _, name := range []string{"", "two__parts", "not.a.name"} {
		err := m.Add(ctx, "session", []mcptools.Server{{Name: name, Command: "/missing/should-not-start"}})
		if err == nil || !strings.Contains(err.Error(), "invalid or duplicate") {
			t.Fatal(name, err)
		}
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(ctx, "session", []mcptools.Server{stdio("closed")}); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatal("closed source started a program", err)
	}
}
