package modular_test

import (
	"context"
	"fmt"
	"log"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestSaysHello(t *testing.T) {
	ctx := context.Background()
	agent := modulartest.Agent(t, modulartest.Script(`[{"text": "Hello."}]`))
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	turn, err := session.Prompt(ctx, "Say hello.")
	if err != nil {
		t.Fatal(err)
	}
	if turn.Text != "Hello." {
		t.Fatalf("got %q", turn.Text)
	}
}

func TestStreamTheAnswer(t *testing.T) {
	ctx := t.Context()
	agent := modulartest.Agent(t, modulartest.Script(`[{"text":"A harbour."}]`))
	session, err := agent.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got strings.Builder
	var last modular.Event
	// The guide's loop uses the same iterator with a real session.
	for event, err := range session.PromptStream(ctx, "Describe Whitby harbour in two sentences.") {
		if err != nil {
			log.Fatal(err)
		}
		if text, ok := event.(modular.TextEvent); ok {
			fmt.Print(text.Delta)
		}
		if text, ok := event.(modular.TextEvent); ok {
			got.WriteString(text.Delta)
		}
		last = event
	}
	if got.String() != "A harbour." || last == nil || last.Header().Type != "turnEnded" {
		t.Fatalf("stream: %q; last event: %#v", got.String(), last)
	}
}

type TideInput struct {
	Harbour string `json:"harbour" jsonschema:"The harbour to look up."`
}

var Tide = modular.NewTool("tide", "Today's high tide at a harbour.",
	func(ctx context.Context, in TideInput, tc *modular.ToolContext) (string, error) {
		return fmt.Sprintf("High tide at %s is 14:02.", in.Harbour), nil
	},
	modular.ReadOnly())

func TestLooksUpTheTide(t *testing.T) {
	ctx := context.Background()
	agent := modulartest.Agent(t,
		modular.WithTool(Tide),
		modulartest.Script(`[
			{"toolCalls": [{"name": "tide", "input": {"harbour": "Whitby"}}]},
			{"text": "High tide is at 14:02."}
		]`))
	session, _ := agent.Session(ctx)
	turn, err := session.Prompt(ctx, "When is high tide at Whitby?")
	if err != nil {
		t.Fatal(err)
	}
	results := turn.ToolResults()
	if turn.Text != "High tide is at 14:02." || results[0].Status != modular.Completed ||
		results[0].Text() != "High tide at Whitby is 14:02." {
		t.Fatalf("got %q and %+v", turn.Text, results)
	}
}
