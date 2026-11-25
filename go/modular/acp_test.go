package modular

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

type testACPClient struct {
	mu      sync.Mutex
	updates []acp.SessionNotification
}

func (c *testACPClient) SessionUpdate(_ context.Context, p acp.SessionNotification) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.updates = append(c.updates, p)
	return nil
}
func (c *testACPClient) RequestPermission(context.Context, acp.RequestPermissionRequest) (acp.RequestPermissionResponse, error) {
	return acp.RequestPermissionResponse{Outcome: acp.RequestPermissionOutcome{Cancelled: &acp.RequestPermissionOutcomeCancelled{Outcome: "cancelled"}}}, nil
}
func TestServeACPDenyTenantBeforeCompose(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	project := t.TempDir()
	a, err := New(t.Context(), WithProject(project), WithPluginHost(true))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	err = a.ServeACP(t.Context(), ServeACPOptions{Projects: []string{"relative"}})
	if e, ok := err.(*Error); !ok || e.Code != InvalidComposition {
		t.Fatalf("invalid project: %v", err)
	}
	agent, peer := net.Pipe()
	var composed atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- a.ServeACP(t.Context(), ServeACPOptions{Input: agent, Output: agent, Projects: []string{project}, Compose: func(context.Context, string) (*Agent, error) {
			composed.Add(1)
			return nil, nil
		}})
	}()
	conn := acp.NewClientSideConnection(&testACPClient{}, peer, peer)
	defer func() { conn.Close(); <-done }()
	if _, err := conn.Initialize(t.Context(), acp.InitializeRequest{ProtocolVersion: 1}); err != nil {
		t.Fatal(err)
	}
	_, err = conn.NewSession(t.Context(), acp.NewSessionRequest{Cwd: project, Meta: map[string]json.RawMessage{"modular-agent": json.RawMessage(`{"tenant":"other"}`)}})
	if err == nil || !strings.Contains(err.Error(), "forbidden") || composed.Load() != 0 {
		t.Fatalf("project composed for denied tenant: %v (factory calls: %d)", err, composed.Load())
	}
}

func TestServeACPResumeDoesNotWaitForRecovery(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	t.Setenv("MODULAR_AGENT_ACTOR", localActor)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()

	project := t.TempDir()
	started, recovering, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var attempts atomic.Int32
	p := Provider{ID: "offline", Models: func() []ModelInfo {
		return []ModelInfo{{ModelRef: ModelRef{ID: "script"}, ContextWindow: 4000, MaxOutput: 2000}}
	}, Supports: ProviderSupport{SafeToRepeat: true}, Request: func(ctx context.Context, _ ModelRef, _ ModelRequest, _ *ProviderContext) (AssistantMessage, error) {
		if attempts.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			return AssistantMessage{}, ctx.Err()
		}
		close(recovering)
		select {
		case <-ctx.Done():
			return AssistantMessage{}, ctx.Err()
		case <-release:
			return AssistantMessage{Stop: "finished", Content: Text("recovered")}, nil
		}
	}}
	a, err := New(ctx, WithProject(project), WithDataDir(t.TempDir()), WithDurability(Durable), WithPluginHost(true), WithProvider(p))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	session, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Send(ctx, "recover me", Now); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	fresh, err := a.RestartForTest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close(context.Background())
	agentSide, clientSide := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- fresh.ServeACP(ctx, ServeACPOptions{Input: agentSide, Output: agentSide}) }()
	conn := acp.NewClientSideConnection(&testACPClient{}, clientSide, clientSide)
	defer func() {
		conn.Close()
		if err := <-done; err != nil && ctx.Err() == nil {
			t.Error(err)
		}
	}()
	defer close(release)
	if _, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1}); err != nil {
		t.Fatal(err)
	}
	assertTurn := func(want string) {
		t.Helper()
		list, err := conn.ListSessions(ctx, acp.ListSessionsRequest{})
		if err != nil || len(list.Sessions) != 1 {
			t.Fatalf("list: %+v (%v)", list, err)
		}
		var meta struct {
			Waiting struct {
				Turn                 string
				Questions, ToolCalls *int
			}
		}
		if err := json.Unmarshal(list.Sessions[0].Meta["modular-agent"], &meta); err != nil || meta.Waiting.Turn != want || meta.Waiting.Questions == nil || *meta.Waiting.Questions != 0 || meta.Waiting.ToolCalls == nil || *meta.Waiting.ToolCalls != 0 {
			t.Fatalf("listed waiting: %+v (%v), want %s and zero counts", meta.Waiting, err, want)
		}
	}
	assertTurn("interrupted")
	if _, err := conn.ResumeSession(ctx, acp.ResumeSessionRequest{Cwd: project, SessionId: acp.SessionId(session.ID())}); err != nil {
		t.Fatalf("resume did not reply while recovery blocked: %v", err)
	}
	select {
	case <-recovering:
	case <-ctx.Done():
		t.Fatal("interrupted request did not enter recovery")
	}
	assertTurn("running")
}

