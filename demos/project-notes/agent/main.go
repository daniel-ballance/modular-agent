// The project notes agent, composed from the Go SDK and two plugin placements.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/openai"
)

const prompt = `Use add_note once to add "The ferry leaves at 14:02." Then use search_notes to search for "ferry" and report the matching line.`

const script = `[
  {"toolCalls":[{"name":"add_note","input":{"note":"The ferry leaves at 14:02."}}]},
  {"toolCalls":[{"name":"search_notes","input":{"query":"ferry"}}]},
  {"text":"Found: The ferry leaves at 14:02."}
]`

func main() {
	log.SetFlags(0)
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) (err error) {
	project := flag.String("project", "", "absolute project directory")
	data := flag.String("data", "", "agent state directory")
	historyURL := flag.String("history", "", "history service URL")
	historyToken := flag.String("history-token", "", "history token file")
	environmentURL := flag.String("environment", "", "environment service URL")
	environmentToken := flag.String("environment-token", "", "environment token file")
	python := flag.String("python", "", "absolute path to the plugin's Python interpreter")
	tools := flag.String("tools", "", "absolute path to the notes plugin")
	model := flag.String("model", "scripted/script", "scripted/script or an openai model reference")
	pause := flag.Bool("pause-after-write", false, "pause the add_note tool after its write (crash check)")
	reopen := flag.String("reopen", "", "resume an existing session without a new prompt")
	flag.Parse()
	if !filepath.IsAbs(*python) || !filepath.IsAbs(*tools) {
		return errors.New("supply absolute paths to the Python interpreter and notes plugin")
	}

	toolPlugin := modular.ProcessPlugin{Command: []string{*python, *tools}}
	if *pause {
		toolPlugin.Env = map[string]string{"NOTES_DEMO_PAUSE_AFTER_WRITE": "1"}
	}
	provider := modular.WithProvider(openai.New())
	if *model == "scripted/script" {
		provider = modulartest.Script(script)
	}
	agent, err := modular.New(ctx,
		modular.WithProject(*project), modular.WithDataDir(*data),
		modular.WithDurability(modular.Durable),
		modular.WithHistory(modular.HTTPHistory(*historyURL, *historyToken)),
		modular.WithProcessPlugin(toolPlugin),
		modular.WithServicePlugin(modular.ServicePlugin{
			URL: *environmentURL, TokenFile: *environmentToken,
		}),
		provider, modular.WithModel(*model),
	)
	if err != nil {
		if *model != "scripted/script" {
			return errors.New("could not compose the agent for the requested OpenAI model")
		}
		return err
	}
	defer func() {
		if closeErr := agent.Close(ctx); closeErr != nil && err == nil {
			err = errors.New("could not close the agent")
		}
	}()
	if agent.Declaration()["continuesAfterRestart"] != true {
		return errors.New("agent does not declare durable recovery")
	}

	var turn *modular.PromptResult
	var session *modular.Session
	if *reopen == "" {
		session, err = agent.Session(ctx)
		if err != nil {
			return err
		}
		fmt.Println(session.ID()) // Give the runner the ID before starting the turn.
		result, err := session.Prompt(ctx, prompt)
		if err != nil {
			if *model != "scripted/script" {
				return errors.New("could not run the OpenAI prompt")
			}
			return err
		}
		turn = &result
	} else {
		session, err = agent.OpenSession(ctx, *reopen)
		if err != nil {
			return err
		}
		fmt.Println(session.ID())
		if err = session.WaitIdle(ctx); err != nil {
			return err
		}
		turn, err = session.LastTurn(ctx)
		if err != nil {
			return err
		}
	}
	if turn == nil || turn.Outcome == nil || turn.Outcome.Kind != "completed" {
		// A live service error is not a transcript and may carry vendor diagnostics.
		return errors.New("the turn did not complete")
	}
	return printTurn(turn)
}

type toolLine struct {
	Name   string             `json:"name"`
	Status modular.ToolStatus `json:"status"`
	Text   string             `json:"text"`
}

func printTurn(turn *modular.PromptResult) error {
	var tools []toolLine
	for _, result := range turn.ToolResults() {
		tools = append(tools, toolLine{result.Name, result.Status, result.Text()})
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"outcome": turn.Outcome.Kind, "text": turn.Text, "tools": tools, "turnId": turn.TurnID,
	})
}
