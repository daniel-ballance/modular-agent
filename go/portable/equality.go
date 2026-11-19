package portable

import (
	"bytes"
	"encoding/json"
	"math/big"
	"reflect"
	"strings"
)

// EqualJSON compares JSON by value without rounding numbers or expanding powers.
func EqualJSON(a, b []byte) bool {
	parse := func(raw []byte) (any, error) {
		d := json.NewDecoder(bytes.NewReader(raw))
		d.UseNumber()
		var v any
		err := d.Decode(&v)
		return v, err
	}
	x, err := parse(a)
	y, other := parse(b)
	return err == nil && other == nil && equalValue(x, y)
}

func decimal(n string) (string, *big.Int) {
	power := new(big.Int)
	if i := strings.IndexAny(n, "eE"); i >= 0 {
		power.SetString(n[i+1:], 10)
		n = n[:i]
	}
	sign := ""
	if n[0] == '-' {
		sign, n = "-", n[1:]
	}
	if i := strings.IndexByte(n, '.'); i >= 0 {
		power.Sub(power, big.NewInt(int64(len(n)-i-1)))
		n = n[:i] + n[i+1:]
	}
	n = strings.TrimLeft(n, "0")
	if n == "" {
		return "0", new(big.Int)
	}
	trimmed := strings.TrimRight(n, "0")
	return sign + trimmed, power.Add(power, big.NewInt(int64(len(n)-len(trimmed))))
}

func equalValue(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		xc, xp := decimal(string(x))
		yc, yp := decimal(string(y))
		return xc == yc && xp.Cmp(yp) == 0
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if w, ok := y[k]; !ok || !equalValue(v, w) {
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
