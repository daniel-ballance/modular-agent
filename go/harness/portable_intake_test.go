package harness

import (
	"encoding/json"
	"modular/api"
	"modular/portable"
	"testing"
)

func TestPortableIntakeUsesLatestStateButFirstReceipt(t *testing.T) {
	raws := []string{
		`{"id":"a","parentId":null,"kind":"inputAccepted","actorId":"proposer","data":{"inputId":"proposed","key":"retry","when":"propose","content":[{"type":"text","text":"proposed text"}]}}`,
		`{"id":"b","parentId":"a","kind":"inputAccepted","actorId":"proposer","data":{"inputId":"waiting","when":"propose","content":[]}}`,
		`{"id":"c","parentId":"b","kind":"inputAccepted","actorId":"other","inputId":"returned","data":{"key":"back","when":"after","content":[]}}`,
		`{"id":"d","parentId":"c","kind":"inputHandedBack","erased":true,"inputIds":["returned"]}`,
		`{"id":"ready","parentId":"d","kind":"inputAccepted","actorId":"host","inputId":"ready","data":{"when":"after","taken":"after","content":[]}}`,
		`{"id":"e","parentId":"ready","kind":"inputAccepted","actorId":"proposer","inputId":"proposed","data":{"key":"retry","when":"after","releasedBy":"host","content":[{"type":"text","text":"proposed text"}]}}`,
		`{"id":"position","parentId":"e","kind":"position","data":{"to":"a"}}`,
	}
	s := api.Session{ID: "foreign"}
	for _, raw := range raws {
		e, err := portable.ReadEntry(json.RawMessage(raw))
		if err != nil {
			t.Fatal(err)
		}
		s.Entries = append(s.Entries, e)
	}
	_, queue := recovery(portable.Session(s))
	if len(queue) != 3 || runnableInput(queue) != 1 || queue[1].ID != "ready" || queue[2].ID != "proposed" || queue[2].ReleasedBy != "host" || queue[2].Content.Text() != "proposed text" {
		t.Fatalf("unexpected queue: %+v", queue)
	}
	for key, id := range map[string]string{"back": "returned", "retry": "proposed"} {
		actor := map[string]string{"back": "other", "retry": "proposer"}[key]
		if _, ok := duplicate(s, api.Input{Key: key, Actor: "different"}); ok {
			t.Fatalf("another actor's receipt was returned for %s", key)
		}
		if _, ok := duplicate(s, api.Input{Key: key, Actor: actor, ViaActor: "different"}); ok {
			t.Fatalf("another submitter's receipt was returned for %s", key)
		}
		if r, ok := duplicate(s, api.Input{Key: key, Actor: actor}); !ok || !r.Duplicate || r.ID != id || (key == "retry" && r.When != "propose" && r.When != "proposed") {
			t.Fatalf("%s: %+v", key, r)
		}
	}
}
