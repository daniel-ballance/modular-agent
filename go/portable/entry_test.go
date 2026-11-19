package portable_test

import (
	"encoding/json"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
	"strings"
	"testing"
)

func TestPortableReplayUsesStandardsOnly(t *testing.T) {
	raws := []string{
		`{"id":"join","parentId":null,"kind":"actorJoined","sessionId":"foreign","time":10,"writer":"other","modelVisible":false,"data":{"actor":{"id":"foreign-host","kind":"host","rights":["watch","input","answer"]}}}`,
		`{"id":"settings","parentId":"join","kind":"setting","sessionId":"foreign","time":11,"writer":"other","modelVisible":false,"data":{"key":"settings","value":{"model":{"provider":"conformance","id":"echo"},"reasoning":"off","maxSteps":8,"maxOutput":2048,"futureLimit":9007199254740993}}}`,
		`{"id":"turn","parentId":"settings","kind":"turnStart","sessionId":"foreign","time":12,"writer":"other","modelVisible":false,"turnId":"t","actorId":"foreign-host","data":{"startedBy":{"kind":"actor","id":"foreign-host"},"model":{"provider":"conformance","id":"echo"},"system":"portable instruction","tools":[],"settings":{"maxSteps":8}}}`,
		`{"id":"input","parentId":"turn","kind":"input","sessionId":"foreign","time":13,"writer":"other","modelVisible":true,"turnId":"t","actorId":"foreign-host","message":{"role":"user","content":[{"type":"future","n":9007199254740993}]},"data":{"inputId":"admission","key":"once"},"future":9007199254740993}`,
		`{"id":"response","parentId":"input","kind":"response","sessionId":"foreign","time":14,"writer":"other","modelVisible":true,"turnId":"t","stepId":"s","message":{"role":"assistant","stop":"toolUse","content":[{"type":"toolCall","id":"call","name":"read","arguments":{"path":"a"}}]}}`,
		`{"id":"start","parentId":"response","kind":"toolStarted","sessionId":"foreign","time":15,"writer":"other","modelVisible":false,"turnId":"t","stepId":"s","toolCallId":"call","data":{"call":{"id":"call","name":"read","input":{"path":"b"},"startedBy":"model"},"safeToRepeat":true}}`,
		`{"id":"question","parentId":"start","kind":"inputRequest","sessionId":"foreign","time":16,"writer":"other","modelVisible":false,"turnId":"t","toolCallId":"call","data":{"request":{"id":"q","sessionId":"foreign","toolCallId":"call","kind":"text","question":"Which?","answerable":true}}}`,
		`{"id":"new-setting","parentId":"question","kind":"setting","sessionId":"foreign","time":17,"writer":"other","modelVisible":false,"data":{"key":"maxSteps","value":3}}`,
		`{"id":"move","parentId":"new-setting","kind":"position","sessionId":"foreign","time":18,"writer":"other","modelVisible":false,"data":{"to":"question"}}`,
	}
	snap := api.Session{ID: "foreign", Project: "/project"}
	for _, raw := range raws {
		e, err := portable.ReadEntry(json.RawMessage(raw))
		if err != nil {
			t.Fatal(err)
		}
		snap.Entries = append(snap.Entries, e)
	}
	snap = portable.Session(snap)
	if snap.Position != "question" || len(snap.Branch()) != 7 || snap.Settings.Model != "conformance/echo" || snap.Settings.MaxSteps != 3 || snap.Settings.MaxOutput != 2048 || snap.Actor != "foreign-host" {
		t.Fatalf("wrong reconstructed session: %+v", snap)
	}
	in := snap.Branch()[3]
	if in.InputID() != "admission" || in.InputKey != "once" || in.Time.UnixMilli() != 13 {
		t.Fatal(in)
	}
	if got := string(api.JSON(portable.Entry(in))); !json.Valid([]byte(got)) || !strings.Contains(got, `"future":9007199254740993`) || !strings.Contains(got, `"n":9007199254740993`) {
		t.Fatal(got)
	}
	calls := api.OpenCalls(snap)
	if len(calls) != 1 || calls[0].ID != "call" || string(calls[0].Input) != `{"path":"b"}` {
		t.Fatal(calls)
	}
	if e := snap.Branch()[5]; e.SafeToRepeat == nil || !*e.SafeToRepeat {
		t.Fatal(e)
	}
}

func TestErasedWireEntryDoesNotRestorePayload(t *testing.T) {
	e, err := portable.ReadEntry(json.RawMessage(`{"id":"old","parentId":null,"kind":"response","erased":true}`))
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"erased":true,"id":"old","kind":"response","parentId":null}`
	if got := string(api.JSON(portable.Entry(e))); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
