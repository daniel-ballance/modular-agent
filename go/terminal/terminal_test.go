package terminal_test

import (
	"bytes"
	"context"
	"io"
	"modular/api"
	"modular/commands"
	"modular/configuration"
	"modular/contextview"
	"modular/fake"
	"modular/harness"
	"modular/internal/runtimetest"
	"modular/modelselect"
	"modular/terminal"
	"strings"
	"testing"
)

func TestPrintJSONAndInteractiveLineModes(t *testing.T) {
	runtimetest.Each(t, testPrintJSONAndInteractiveLineModes)
}
func testPrintJSONAndInteractiveLineModes(t *testing.T) {
	for _, mode := range []string{"print", "json", "line"} {
		t.Run(mode, func(t *testing.T) {
			h := harness.New()
			defer h.Close()
			p := fake.New(fake.Script{Chunks: []api.Part{{Type: "text", Text: "answer"}}, Response: api.Response{Content: api.Text("answer"), Stop: "finished"}})
			for _, plugin := range []api.Plugin{configuration.Plugin("", api.Settings{Model: "fake", Thinking: "off", MaxSteps: 3, MaxOutput: 100}), p.Plugin(), modelselect.Plugin(), runtimetest.Plugin(t), contextview.Plugin(), commands.Plugin(), terminal.Plugin()} {
				if err := h.Load(plugin); err != nil {
					t.Fatal(err)
				}
			}
			v, err := h.API().Get("interface.terminal")
			if err != nil {
				t.Fatal(err)
			}
			var out, stderr bytes.Buffer
			input := ""
			prompt := "hello"
			if mode == "line" {
				input = "/settings\nhello\n"
				prompt = ""
			}
			err = v.(*terminal.Terminal).Run(context.Background(), terminal.Options{Project: t.TempDir(), Mode: mode, Prompt: prompt}, io.NopCloser(strings.NewReader(input)), &out, &stderr)
			if err != nil {
				t.Fatal(err, stderr.String())
			}
			if !strings.Contains(out.String(), "answer") || len(p.Requests()) != 1 {
				t.Fatal(out.String(), len(p.Requests()))
			}
			if mode == "json" && !strings.Contains(out.String(), `"kind":"turn.end"`) {
				t.Fatal(out.String())
			}
			if mode == "print" && out.String() != "answer\n" {
				t.Fatal(out.String())
			}
		})
	}
}
