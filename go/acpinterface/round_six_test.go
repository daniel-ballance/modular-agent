package acpinterface_test

import (
	"context"
	"encoding/json"
	"errors"
	"modular/acpinterface"
	"modular/api"
	"modular/fake"
	"modular/internal/runtimetest"
	"modular/vanilla"
	"os"
	"path/filepath"
	"slices"
	"testing"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestTenantBudgetSpansSessionsAndReopen(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		t.Setenv("MODULAR_AGENT_TENANTS", `{"team":{"rights":["watch","input","administer","settings","erase"],"tokens":5}}`)
		root, state := t.TempDir(), t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Text("first"), Stop: "finished", Usage: api.Usage{Input: 1, Output: 2}}}, fake.Script{Response: api.Response{Content: api.Text("second"), Stop: "finished", Usage: api.Usage{Input: 1, Output: 1}}})
		opt := vanilla.Options{Project: root, History: state, Provider: p.Plugin(), Model: "fake", Runtime: runtimetest.Plugin(t)}
		open := func(tenant string) (*acp.ClientSideConnection, acp.SessionId, func()) {
			t.Helper()
			h, err := vanilla.New(opt)
			if err != nil {
				t.Fatal(err)
			}
			conn, closeConn := connection(t, h.API(), &client{})
			closeAll := func() { closeConn(); _ = h.Close() }
			t.Cleanup(closeAll)
			initClient(t, conn, false)
			s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root, Meta: map[string]json.RawMessage{acpinterface.Namespace: api.JSON(map[string]string{"tenant": tenant})}})
			if err != nil {
				t.Fatal(err)
			}
			return conn, s.SessionId, closeAll
		}
		readUsage := func(conn *acp.ClientSideConnection, id acp.SessionId, want int) {
			t.Helper()
			raw, err := conn.CallExtension(timeout(t), "_modular-agent/tenant", map[string]any{"sessionId": id})
			v := api.Decode[struct {
				Tenant string
				Tokens struct{ Budget, Used int }
			}](raw)
			if err != nil || v.Tenant != "team" || v.Tokens.Budget != 5 || v.Tokens.Used != want {
				t.Fatal(string(raw), err)
			}
		}
		first, id, closeFirst := open("team")
		if out := prompt(t, first, id, "below budget", ""); out.StopReason != acp.StopReasonEndTurn {
			t.Fatal(out)
		}
		readUsage(first, id, 3)
		closeFirst()
		second, id2, _ := open("team")
		readUsage(second, id2, 3)
		if out := prompt(t, second, id2, "uses remaining budget", ""); out.StopReason != acp.StopReasonMaxTokens {
			t.Fatal(out)
		}
		if out := prompt(t, second, id2, "does not call provider", ""); out.StopReason != acp.StopReasonMaxTokens || len(p.Requests()) != 2 {
			t.Fatal(out, p.Requests())
		}
		readUsage(second, id2, 5)
		raw, err := second.CallExtension(timeout(t), "_modular-agent/history", map[string]any{"sessionId": id2})
		es := api.Decode[struct{ Entries []struct{ ID, Kind string } }](raw).Entries
		if err != nil || len(es) == 0 || es[0].Kind != "tenant" {
			t.Fatal(string(raw), err)
		}
		if _, err = second.CallExtension(timeout(t), "_modular-agent/erase", map[string]any{"sessionId": id2, "entryIds": []string{es[0].ID}}); err == nil {
			t.Fatal("tenant entry was erasable")
		}
	})
}

func TestSessionLimitAppliesBeforeTheNextToolInARunningTurn(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		root := t.TempDir()
		entered, release := make(chan struct{}), make(chan struct{})
		f := fake.New(fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			close(entered)
			select {
			case <-ctx.Done():
				return api.Response{}, ctx.Err()
			case <-release:
			}
			return api.Response{Content: api.Content{call("blocked", "write", map[string]string{"path": "blocked", "content": "never"})}, Stop: "tools"}, nil
		}}, fake.Script{Response: api.Response{Content: api.Text("settled"), Stop: "finished"}})
		a := compose(t, root, f)
		conn, _ := connection(t, a, &client{})
		initClient(t, conn, false)
		s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root})
		if err != nil {
			t.Fatal(err)
		}
		ctx := timeout(t)
		done := make(chan error, 1)
		go func() {
			_, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: s.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("start")}})
			done <- err
		}()
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-entered:
		}
		limit := func(rights any) error {
			_, err := conn.CallExtension(ctx, "_modular-agent/limit", map[string]any{"sessionId": s.SessionId, "rights": rights})
			return err
		}
		if err := limit([]string{"watch", "input", "administer"}); err != nil {
			t.Fatal(err)
		}
		if err := limit([]string{"watch", "input", "administer", "tools"}); err == nil {
			t.Fatal("explicit widening passed")
		}
		close(release)
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case err = <-done:
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err = os.Stat(filepath.Join(root, "blocked")); !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if a.Authorize(string(s.SessionId), "local-user", "tools") {
			t.Fatal("limit allowed the tool right")
		}
		if err = limit(nil); err != nil {
			t.Fatal(err)
		}
		if !a.Authorize(string(s.SessionId), "local-user", "tools") {
			t.Fatal("clearing the ceiling did not restore the base right")
		}
	})
}

