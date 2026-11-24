package pluginrpc_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestJobProtocolFixture(t *testing.T) {
	name := os.Getenv("MODULAR_TEST_JOB_OWNER")
	if name == "" {
		return
	}
	type obj = map[string]any
	peer := pluginrpc.NewPeer(os.Stdin, os.Stdout)
	peer.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		p := api.Decode[obj](raw)
		value := func(text string) []obj { return []obj{{"type": "text", "text": text}} }
		end := func(id any, report bool) error {
			return peer.Call(ctx, "host/jobs/end", obj{"jobId": id, "outcome": obj{"kind": "completed"}, "report": report, "result": value("offline job report")}, nil)
		}
		var list struct {
			Jobs []obj `json:"jobs"`
		}
		switch method {
		case "plugin/initialize":
			return obj{"binding": pluginrpc.Binding, "name": name, "commands": []obj{{"name": name}}, "hooks": []obj{{"handlerId": 1, "hook": "session.start", "order": "normal"}}}, nil
		case "plugin/shutdown":
			return obj{}, nil
		case "jobs/cancel":
			return obj{}, peer.Call(ctx, "host/jobs/end", obj{"jobId": p["jobId"], "outcome": obj{"kind": "cancelled"}, "report": false}, nil)
		case "command/run":
			raw, ok := p["args"].(string)
			args := strings.Fields(raw)
			if !ok || len(args) != 2 {
				return nil, fmt.Errorf("expected a verb and key in argument text")
			}
			switch args[0] {
			case "start":
				start := obj{"parentRequestId": pluginrpc.RequestID(ctx), "kind": "offline", "key": args[1], "detail": obj{"label": args[1], "future": []int{17, 23}}}
				var first, second struct {
					JobID   string `json:"jobId"`
					Started bool   `json:"started"`
				}
				if err := peer.Call(ctx, "host/jobs/start", start, &first); err != nil {
					return nil, err
				}
				if err := peer.Call(ctx, "host/jobs/start", start, &second); err != nil {
					return nil, err
				}
				if !first.Started || second.Started || second.JobID != first.JobID {
					return nil, fmt.Errorf("key did not resolve once: %v / %v", first, second)
				}
				if err := peer.Send("host/jobs/progress", obj{"jobId": first.JobID, "content": value("offline progress")}); err != nil {
					return nil, err
				}
				return obj{"output": first.JobID}, nil
			case "intrude":
				if err := peer.Call(ctx, "host/jobs/unfinished", obj{"sessionId": p["sessionId"]}, &list); err != nil {
					return nil, err
				}
				if len(list.Jobs) != 0 {
					return nil, fmt.Errorf("saw a different owner's job")
				}
				return obj{}, end(args[1], false)
			case "end":
				return obj{}, end(args[1], false)
			}
		case "hook/handle":
			payload := api.Decode[obj](api.JSON(p["payload"]))
			if payload["resumed"] != true {
				return nil, nil
			}
			if err := peer.Call(ctx, "host/jobs/unfinished", obj{"sessionId": payload["sessionId"]}, &list); err != nil {
				return nil, err
			}
			for _, j := range list.Jobs {
				if j["key"] != "recover" {
					continue
				}
				detail := api.Decode[obj](api.JSON(j["detail"]))
				if j["kind"] != "offline" || j["actorId"] != "local-user" || detail["label"] != "recover" || string(api.JSON(detail["future"])) != "[17,23]" {
					return nil, fmt.Errorf("unfinished job lost its portable fields: %v", j)
				}
				if err := peer.Call(ctx, "host/jobs/resume", obj{"jobId": j["jobId"]}, nil); err != nil {
					return nil, err
				}
				if err := peer.Call(ctx, "host/jobs/resume", obj{"jobId": j["jobId"]}, nil); pluginrpc.Code(err) != "invalid_request" {
					return nil, fmt.Errorf("second resume: %v", err)
				}
				// Finish before returning from session.start to exercise admission while opening.
				for range 2 {
					if err := end(j["jobId"], true); err != nil {
						return nil, err
					}
				}
				var page struct {
					Entries []obj `json:"entries"`
				}
				if err := peer.Call(ctx, "host/history", obj{"sessionId": payload["sessionId"]}, &page); err != nil {
					return nil, err
				}
				key := "job:" + fmt.Sprint(j["jobId"])
				accepted := false
				for _, e := range page.Entries {
					d, _ := e["data"].(obj)
					if d["key"] == key {
						if e["kind"] == "input" {
							return nil, fmt.Errorf("report ran while session was opening")
						}
						accepted = accepted || e["kind"] == "inputAccepted"
					}
				}
				if !accepted {
					return nil, fmt.Errorf("report not accepted before host/jobs/end answered")
				}
			}
			return nil, nil
		}
		return nil, fmt.Errorf("unexpected request %s", method)
	}
	_ = peer.Run()
	os.Exit(0)
}

