package historyhttp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

const pageLimit = 4 << 20
const appendLimit = 64 << 20
const maxLeaseBytes = 128

func validLease(s string) bool {
	if len(s) == 0 || len(s) > maxLeaseBytes {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// appendBody uses the same encoding for the size check and the wire.
func appendBody(lease string, entries []json.RawMessage) json.RawMessage {
	return raw(struct {
		Lease   string            `json:"lease"`
		Entries []json.RawMessage `json:"entries"`
	}{lease, entries})
}

type fields map[string]json.RawMessage

func textOf(raw json.RawMessage) (string, bool) {
	var v *string
	if json.Unmarshal(raw, &v) != nil || v == nil {
		return "", false
	}
	return *v, true
}

func idOf(raw json.RawMessage) string {
	v, _ := textOf(raw)
	return v
}

func entryID(raw json.RawMessage) string {
	return idOf(objectOf(raw)["id"])
}

func raw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// strictObject keeps opaque number literals and rejects ambiguous spellings
// before Go's decoder can replace invalid characters or drop duplicate keys.
func strictObject(b []byte) (fields, error) {
	if !utf8.Valid(b) || !pairedSurrogates(b) {
		return nil, fmt.Errorf("invalid Unicode")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	first, err := d.Token()
	if err != nil || first != json.Delim('{') {
		return nil, fmt.Errorf("expected JSON object")
	}
	if err := checkChildren(d, '{'); err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing JSON data")
	}
	var f fields
	err = json.Unmarshal(b, &f)
	return f, err
}

func checkChildren(d *json.Decoder, open json.Delim) error {
	var keys map[string]struct{}
	if open == '{' {
		keys = make(map[string]struct{})
	}
	for d.More() {
		if keys != nil {
			k, err := d.Token()
			if err != nil {
				return err
			}
			key, ok := k.(string)
			if !ok {
				return fmt.Errorf("invalid object key")
			}
			if _, exists := keys[key]; exists {
				return fmt.Errorf("duplicate object key")
			}
			keys[key] = struct{}{}
		}
		v, err := d.Token()
		if err != nil {
			return err
		}
		if delim, ok := v.(json.Delim); ok {
			if delim != '{' && delim != '[' {
				return fmt.Errorf("unexpected delimiter")
			}
			if err := checkChildren(d, delim); err != nil {
				return err
			}
		}
	}
	_, err := d.Token()
	return err
}

func pairedSurrogates(b []byte) bool {
	for i := 0; i < len(b); i++ {
		if b[i] != '\\' {
			continue
		}
		i++
		if i+4 >= len(b) || b[i] != 'u' {
			continue
		}
		n, err := strconv.ParseUint(string(b[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(b) || b[i+1] != '\\' || b[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(b[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		} else if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
	}
	return true
}

// normalizedDecimal represents a valid JSON number as coefficient * 10^power.
// It never constructs the power of ten, even for an opaque exponent above 2^53.
func normalizedDecimal(n string) (string, *big.Int) {
	power := new(big.Int)
	if i := strings.IndexAny(n, "eE"); i >= 0 {
		power.SetString(n[i+1:], 10)
		n = n[:i]
	}
	neg := strings.HasPrefix(n, "-")
	n = strings.TrimPrefix(n, "-")
	frac := 0
	if whole, fraction, ok := strings.Cut(n, "."); ok {
		frac = len(fraction)
		n = whole + fraction
	}
	n = strings.TrimLeft(n, "0")
	trimmed := strings.TrimRight(n, "0")
	if trimmed == "" {
		return "0", new(big.Int)
	}
	power.Add(power, big.NewInt(int64(len(n)-len(trimmed)-frac)))
	if neg {
		trimmed = "-" + trimmed
	}
	return trimmed, power
}

func count(v json.RawMessage) (uint64, bool) {
	if len(v) == 0 || (v[0] != '-' && (v[0] < '0' || v[0] > '9')) {
		return 0, false
	}
	s, p := normalizedDecimal(string(v))
	if !p.IsInt64() || p.Sign() < 0 || p.Int64() > 16 || len(s)+int(p.Int64()) > 16 {
		return 0, false
	}
	n, err := strconv.ParseUint(s+strings.Repeat("0", int(p.Int64())), 10, 64)
	return n, err == nil && n <= 9007199254740991
}

func equalValue(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		xc, xp := normalizedDecimal(string(x))
		yc, yp := normalizedDecimal(string(y))
		return xc == yc && xp.Cmp(yp) == 0
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			other, exists := y[k]
			if !exists || !equalValue(v, other) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i, v := range x {
			if !equalValue(v, y[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}

func equalJSON(a, b []byte) bool {
	parse := func(b []byte) (any, error) {
		d := json.NewDecoder(bytes.NewReader(b))
		d.UseNumber()
		var v any
		err := d.Decode(&v)
		return v, err
	}
	x, err := parse(a)
	y, other := parse(b)
	return err == nil && other == nil && equalValue(x, y)
}

func objectOf(raw json.RawMessage) fields {
	var f fields
	_ = json.Unmarshal(raw, &f)
	return f
}

func idsOf(raw json.RawMessage, allowEmptyArray bool) ([]string, bool) {
	var ids []string
	if json.Unmarshal(raw, &ids) != nil || ids == nil || (!allowEmptyArray && len(ids) == 0) {
		return nil, false
	}
	for _, id := range ids {
		if id == "" {
			return nil, false
		}
	}
	return ids, true
}

func tombstone(f fields) json.RawMessage {
	if bytes.Equal(f["erased"], []byte("true")) {
		return raw(f)
	}
	t := fields{"id": f["id"], "parentId": f["parentId"], "kind": raw(nil), "erased": raw(true)}
	kind, ok := textOf(f["kind"])
	if ok {
		t["kind"] = f["kind"]
	}
	for _, k := range []string{"turnId", "stepId", "toolCallId", "jobId", "inputId", "requestId", "continuesTurnId"} {
		if _, ok := textOf(f[k]); ok {
			t[k] = f[k]
		}
	}
	if _, ok := idsOf(f["sources"], true); ok {
		t["sources"] = f["sources"]
	}
	d := objectOf(f["data"])
	fallback := func(k string, values ...json.RawMessage) {
		if _, present := f[k]; present {
			return
		}
		for _, v := range values {
			if idOf(v) != "" {
				t[k] = v
				return
			}
		}
	}
	var usage fields
	switch kind {
	case "inputAccepted", "input", "inputHandedBack":
		fallback("inputId", d["inputId"])
		_, top := f["inputId"]
		_, inner := d["inputId"]
		if kind == "inputHandedBack" && !top && !inner {
			if _, ok := idsOf(d["inputIds"], false); ok {
				t["inputIds"] = d["inputIds"]
			}
		}
	case "inputRequest":
		fallback("requestId", d["requestId"], objectOf(d["request"])["id"])
	case "inputAnswer":
		fallback("requestId", d["requestId"])
	case "turnStart":
		fallback("continuesTurnId", d["continuesTurnId"])
	case "response":
		usage = objectOf(objectOf(f["message"])["usage"])
	case "jobEnded", "turnEnd":
		usage = objectOf(d["usage"])
	case "jobStarted":
		if idOf(d["key"]) != "" && idOf(f["writer"]) != "" {
			t["writer"], t["jobKey"] = f["writer"], d["key"]
		}
	}
	if usage != nil {
		kept := fields{}
		for _, k := range []string{"input", "output", "cacheRead", "cacheWrite"} {
			if _, ok := count(usage[k]); ok {
				kept[k] = usage[k]
			}
		}
		if v := usage["cost"]; len(v) > 0 && (v[0] == '-' || (v[0] >= '0' && v[0] <= '9')) {
			if n, _ := normalizedDecimal(string(v)); !strings.HasPrefix(n, "-") {
				kept["cost"] = v
			}
		}
		if _, in := kept["input"]; in {
			if _, out := kept["output"]; out {
				t["usage"] = raw(kept)
			}
		}
	}
	return raw(t)
}