func TestUnsupportedReasoningIsLoweredOnReopen(t *testing.T) {
	runtimetest.Each(t, func(t *testing.T) {
		project := t.TempDir()
		p := fake.New(fake.Script{Response: api.Response{Content: api.Text("lowered"), Stop: "finished"}})
		a := compose(t, project, p)
		conn, _ := connection(t, a, &client{})
		initClient(t, conn, false)
		session, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: project})
		if err != nil {
			t.Fatal(err)
		}
		snap, err := a.Snapshot(string(session.SessionId))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = a.Record(timeout(t), snap.ID, api.Entry{Kind: "test.keep"}); err != nil {
			t.Fatal(err)
		}
		snap.Settings.Thinking = "medium"
		if err = a.SetSettings(timeout(t), snap.ID, snap.Settings); err != nil {
			t.Fatal(err)
		}
		if _, err = conn.CloseSession(timeout(t), acp.CloseSessionRequest{SessionId: session.SessionId}); err != nil {
			t.Fatal(err)
		}
		if _, err = conn.ResumeSession(timeout(t), acp.ResumeSessionRequest{SessionId: session.SessionId, Cwd: project}); err != nil {
			t.Fatal(err)
		}
		if out := prompt(t, conn, session.SessionId, "ask without raising reasoning", ""); out.StopReason != acp.StopReasonEndTurn {
			t.Fatal(out)
		}
		if requests := p.Requests(); len(requests) != 1 || requests[0].Thinking != "low" {
			t.Fatal(requests)
		}
	})
}

func TestWithheldReplyDoesNotUndoItsEffect(t *testing.T) {
	root := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Model: "fake", Provider: fake.New().Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err = h.Load(api.Plugin{Name: "block-join-reply", Setup: func(a api.API) error {
		return a.Handle("output.batch", "", func(_ context.Context, value any) (api.Decision, error) {
			events := value.(api.OutputBatch).Events
			return api.Decision{Refuse: len(events) == 1 && events[0].Method == "_modular-agent/join"}, nil
		})
	}}); err != nil {
		t.Fatal(err)
	}
	conn, _ := connection(t, h.API(), &client{})
	initClient(t, conn, false)
	s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	_, err = conn.CallExtension(timeout(t), "_modular-agent/join", map[string]any{"sessionId": s.SessionId, "actor": api.Actor{ID: "guest", Kind: "user", Rights: []string{"watch"}}})
	var rpc *acp.RequestError
	if !errors.As(err, &rpc) || rpc.Code != -32000 || api.Decode[map[string]string](api.JSON(rpc.Data))["code"] != "withheld" {
		t.Fatal(err)
	}
	raw, err := conn.CallExtension(timeout(t), "_modular-agent/actors", map[string]any{"sessionId": s.SessionId})
	actors := api.Decode[struct{ Actors []api.Actor }](raw).Actors
	if err != nil || !slices.ContainsFunc(actors, func(a api.Actor) bool { return a.ID == "guest" }) {
		t.Fatal(string(raw), err)
	}
}

func TestACPProposalPresenceDeclineAndWithdrawal(t *testing.T) {
	root := t.TempDir()
	f := fake.New()
	h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Model: "fake", Provider: f.Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	a := h.API()
	conn, _ := connection(t, a, &client{})
	initClient(t, conn, false)
	s, err := conn.NewSession(timeout(t), acp.NewSessionRequest{Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	ask := func(method string, p map[string]any) json.RawMessage {
		t.Helper()
		p["sessionId"] = s.SessionId
		raw, err := conn.CallExtension(timeout(t), "_modular-agent/"+method, p)
		if err != nil {
			t.Fatal(method, err)
		}
		return raw
	}
	guest := api.Actor{ID: "guest", Kind: "user", Rights: []string{"propose", "watch"}}
	present := func() bool {
		return slices.Contains(api.Decode[struct{ Present []string }](ask("actors", map[string]any{})).Present, guest.ID)
	}
	ask("join", map[string]any{"actor": guest, "present": false})
	if present() {
		t.Fatal("absent guest marked present")
	}
	ask("join", map[string]any{"actor": guest})
	if present() {
		t.Fatal("an unrepresented grant marked the guest present")
	}
	_, err = conn.CallExtension(timeout(t), "_modular-agent/input", map[string]any{"sessionId": s.SessionId, "actorId": guest.ID, "when": "propose", "content": "denied"})
	var denied *acp.RequestError
	if !errors.As(err, &denied) || denied.Code != -32602 {
		t.Fatal("join granted representation", err)
	}
	propose := func(content string) string {
		return api.Decode[struct{ InputID string }](ask("input", map[string]any{"when": "propose", "content": content})).InputID
	}
	one, two := propose("first"), propose("second")
	list := func() []string {
		p := api.Decode[struct{ Proposals []struct{ InputID string } }](ask("proposals", map[string]any{}))
		ids := []string{}
		for _, x := range p.Proposals {
			ids = append(ids, x.InputID)
		}
		return ids
	}
	if ids := list(); !slices.Equal(ids, []string{one, two}) {
		t.Fatal(ids)
	}
	if r := api.Decode[map[string]string](ask("release", map[string]any{"inputId": one, "declined": true})); r["taken"] != "handedBack" || r["inputId"] != one {
		t.Fatal(r)
	}
	ask("withdraw", map[string]any{"inputId": two})
	if ids := list(); len(ids) != 0 || len(f.Requests()) != 0 {
		t.Fatal(ids, f.Requests())
	}
	ask("leave", map[string]any{"actorId": guest.ID})
	if present() {
		t.Fatal("left guest still present")
	}
	_, err = conn.CallExtension(timeout(t), "_modular-agent/withdraw", map[string]any{"sessionId": s.SessionId, "inputId": two})
	var rpc *acp.RequestError
	if !errors.As(err, &rpc) || rpc.Code != -32602 {
		t.Fatal(err)
	}
}
