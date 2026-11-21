package apikeymodels

import (
	"bytes"
	"os"
	"testing"
)

func TestShippedTable(t *testing.T) {
	want, err := os.ReadFile("../../../docs/sdk/api-key-models.json")
	if err != nil || !bytes.Equal(want, source) {
		t.Fatalf("shipped table differs from the specification: %v", err)
	}
}
