package api

import "testing"

func TestQuestionAloneDoesNotAuthorizeContinuation(t *testing.T) {
	q := Question{ID: "q", Call: "c", Turn: "t", Session: "s"}
	request := Entry{Kind: "question.open", ID: "open", Call: q.Call, Turn: q.Turn, Data: JSON(struct{ Question Question }{q})}
	check := func(kind string, ids []string) bool {
		s := Session{ID: "s", Position: "next", Entries: []Entry{request, {Kind: kind, ID: "next", Parent: "open", Call: q.Call, Turn: q.Turn, Data: JSON(map[string]any{"requestIds": ids})}}}
		return HasQuestionCheckpoint(s, q)
	}
	if check("question.answer", []string{"q"}) || check("tool.open", []string{"foreign"}) || !check("tool.open", []string{"q"}) {
		t.Fatal("continuation must have its committed question and matching host checkpoint")
	}
}
