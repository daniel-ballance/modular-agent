// Package terminal provides interactive line, print, and JSON event Interfaces.
package terminal

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"io"
	"strings"
	"sync"
)

type Terminal struct{ a api.API }
type Options struct {
	Project, Session, Mode, Prompt, Key string
	WaitJobs                            bool
}

func Plugin() api.Plugin {
	return api.Plugin{Name: "terminal", Setup: func(a api.API) error {
		if err := a.RegisterCommand("cancel", func(ctx context.Context, id string, args []string) (string, error) {
			return "Cancelled. Queued input is returned below.", a.CancelAs(ctx, id)
		}); err != nil {
			return err
		}
		return a.Provide("interface.terminal", &Terminal{a})
	}}
}

// Run owns and closes input in line mode, so cancellation unblocks terminal reads.
func (t *Terminal) Run(ctx context.Context, opt Options, input io.ReadCloser, stdout, stderr io.Writer) error {
	if opt.Mode == "" {
		opt.Mode = "line"
	}
	if opt.Mode != "line" && opt.Mode != "print" && opt.Mode != "json" {
		return errors.New("mode must be line, print or json")
	}
	id := opt.Session
	var err error
	if id == "" {
		id, err = t.a.New(ctx, opt.Project)
	}
	if err != nil {
		return err
	}
	var mu sync.Mutex
	streamed := map[string]bool{}
	unsubscribe := t.a.Subscribe(func(e api.Event) {
		if e.Session != id {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if opt.Mode == "json" {
			_, _ = fmt.Fprintln(stdout, string(api.JSON(e)))
			return
		}
		switch e.Kind {
		case "question.open":
			q := api.Decode[api.Question](e.Data)
			_, _ = fmt.Fprintf(stderr, "question %s [%s]: %s %v\n", q.ID, q.Kind, q.Prompt, q.Options)
		case "interface.session":
			_, _ = fmt.Fprintln(stderr, "session:", id)
		case "model.delta":
			if opt.Mode == "line" {
				p := api.Decode[api.Part](e.Data)
				if p.Type == "text" || p.Type == "reasoning" {
					_, _ = fmt.Fprint(stdout, p.Text)
					streamed[e.Turn] = true
				}
			}
		case "tool.progress":
			_, _ = fmt.Fprint(stderr, api.Decode[string](e.Data))
		case "turn.end":
			if opt.Mode == "line" {
				out := api.Decode[api.Outcome](e.Data)
				if !streamed[e.Turn] {
					_, _ = fmt.Fprint(stdout, out.Result.Text())
				}
				_, _ = fmt.Fprintln(stdout)
				if out.Error != "" {
					_, _ = fmt.Fprintln(stderr, out.Error)
				}
			}
		case "interface.message":
			_, _ = fmt.Fprintln(stdout, api.Decode[string](e.Data))
		case "interface.error":
			_, _ = fmt.Fprintln(stderr, api.Decode[string](e.Data))
		case "input.returned":
			for _, in := range api.Decode[[]api.Input](e.Data) {
				_, _ = fmt.Fprintln(stderr, "returned input:", in.Content.Text())
			}
		}
	})
	defer unsubscribe()
	var disconnect func()
	if opt.Mode == "line" {
		if v, e := t.a.Get("questions"); e == nil {
			disconnect = v.(api.Questions).Connect(id, "local-user")
			defer disconnect()
		}
	}
	if opt.Session != "" {
		if err = t.a.Open(ctx, id); err != nil {
			return err
		}
	}
	defer func() {
		if ctx.Err() != nil {
			_ = t.a.StopSession(id)
		} else {
			_ = t.a.CloseSession(id)
		}
	}()
	t.a.Emit(ctx, api.Event{Kind: "interface.session", Session: id, Data: api.JSON(id)})
	noTurn := false
	submit := func(line string) error {
		if strings.HasPrefix(line, "/answer ") || strings.HasPrefix(line, "/secret ") {
			return t.answer(ctx, id, line)
		}
		when := "now"
		if strings.HasPrefix(line, "/after ") {
			when = "after"
			line = strings.TrimPrefix(line, "/after ")
		} else if strings.HasPrefix(line, "/steer ") {
			when = "steer"
			line = strings.TrimPrefix(line, "/steer ")
		} else if opt.Mode == "line" {
			when = "steer"
		}
		receipt, err := t.a.Submit(ctx, id, api.Input{Key: opt.Key, When: when, Content: api.Text(line)})
		if err != nil {
			t.a.Emit(ctx, api.Event{Kind: "interface.error", Session: id, Data: api.JSON(err.Error())})
			return err
		}
		noTurn = receipt.Duplicate || receipt.When == "command"
		if receipt.Command != "" {
			t.a.Emit(ctx, api.Event{Kind: "interface.message", Session: id, Data: api.JSON(receipt.Command)})
		}
		if receipt.Duplicate {
			t.a.Emit(ctx, api.Event{Kind: "interface.message", Session: id, Data: api.JSON("Already accepted: " + receipt.ID)})
		}
		return nil
	}
	if opt.Mode != "line" {
		if opt.Prompt == "" && opt.Session == "" {
			return errors.New("print/json mode requires a prompt or session")
		}
		if opt.Prompt != "" {
			if err = submit(opt.Prompt); err != nil {
				return errors.New("input refused")
			}
		}
		if noTurn {
			return nil
		}
		out, err := t.a.Wait(ctx, id)
		if err != nil {
			return err
		}
		if opt.WaitJobs {
			if v, e := t.a.Get("jobs"); e == nil {
				jobs := v.(api.Jobs)
				waited := map[string]bool{}
				for {
					list, e := jobs.List(id)
					if e != nil {
						return e
					}
					pending := false
					for _, job := range list {
						if waited[job.ID] {
							continue
						}
						// An ended job can still be publishing its report.
						if _, e = jobs.Wait(ctx, id, job.ID); e != nil {
							return e
						}
						waited[job.ID] = true
						pending = true
					}
					out, e = t.a.Wait(ctx, id)
					if e != nil {
						return e
					}
					if !pending {
						break
					}
				}
			}
		}
		if opt.Mode == "print" && out.Status != "" {
			t.a.Emit(ctx, api.Event{Kind: "interface.message", Session: id, Data: api.JSON(out.Result.Text())})
		}
		if out.Status == "failed" || out.Status == "limit" {
			t.a.Emit(ctx, api.Event{Kind: "interface.error", Session: id, Data: api.JSON(out.Error)})
			return errors.New("turn did not complete")
		}
		return nil
	}
	scanCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer input.Close()
	lines := make(chan string)
	scanDone := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-scanCtx.Done():
				scanDone <- scanCtx.Err()
				return
			}
		}
		scanDone <- scanner.Err()
	}()
	if opt.Prompt != "" {
		_ = submit(opt.Prompt)
	}
	for {
		select {
		case <-ctx.Done():
			_ = t.a.Cancel(id)
			_ = input.Close()
			return ctx.Err()
		case err := <-scanDone:
			if disconnect != nil {
				disconnect()
				disconnect = nil
			}
			if err != nil {
				return err
			}
			_, err = t.a.Wait(ctx, id)
			return err
		case line := <-lines:
			if strings.TrimSpace(line) == "/quit" {
				_ = t.a.Cancel(id)
				return nil
			}
			if strings.TrimSpace(line) != "" {
				_ = submit(line)
			}
		}
	}
}
