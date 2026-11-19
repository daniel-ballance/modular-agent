package pluginrpc

import (
	"bytes"
	"encoding/json"
	"math/big"
	"modular/api"
	"modular/portable"
	"strings"
)

type Object = portable.Object
type object = Object

func obj(raw json.RawMessage) object {
	var v object
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	_ = decoder.Decode(&v)
	if v == nil {
		v = object{}
	}
	return v
}
func str(v object, key string) string   { s, _ := v[key].(string); return s }
func boolean(v object, key string) bool { b, _ := v[key].(bool); return b }
func real(v object, key string) float64 {
	switch n := v[key].(type) {
	case json.Number:
		f, _ := n.Float64()
		return f
	case float64:
		return n
	}
	return 0
}
func number(v object, key string) int { return int(real(v, key)) }
func asObject(v any) object           { return obj(mustJSON(v)) }

// sameJSON compares values, including numbers with different spellings.
func sameJSON(a, b any) bool {
	decode := func(x any) any {
		d := json.NewDecoder(bytes.NewReader(mustJSON(x)))
		d.UseNumber()
		var v any
		_ = d.Decode(&v)
		return v
	}
	return equalValue(decode(a), decode(b))
}

func equalValue(a, b any) bool {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if other, ok := y[k]; !ok || !equalValue(v, other) {
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
	case json.Number:
		y, ok := b.(json.Number)
		return ok && canonicalNumber(string(x)) == canonicalNumber(string(y))
	default:
		switch b.(type) {
		case map[string]any, []any:
			return false
		}
		return a == b
	}
}

// Use an integer exponent, not a rational expanded by an untrusted exponent.
func canonicalNumber(s string) string {
	mantissa, exponent, _ := strings.Cut(strings.ToLower(s), "e")
	integer, fraction, _ := strings.Cut(strings.TrimPrefix(mantissa, "-"), ".")
	digits := strings.TrimLeft(integer+fraction, "0")
	if digits == "" {
		return "0"
	}
	trimmed := strings.TrimRight(digits, "0")
	power := new(big.Int)
	if exponent != "" {
		power.SetString(exponent, 10)
	}
	power.Add(power, big.NewInt(int64(len(digits)-len(trimmed)-len(fraction))))
	if strings.HasPrefix(mantissa, "-") {
		trimmed = "-" + trimmed
	}
	return trimmed + "e" + power.String()
}

func has(v object, k string) bool { x, ok := v[k]; return ok && x != nil }

var (
	contentOut  = portable.Content
	contentIn   = portable.ReadContent
	toolOut     = portable.Tool
	toolIn      = portable.ReadTool
	callOut     = portable.Call
	callIn      = portable.ReadCall
	statusOut   = portable.StatusOut
	statusIn    = portable.StatusIn
	resultOut   = portable.Result
	resultIn    = portable.ReadResult
	modelOut    = portable.Model
	modelIn     = portable.ReadModel
	requestOut  = portable.Request
	requestIn   = portable.ReadRequest
	responseOut = portable.Response
	responseIn  = portable.ReadResponse
)

func errorOut(err error) object {
	kind, message := "other", err.Error()
	if e, ok := err.(*api.ModelError); ok {
		kind, message = e.Kind, e.Message
		switch kind {
		case "context_too_large":
			kind = "contextTooLarge"
		case "unavailable":
			kind = "temporary"
		}
	}
	return object{"kind": kind, "message": message}
}
