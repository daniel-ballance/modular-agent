package history_test

import (
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/history"
	"strings"
	"testing"
)

func BenchmarkSaveLongSession(b *testing.B) {
	store, err := history.New(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	lease, err := store.Acquire("long")
	if err != nil {
		b.Fatal(err)
	}
	defer lease.Close()
	snap := api.Session{Version: 1, ID: "long"}
	for i := 0; i < 300; i++ {
		id := fmt.Sprint(i)
		snap.Entries = append(snap.Entries, api.Entry{
			ID: id, Parent: snap.Position, Session: snap.ID, Kind: "model",
			Content: api.Text(strings.Repeat("a model response. ", 80)),
			Data:    api.JSON(api.Response{Stop: "finished"}),
		})
		snap.Position = id
	}
	if err := lease.Save(snap); err != nil {
		b.Fatal(err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if err := lease.Save(snap); err != nil {
			b.Fatal(err)
		}
	}
}