func TestServeACPComposesProjects(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	first, second := t.TempDir(), t.TempDir()
	state := t.TempDir()
	store := FileHistory(filepath.Join(state, "records"))
	provider := Provider{ID: "projects", Models: func() []ModelInfo {
		return []ModelInfo{{ModelRef: ModelRef{Provider: "projects", ID: "offline"}, ContextWindow: 4000, MaxOutput: 2000, Thinking: []string{"off", "low"}}}
	}, Request: func(_ context.Context, _ ModelRef, _ ModelRequest, _ *ProviderContext) (AssistantMessage, error) {
		return AssistantMessage{Content: Text("Hello."), Stop: "finished"}, nil
	}}
	compose := func(ctx context.Context, project string) (*Agent, error) {
		return New(ctx, WithProject(project), WithHistory(store), WithDataDir(state), WithDurability(Kept), WithPluginHost(true), WithProvider(provider), WithSettings(Settings{"reasoning": "off"}))
	}
	a, err := compose(t.Context(), first)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	agentSide, clientSide := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- a.ServeACP(t.Context(), ServeACPOptions{Input: agentSide, Output: agentSide, Compose: compose, ProjectSettings: func(project string) (Settings, error) {
			if project == second {
				return Settings{"reasoning": "low"}, nil
			}
			return nil, nil
		}})
	}()
	conn := acp.NewClientSideConnection(&testACPClient{}, clientSide, clientSide)
	defer func() {
		_ = conn.Close()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	init, err := conn.Initialize(t.Context(), acp.InitializeRequest{ProtocolVersion: 1})
	if err != nil || strings.Contains(string(init.Meta["modular-agent"]), "projectRoot") {
		t.Fatalf("initialize: %s (%v)", init.Meta["modular-agent"], err)
	}
	for project, reasoning := range map[string]string{first: "off", second: "low"} {
		session, err := conn.NewSession(t.Context(), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
		if err != nil {
			t.Fatal(err)
		}
		if got := session.ConfigOptions[1].Select.CurrentValue; string(got) != reasoning {
			t.Fatalf("%s: thinking = %s, want %s", project, got, reasoning)
		}
		turn, err := conn.Prompt(t.Context(), acp.PromptRequest{SessionId: session.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("Hello.")}})
		if err != nil || turn.StopReason != acp.StopReasonEndTurn {
			t.Fatalf("%s: prompt: %#v (%v)", project, turn, err)
		}
	}
	list, err := conn.ListSessions(t.Context(), acp.ListSessionsRequest{})
	if err != nil || len(list.Sessions) != 2 {
		t.Fatalf("list: %#v (%v)", list, err)
	}
}

