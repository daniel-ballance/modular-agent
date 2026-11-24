package modular_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestWaitHostRejectsMalformedNotice(t *testing.T) {
	for _, data := range []string{
		`{"cursor":"c","requestId":"q","reason":"answered","reason":"declined"}`,
		`{"cursor":"c","requestId":"q","reason":"settled"}`,
		`{"cursor":"c","toolCallId":"x","reason":"settled"}`,
	} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("data: " + data + "\n\n"))
		}))
		h := modular.AGUIHost{Origin: s.URL, Client: s.Client()}
		for _, err := range h.WaitClosures(t.Context(), "thread", "previous") {
			if err == nil {
				t.Error("host accepted malformed closure:", data)
			}
			break
		}
		s.Close()
	}
}

type agTestAuth struct{}

func (agTestAuth) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+testAGToken)
	return http.DefaultTransport.RoundTrip(r)
}
func readHost(base string) modular.AGUIHost {
	return modular.AGUIHost{Origin: strings.TrimSuffix(base, "/agui/v1"), Client: &http.Client{Transport: agTestAuth{}}}
}

func TestWaitClosuresResumeAcrossCutoverWithoutPresence(t *testing.T) {
	a := modulartest.Agent(t)
	actor := agActor(t)
	base := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{actor}})
	id := agThread(t, base)
	thread := base + "/threads/" + id
	var snap struct{ WaitCursor, Cursor string }
	if err := json.Unmarshal([]byte(agReadBody(t, agRequest(t, "GET", thread, "", testAGToken, nil))), &snap); err != nil || snap.WaitCursor == "" {
		t.Fatal(snap, err)
	}
	for query, status := range map[string]int{"": 400, "?after=" + snap.Cursor: 409} {
		r := agRequest(t, "GET", thread+"/wait-closures"+query, "", testAGToken, nil)
		r.Body.Close()
		if r.StatusCode != status {
			t.Fatal(r.StatusCode)
		}
	}
	host, _ := a.AGUIFixturePorts()
	commit := func(kind string, entry api.Entry) {
		t.Helper()
		entry.Kind = kind
		if _, err := host.Record(context.Background(), id, entry); err != nil {
			t.Fatal(err)
		}
	}
	closeWait := func(request string, declined bool) {
		t.Helper()
		commit("question.open", api.Entry{ID: request, Data: api.JSON(map[string]any{"Question": api.Question{Session: id, ID: request, Kind: "text", Prompt: "never in notice"}})})
		commit("question.answer", api.Entry{Data: api.JSON(api.Answer{Request: request, Actor: actor.Actor.ID, Declined: declined})})
	}
	closeWait("first", false)
	cursor := snap.WaitCursor
	count := 0
	for item, err := range readHost(base).WaitClosures(t.Context(), id, cursor) {
		if err != nil {
			t.Fatal(err)
		}
		count++
		cursor = item.Cursor
		switch count {
		case 1:
			if item.RequestID != "first" || item.Reason != "answered" {
				t.Fatal(item)
			}
			closeWait("second", true)
		case 2:
			if item.RequestID != "second" || item.Reason != "declined" {
				t.Fatal(item)
			}
		}
		if count == 2 {
			break
		}
	}
	closeWait("third", false)
	for item, err := range readHost(base).WaitClosures(t.Context(), id, cursor) {
		if err != nil || item.RequestID != "third" {
			t.Fatal(item, err)
		}
		break
	}
	q, _ := host.Get("questions")
	if q.(interface{ Present(string, string) bool }).Present(id, actor.Actor.ID) {
		t.Fatal("feed established presence")
	}
}
