package pluginrpc

import (
	"encoding/json"
	"modular/api"
)

const maxHistoryPage = 4 * 1024 * 1024

func historyPage(s api.Session, v object) (any, error) {
	entries := s.Branch()
	if has(v, "all") {
		all, ok := v["all"].(bool)
		if !ok {
			return nil, fault("invalid_request", "all must be a boolean")
		}
		if all {
			entries = s.Entries
		}
	}
	start := 0
	if has(v, "after") {
		after, ok := v["after"].(string)
		if !ok || after == "" {
			return nil, fault("invalid_request", "after must be an entry id")
		}
		for i, e := range entries {
			if e.ID == after {
				start = i + 1
				break
			}
		}
		if start == 0 {
			return nil, fault("invalid_request", "unknown history cursor")
		}
	}
	limit := 500
	if has(v, "limit") {
		n, ok := v["limit"].(json.Number)
		if !ok {
			return nil, fault("invalid_request", "limit must be a whole number from 1 to 500")
		}
		value, err := n.Float64()
		if err != nil || value < 1 || value > 500 || value != float64(int(value)) {
			return nil, fault("invalid_request", "limit must be a whole number from 1 to 500")
		}
		limit = int(value)
	}
	keys := map[string]string{}
	for _, e := range s.Entries {
		if e.Kind == "input.accepted" || e.Kind == "go.inputAccepted" {
			in := api.Decode[api.Input](e.Data)
			keys[in.ID] = in.Key
		}
	}
	page := []json.RawMessage{}
	// Count the compact JSON result only. In particular, a valid full page
	// may push its JSON-RPC response envelope over 4 MiB.
	resultBytes := len(`{"entries":[]}`)
	next := ""
	for i := start; i < len(entries) && len(page) < limit; i++ {
		e := entries[i]
		entry := entryOut(e)
		if e.Kind == "input" {
			if data, ok := entry["data"].(object); ok && !has(data, "key") {
				if key := keys[str(data, "inputId")]; key != "" {
					data["key"] = key
				}
			}
		}
		b, err := json.Marshal(entry)
		if err != nil {
			return nil, err
		}
		addition := len(b)
		if len(page) != 0 {
			addition++ // comma between entries
		}
		cursorBytes := 0
		if i < len(entries)-1 {
			cursorBytes = len(`,"next":`) + len(mustJSON(e.ID))
		}
		if resultBytes+addition+cursorBytes > maxHistoryPage {
			if len(page) != 0 {
				break
			}
			if resultBytes+addition > maxHistoryPage {
				return nil, fault("result_too_large", "entry exceeds history page limit")
			}
			// A fitting first entry must be sent even if its cursor pushes it over.
		}
		page = append(page, b)
		resultBytes += addition
		if cursorBytes != 0 {
			next = e.ID
		} else {
			next = ""
		}
	}
	result := object{"entries": page}
	if next != "" {
		result["next"] = next
	}
	return result, nil
}