func TestServeACPIntersectsStdioRights(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	for _, tc := range []struct {
		name          string
		ceiling, want []string
	}{
		{"overlap", []string{"watch", "settings"}, []string{"watch"}},
		{"disjoint", []string{"settings"}, []string{}},
		{"empty ceiling", []string{}, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			project := t.TempDir()
			a, err := New(ctx, WithProject(project), WithPluginHost(true))
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(t.Context())
			actor := Actor{ID: "operator", Kind: "host", Rights: []string{"watch", "input"}}
			server, peer := net.Pipe()
			done := make(chan error, 1)
			go func() {
				defer server.Close()
				done <- a.ServeACP(ctx, ServeACPOptions{Input: server, Output: server, StdioActor: &actor, Rights: tc.ceiling})
			}()
			conn := acp.NewClientSideConnection(&testACPClient{}, peer, peer)
			defer func() {
				_ = conn.Close()
				if err := <-done; err != nil {
					t.Error(err)
				}
			}()
			init, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1})
			if err != nil {
				t.Fatal(err)
			}
			var meta struct{ Actor Actor }
			if err := json.Unmarshal(init.Meta["modular-agent"], &meta); err != nil {
				t.Fatal(err)
			}
			if meta.Actor.ID != actor.ID || meta.Actor.Kind != actor.Kind || meta.Actor.Rights == nil || !slices.Equal(meta.Actor.Rights, tc.want) {
				t.Fatalf("advertised actor = %#v, want %s (%s) with %v", meta.Actor, actor.ID, actor.Kind, tc.want)
			}
			_, err = conn.NewSession(ctx, acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
			if err == nil || !strings.Contains(err.Error(), "forbidden") {
				t.Fatalf("creation without input right: %v", err)
			}
		})
	}
}

func TestServeACPRejectsMalformedStdioRights(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	a, err := New(t.Context(), WithProject(t.TempDir()), WithPluginHost(true))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	for _, tc := range []struct {
		name    string
		actor   Actor
		ceiling []string
	}{
		{"missing actor rights", Actor{ID: "operator", Kind: "host"}, []string{"watch"}},
		{"unknown actor right", Actor{ID: "operator", Kind: "host", Rights: []string{"unknown"}}, []string{"watch"}},
		{"unknown ceiling right", Actor{ID: "operator", Kind: "host", Rights: []string{"watch"}}, []string{"unknown"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := a.ServeACP(t.Context(), ServeACPOptions{Input: io.NopCloser(strings.NewReader("")), Output: io.Discard, StdioActor: &tc.actor, Rights: tc.ceiling})
			if e, ok := err.(*Error); !ok || e.Code != InvalidComposition {
				t.Fatalf("malformed rights: %v", err)
			}
		})
	}
}

func TestServeACP(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	project := t.TempDir()
	p := Provider{ID: "acp-test", Models: func() []ModelInfo {
		return []ModelInfo{{ModelRef: ModelRef{Provider: "acp-test", ID: "offline"}, ContextWindow: 4000, MaxOutput: 2000}}
	}, Request: func(_ context.Context, _ ModelRef, _ ModelRequest, c *ProviderContext) (AssistantMessage, error) {
		c.Piece("text", "Hello ACP.")
		return AssistantMessage{Content: Text("Hello ACP."), Stop: "finished"}, nil
	}}
	a, err := New(t.Context(), WithProject(project), WithPluginHost(true), WithProvider(p))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(t.Context())
	agentSide, clientSide := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- a.ServeACP(t.Context(), ServeACPOptions{Input: agentSide, Output: agentSide}) }()
	client := &testACPClient{}
	conn := acp.NewClientSideConnection(client, clientSide, clientSide)
	defer func() {
		_ = conn.Close()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	init, err := conn.Initialize(t.Context(), acp.InitializeRequest{ProtocolVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct{ Declaration Declaration }
	if err := json.Unmarshal(init.Meta["modular-agent"], &metadata); err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(metadata.Declaration)
	declaration := a.Declaration()
	declaration["projectRoot"] = project
	want, _ := json.Marshal(declaration)
	if string(got) != string(want) {
		t.Fatalf("ACP declaration %s does not match SDK %s", got, want)
	}
	session, err := conn.NewSession(t.Context(), acp.NewSessionRequest{Cwd: project, McpServers: []acp.McpServer{}})
	if err != nil {
		t.Fatal(err)
	}
	turn, err := conn.Prompt(t.Context(), acp.PromptRequest{SessionId: session.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("Say hello.")}})
	if err != nil || turn.StopReason != acp.StopReasonEndTurn {
		t.Fatalf("turn: %#v, %v", turn, err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	data, _ := json.Marshal(client.updates)
	if !strings.Contains(string(data), "Hello ACP.") {
		t.Fatalf("updates: %s", data)
	}
}
