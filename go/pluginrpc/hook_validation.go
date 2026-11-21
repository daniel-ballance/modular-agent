package pluginrpc

import "encoding/json"

func onlyFields(v object, allowed ...string) bool {
	for key := range v {
		found := false
		for _, k := range allowed {
			if key == k {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func unchangedExcept(before, after object, keys ...string) bool {
	for k, v := range before {
		if !onlyFields(object{k: nil}, keys...) && (!has(after, k) || !sameJSON(v, after[k])) {
			return false
		}
	}
	for k := range after {
		if !onlyFields(object{k: nil}, keys...) && !has(before, k) {
			return false
		}
	}
	return true
}

// Model tools are not capabilities a hook can create. A hook may remove or
// reorder definitions, but must leave each retained registration intact.
func narrowsTools(before, after any) bool {
	old := objects(before)
	next := objects(after)
	known := map[string]object{}
	for _, def := range old {
		known[str(def, "name")] = def
	}
	for _, def := range next {
		name := str(def, "name")
		if name == "" || known[name] == nil || !sameJSON(known[name], def) {
			return false
		}
		delete(known, name)
	}
	// Do not mistake a malformed value for an empty list.
	var parsed []json.RawMessage
	return json.Unmarshal(mustJSON(after), &parsed) == nil
}

func validRequestChange(before, after any) bool {
	old, next := asObject(before), asObject(after)
	if next == nil || !unchangedExcept(old, next, "systemPrompt", "messages", "tools", "settings") {
		return false
	}
	if _, ok := next["systemPrompt"].(string); !ok {
		return false
	}
	if !has(next, "messages") || !has(next, "tools") || asObject(next["settings"]) == nil {
		return false
	}
	var messages []json.RawMessage
	return json.Unmarshal(mustJSON(next["messages"]), &messages) == nil && narrowsTools(old["tools"], next["tools"])
}

// ValidateHookAnswer checks the allowed answer and its transformation scope.
func ValidateHookAnswer(point string, payload Object, answer any, local bool) error {
	if answer == nil {
		return nil
	}
	var a object
	invalid := fault("invalid_request", "illegal answer at "+point)
	if json.Unmarshal(mustJSON(answer), &a) != nil || a == nil {
		return invalid
	}
	refusal := func() bool { v, ok := a["refuse"].(string); return ok && v != "" && len(a) == 1 }
	switch point {
	case "session.start", "session.end", "turn.start", "turn.end", "provider.response":
		return invalid
	case "plugin.load", "step.after", "turn.result":
		if refusal() {
			return nil
		}
	case "turn.before":
		if !onlyFields(a, "system", "context") {
			return invalid
		}
		if _, ok := a["system"].(string); has(a, "system") && !ok {
			return invalid
		}
		if has(a, "context") && !isContent(a["context"]) {
			return invalid
		}
		return nil
	case "tool.before":
		if refusal() {
			return nil
		}
		if local && len(a) == 1 && asObject(a["pending"]) != nil {
			return nil
		}
		c := asObject(a["change"])
		call := asObject(c["call"])
		if len(a) == 1 && len(c) == 1 && call != nil && asObject(call["input"]) != nil && unchangedExcept(asObject(payload["call"]), call, "input") {
			return nil
		}
	case "model.failed":
		if retry, ok := a["retry"].(bool); ok && onlyFields(a, "retry", "request") && (!has(a, "request") || retry && validRequestChange(payload["request"], a["request"])) {
			return nil
		}
	case "input", "tool.after", "step.before", "provider.request":
		if point == "input" && local && len(a) == 1 && str(a, "command") != "" {
			return nil
		}
		v := asObject(a["value"])
		if v == nil {
			return invalid
		}
		if point == "input" {
			if _, ok := a["stop"].(bool); has(a, "stop") && !ok {
				return invalid
			}
			if onlyFields(a, "value", "stop") && unchangedExcept(payload, v, "content") && isContent(v["content"]) {
				return nil
			}
		} else if point == "tool.after" {
			old, r := asObject(payload["result"]), asObject(v["result"])
			if len(a) == 1 && unchangedExcept(payload, v, "result") && r != nil && unchangedExcept(old, r, "content", "value") && isContent(r["content"]) {
				return nil
			}
		} else {
			keys := []string{"request"}
			if local && point == "step.before" {
				keys = append(keys, "providerTools")
			}
			if len(a) == 1 && unchangedExcept(payload, v, keys...) && validRequestChange(payload["request"], v["request"]) &&
				(!local || point != "step.before" || narrowsTools(payload["providerTools"], v["providerTools"])) {
				return nil
			}
		}
	}
	return invalid
}

func isContent(v any) bool {
	var parts []object
	if v == nil || json.Unmarshal(mustJSON(v), &parts) != nil {
		return false
	}
	for _, p := range parts {
		if str(p, "type") == "" {
			return false
		}
	}
	return true
}
