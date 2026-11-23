// The verifier reads the sample and runs one fixed test command. Its scripted
// Provider copies the actual test result into the post, not a predicted verdict.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const command = "python3 -B test_limits.py"
const script = `[
 {"toolCalls":[{"name":"read","input":{"path":"limits.py"}}]},
 {"toolCalls":[{"name":"exec","input":{"command":"python3 -B test_limits.py"}}]},
 {"toolCalls":[{"name":"post","input":{}}]},
 {"text":"Verification finished."}
]`

func model() modular.Provider {
	p := modulartest.ScriptedProvider(nil)
	p.Request = func(ctx context.Context, ref modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
		var replies []modulartest.Reply
		if err := json.Unmarshal([]byte(script), &replies); err != nil {
			return modular.AssistantMessage{}, err
		}
		for _, m := range r.Messages {
			if m.Role == "toolResult" && m.ToolName == "exec" {
				verdict := m.Content.Text()
				if m.IsError || !(strings.HasPrefix(verdict, "PASS: ") || strings.HasPrefix(verdict, "FAIL: ")) {
					verdict = "FAIL: the test command did not return a result"
				}
				args, err := json.Marshal(map[string]string{"kind": "verdict", "text": verdict})
				if err != nil {
					return modular.AssistantMessage{}, err
				}
				replies[2].ToolCalls[0].Input = args
			}
		}
		return modulartest.ScriptedProvider(replies).Request(ctx, ref, r, pc)
	}
	return p
}

type pathInput struct {
	Path string `json:"path"`
}
type cmdInput struct {
	Command string `json:"command"`
}

func read(ctx context.Context, p pathInput, c *modular.ToolContext) (string, error) {
	switch p.Path {
	case "limits.py", "test_limits.py", "cases.json":
	default:
		return "", errors.New("not a sample file")
	}
	b, err := c.Environment.Read(ctx, p.Path)
	return string(b), err
}
func test(ctx context.Context, p cmdInput, c *modular.ToolContext) (string, error) {
	if p.Command != command {
		return "", errors.New("only the sample test command is allowed")
	}
	result, err := c.Environment.Exec(ctx, command, 5*time.Second, nil)
	if err != nil {
		return "", err
	}
	verdict := "FAIL: "
	if result.ExitCode != nil && *result.ExitCode == 0 && !result.TimedOut {
		verdict = "PASS: "
	}
	return verdict + strings.TrimSpace(result.Output), nil
}
func run() error {
	ctx := context.Background()
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" && os.Getenv("OTEL_SDK_DISABLED") != "true" {
		if exporter, err := otlptracehttp.New(ctx); err == nil {
			provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter))
			otel.SetTracerProvider(provider)
			defer provider.Shutdown(ctx)
		}
	}
	project := os.Getenv("DESK_PROJECT")
	a, err := modular.New(ctx, modular.WithProject(project), modular.WithDataDir(os.Getenv("MODULAR_AGENT_DATA_DIR")), modular.WithDurability(modular.Durable), modular.WithPluginHost(true),
		modular.WithProvider(model()), modular.WithModel(modulartest.ScriptedModel),
		modular.WithTool(modular.NewTool("read", "Read a sample file.", read, modular.ReadOnly())),
		modular.WithTool(modular.NewTool("list", "List the sample files.", func(ctx context.Context, _ struct{}, c *modular.ToolContext) ([]modular.DirEntry, error) {
			return c.Environment.List(ctx, ".")
		}, modular.ReadOnly())),
		modular.WithTool(modular.NewTool("exec", "Run the sample tests.", test)))
	if err != nil {
		return err
	}
	defer a.Close(ctx)
	server, err := a.ServeAGUI(ctx, modular.ServeAGUIOptions{Listen: "127.0.0.1:0", Actors: []modular.ACPActor{{TokenFile: os.Getenv("DESK_TOKEN_FILE"), ClientID: "ops-desk", TrustTrace: true, Projects: []string{project}, Actor: modular.Actor{ID: "desk", Kind: "user", Rights: []string{"watch", "input", "tools", "answer", "approve"}}}}})
	if err != nil {
		return err
	}
	defer server.Close()
	stop, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	fmt.Println(server.URL)
	<-stop.Done()
	return nil
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