func TestRemoteJobOwnershipCancellationAndResume(t *testing.T) {
	root := t.TempDir()
	specs := func(names ...string) string {
		var out []pluginrpc.Spec
		for _, name := range names {
			out = append(out, pluginrpc.Spec{Command: []string{os.Args[0], "-test.run=^TestJobProtocolFixture$"}, Env: map[string]string{"MODULAR_TEST_JOB_OWNER": name}})
		}
		return string(api.JSON(out))
	}
	t.Setenv("MODULAR_AGENT_PLUGINS", specs("jobfixture", "jobprobe"))
	options := vanilla.Options{Project: root, History: filepath.Join(root, "history"), Provider: conformancemodel.Plugin(), Model: "conformance/echo"}
	h, err := vanilla.New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a := h.API()
	session, err := a.New(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := a.Get("jobs")
	jobs := v.(api.Jobs)
	progress := make(chan struct{}, 8)
	unsub := a.Subscribe(func(e api.Event) {
		if e.Kind == "job.progress" && e.Session == session && strings.Contains(string(e.Data), "offline progress") {
			progress <- struct{}{}
		}
	})
	defer unsub()
	start := func(key string) string {
		t.Helper()
		id, err := a.Command(ctx, session, "jobfixture start "+key)
		if err != nil || id == "" {
			t.Fatalf("start %s: %q, %v", key, id, err)
		}
		return id
	}
	stopped, recovered := start("cancel"), start("recover")
	select {
	case <-progress:
	case <-ctx.Done():
		t.Fatal("no job progress event")
	}
	if _, err := a.Command(ctx, session, "jobprobe intrude "+stopped); pluginrpc.Code(err) != "invalid_request" {
		t.Fatalf("cross-owner operation: %v", err)
	}
	if err := jobs.Cancel(ctx, session, stopped); err != nil {
		t.Fatal(err)
	}
	if job, err := jobs.Wait(ctx, session, stopped); err != nil || job.State != "cancelled" || job.Report {
		t.Fatalf("confirmed cancellation: %+v, %v", job, err)
	}
	if _, err := a.Command(ctx, session, "jobfixture end "+stopped); pluginrpc.Code(err) != "invalid_request" {
		t.Fatalf("duplicate end: %v", err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	// The stopped process did not cancel or complete its outstanding job.
	// With no owner loaded, a reopening host still lists it unfinished.
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	h, err = vanilla.New(options)
	if err != nil {
		t.Fatal(err)
	}
	a = h.API()
	if err := a.Open(ctx, session); err != nil {
		t.Fatal(err)
	}
	v, _ = a.Get("jobs")
	if job, err := v.(api.Jobs).Wait(ctx, session, recovered); err == nil || job.State != "running" {
		t.Fatalf("missing owner did not leave job unfinished: %+v, %v", job, err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MODULAR_AGENT_PLUGINS", specs("jobfixture"))
	h, err = vanilla.New(options)
	if err != nil {
		t.Fatal(err)
	}
	a = h.API()
	problems := make(chan string, 16)
	defer a.Subscribe(func(e api.Event) {
		if e.Kind == "plugin.problem" {
			problems <- string(e.Data)
		}
	})()
	if err := a.Open(ctx, session); err != nil {
		t.Fatal(err)
	}
	select {
	case problem := <-problems:
		t.Fatal(problem)
	default:
	}
	out, err := a.Wait(ctx, session)
	if err != nil || !strings.Contains(out.Result.Text(), "offline job report") {
		t.Fatalf("resumed report did not start its turn: %+v, %v", out, err)
	}
	snap, _ := a.Snapshot(session)
	var starts, ends, reports, turns int
	for _, e := range snap.Entries {
		wire := portable.Entry(e)
		data := api.Decode[map[string]any](api.JSON(wire["data"]))
		switch wire["kind"] {
		case "jobStarted":
			if e.Job == recovered {
				starts++
				rights := api.Decode[[]string](api.JSON(data["rights"]))
				if wire["writer"] != "jobfixture" || data["kind"] != "offline" || !slices.Equal(rights, api.Rights) {
					t.Fatal(wire)
				}
			}
		case "jobEnded":
			if e.Job == recovered {
				ends++
				if data["report"] != true {
					t.Fatal(wire)
				}
			}
		case "turnStart":
			by := api.Decode[api.TurnStarter](api.JSON(data["startedBy"]))
			if by.Kind == "job" && by.ID == recovered {
				turns++
				if e.Actor != api.JobActor(recovered) {
					t.Fatal(wire)
				}
			}
		case "input":
			if data["key"] == "job:"+recovered {
				reports++
				if ends != 1 || e.Content.Text() != "offline job report" {
					t.Fatal(wire)
				}
			}
		}
	}
	if starts != 1 || ends != 1 || reports != 1 || turns != 1 {
		t.Fatalf("got start/end/report/turn counts %d/%d/%d/%d", starts, ends, reports, turns)
	}
	if err := a.Grant(ctx, session, api.Actor{ID: "limited", Kind: "user", Rights: []string{"watch", "input"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Command(api.AsActor(ctx, "limited"), session, "jobfixture start forbidden"); pluginrpc.Code(err) != "invalid_request" {
		t.Fatalf("job start without jobs right: %v", err)
	}
}
