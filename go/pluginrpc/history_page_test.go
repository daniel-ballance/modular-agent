package pluginrpc

import (
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
	"testing"
)

func TestHistoryPageFirstEntryFitsWithoutCursor(t *testing.T) {
	first := api.Entry{ID: "first", Kind: "vendor.record", Data: api.JSON("")}
	encoded, err := json.Marshal(entryOut(first))
	if err != nil {
		t.Fatal(err)
	}
	first.Data = api.JSON(strings.Repeat("x", maxHistoryPage-len(`{"entries":[]}`)-len(encoded)))
	second := api.Entry{ID: "second", Parent: first.ID, Kind: "vendor.record"}
	s := api.Session{Entries: []api.Entry{first, second}, Position: second.ID}
	got, err := historyPage(s, object{})
	if err != nil || str(got.(object), "next") != first.ID || len(got.(object)["entries"].([]json.RawMessage)) != 1 {
		t.Fatal(err)
	}
	tail, err := historyPage(s, object{"after": first.ID})
	if err != nil || len(tail.(object)["entries"].([]json.RawMessage)) != 1 || has(tail.(object), "next") {
		t.Fatal(tail, err)
	}
	s.Entries[0].Data = api.JSON(strings.Repeat("x", maxHistoryPage))
	if _, err := historyPage(s, object{}); Code(err) != "result_too_large" {
		t.Fatal(err)
	}
}
