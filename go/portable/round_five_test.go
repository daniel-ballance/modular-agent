package portable_test

import (
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
	"reflect"
	"testing"
)

func readPortable(t *testing.T, raw string) api.Entry {
	t.Helper()
	e, err := portable.ReadEntry(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestRoundFivePortableShapes(t *testing.T) {
	const core = `"id":"wire","parentId":null,"sessionId":"foreign","time":1,"writer":"other","modelVisible":false,`
	cases := []struct {
		wire    string
		inspect func(api.Entry) bool
	}{
		{`"kind":"inputAccepted","actorId":"proposer","inputId":"in","data":{"key":"once","when":"after","releasedBy":"host","content":[{"type":"text","text":"direction"}],"future":9}`, func(e api.Entry) bool {
			in := api.Decode[api.Input](e.Data)
			return in.ID == "in" && in.Actor == "proposer" && in.Key == "once" && in.When == "after" && in.ReleasedBy == "host" && in.Content.Text() == "direction"
		}},
		{`"kind":"inputHandedBack","data":{"inputIds":["in","other"]}`, func(e api.Entry) bool { return reflect.DeepEqual(e.HandedBackIDs(), []string{"in", "other"}) }},
		{`"kind":"modelRequest","stepId":"s","data":{"model":{"provider":"vendor","id":"test","future":9},"safeToRepeat":false}`, func(e api.Entry) bool {
			return e.Step == "s" && api.Decode[api.Model](e.Data).ID == "vendor/test" && e.SafeToRepeat != nil && !*e.SafeToRepeat
		}},
		{`"kind":"plugins","data":{"active":[{"name":"plug","origin":"elsewhere","future":9}]}`, func(e api.Entry) bool { return reflect.DeepEqual(api.Decode[[]string](e.Data), []string{"plug"}) }},
		{`"kind":"turnStart","turnId":"t","data":{"startedBy":{"kind":"actor","id":"actor"},"model":{"provider":"vendor","id":"test"},"system":"","context":[{"type":"text","text":"prepared"}],"tools":[],"settings":{"reasoning":"off","maxSteps":8,"maxOutput":256}}`, func(e api.Entry) bool { return api.Decode[api.TurnStart](e.Data).Context.Text() == "prepared" }},
	}
	for _, c := range cases {
		raw := "{" + core + c.wire + "}"
		e := readPortable(t, raw)
		if !c.inspect(e) {
			t.Fatalf("did not reconstruct %s: %+v", raw, e)
		}
		want := api.Decode[map[string]any](json.RawMessage(raw))
		got := api.Decode[map[string]any](api.JSON(portable.Entry(e)))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %s, want %s", api.JSON(got), raw)
		}
	}
}

func TestRoundFiveReadsLegacyGoIntakeWithoutResubmitting(t *testing.T) {
	accepted := readPortable(t, `{"id":"accept","kind":"input.accepted","data":{"ID":"old-input","Actor":"local-user","Key":"once","When":"after","Content":[{"type":"text","text":"old"}]}}`)
	if in := api.Decode[api.Input](accepted.Data); in.ID != "old-input" || in.Key != "once" || in.Content.Text() != "old" {
		t.Fatal(in)
	}
	returned := readPortable(t, `{"id":"return","kind":"input.returned","data":"old-input"}`)
	if ids := returned.HandedBackIDs(); !reflect.DeepEqual(ids, []string{"old-input"}) {
		t.Fatal(ids)
	}
	plugins := readPortable(t, `{"id":"plugins","kind":"plugins.set","data":["history"]}`)
	if got := api.Decode[[]string](plugins.Data); !reflect.DeepEqual(got, []string{"history"}) {
		t.Fatal(got)
	}
}

func TestRoundFiveErasureMarkerClosesCallWithoutLeakingPayload(t *testing.T) {
	entries := []api.Entry{
		readPortable(t, `{"id":"r","parentId":null,"kind":"response","turnId":"t","stepId":"s","message":{"role":"assistant","stop":"toolUse","content":[{"type":"toolCall","id":"c","name":"read","arguments":{}}]}}`),
		readPortable(t, `{"id":"result","parentId":"r","kind":"toolResult","turnId":"t","stepId":"s","toolCallId":"c","jobId":"j","actorId":"sensitive","message":{"role":"toolResult","content":[{"type":"text","text":"secret"}]},"data":{"status":"completed"},"future":"opaque"}`),
		readPortable(t, `{"id":"marker","parentId":"result","kind":"erasure","data":{"entryIds":["result"]}}`),
	}
	s := portable.Session(api.Session{ID: "foreign", Entries: entries})
	if got := api.OpenCalls(s); len(got) != 0 {
		t.Fatal("erased result reopened a settled call", got)
	}
	const only = `{"erased":true,"id":"result","jobId":"j","kind":"toolResult","parentId":"r","stepId":"s","toolCallId":"c","turnId":"t"}`
	if got := string(api.JSON(portable.Entry(s.Entries[1]))); got != only {
		t.Fatalf("got %s, want %s", got, only)
	}
}
