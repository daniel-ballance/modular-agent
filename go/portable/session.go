package portable

import (
	"bytes"
	"github.com/OWNER/modular-agent/go/api"
	"strings"
)

func applySetting(s *api.Settings, d object) {
	k := str(d, "key")
	if k == "settings" {
		applySettings(s, asObject(d["value"]))
	} else {
		applySettings(s, object{k: d["value"]})
	}
}

// Session rebuilds the shared state in append order, without reading a snapshot
// entry or skipping entries from branches other than the current branch.
func Session(s api.Session) api.Session {
	s.Version = 1
	s.Position = ""
	s.Plugins = nil
	s.Tenant, s.Limit = "", nil
	erased := map[string]bool{}
	for _, e := range s.Entries {
		if e.Kind == "erasure" {
			for _, id := range api.ReadErasureRecord(e.Data).EntryIDs {
				erased[id] = true
			}
		}
	}
	if s.Actor == "" {
		s.Actor = "local-user"
	}
	prefix := s.ForkedFrom != ""
	for i := range s.Entries {
		e := &s.Entries[i]
		if erased[e.ID] && !e.AuthorityRecord() || e.IsErased() {
			*e = e.Redacted()
		}
		if !e.IsErased() && e.Session == "" {
			e.Session = s.ID
		}
		switch e.Kind {
		case "position":
			p, _ := api.ReadPosition(e.Data)
			s.Position = p.Target()
		default:
			s.Position = e.ID
		}
		copied := prefix && (len(e.Copies) != 0 || e.IsErased())
		if copied {
			continue
		}
		firstSetup := prefix || i == 0
		prefix = false
		switch e.Kind {
		case "tenant":
			if firstSetup {
				s.Tenant = api.Decode[string](e.Data)
			}
		case "limit":
			rights := api.Decode[[]string](e.Data)
			s.Limit = nil
			if rights != nil {
				s.Limit = &rights
			}
		case "setting":
			if len(e.Wire) > 0 {
				applySetting(&s.Settings, asObject(obj(e.Wire)["data"]))
			} else {
				s.Settings = api.Decode[api.Settings](e.Data)
			}
		case "actor.set":
			a := api.Decode[api.Actor](e.Data)
			if a.ID == "" {
				continue
			}
			if s.Actors == nil {
				s.Actors = map[string]api.Actor{}
			}
			s.Actors[a.ID] = a
			if _, ok := s.Actors[s.Actor]; !ok && (a.Kind == "host" || a.Kind == "user" || a.Kind == "agent") {
				s.Actor = a.ID
			}
		case "actor.left":
			delete(s.Actors, api.Decode[string](e.Data))
		case "plugins.set":
			s.Plugins = api.Decode[[]string](e.Data)
		case "subagent.bound":
			if s.Parent == "" {
				continue
			}
			a := api.Decode[api.ActorRef](e.Data)
			s.ParentActor = a.Actor
			s.Actor = "parent-agent"
		}
	}
	return s
}

// Same compares the shared forms, ignoring object key order. The service still
// compares the original JSON of entries it already kept.
func Same(a, b api.Entry) bool {
	left, right := api.JSON(Entry(a)), api.JSON(Entry(b))
	if bytes.Equal(left, right) {
		return true
	}
	return bytes.Equal(api.JSON(obj(left)), api.JSON(obj(right)))
}

// Content encodes content for a boundary which does not carry history.
func Content(c api.Content) []any        { return contentOut(c) }
func ReadContent(v any) api.Content      { return contentIn(v) }
func Call(c api.Call) Object             { return callOut(c) }
func ReadCall(v Object) api.Call         { return callIn(v) }
func Tool(t api.Tool) Object             { return toolOut(t) }
func ReadTool(v Object) api.Tool         { return toolIn(v) }
func Result(r api.ToolResult) Object     { return resultOut(r) }
func ReadResult(v Object) api.ToolResult { return resultIn(v) }
func Model(m api.Model) Object           { return modelOut(m) }
func ReadModel(v Object) api.Model       { return modelIn(v) }
func Request(r api.Request) Object       { return requestOut(r) }
func ReadRequest(v Object) api.Request   { return requestIn(v) }
func Response(r api.Response) Object     { return responseOut(r) }
func ReadResponse(v Object) api.Response { return responseIn(v) }
func StatusOut(s string) string          { return statusOut(s) }
func StatusIn(s string) string           { return statusIn(s) }

// IsQualifiedModel reports whether a session setting can be split into a
// provider identity and its model id.
func IsQualifiedModel(s string) bool { return strings.Contains(s, "/") }
