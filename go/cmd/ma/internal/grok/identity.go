package grok

import "errors"

const defaultClientIdentity = "modular-agent"

// ClientIdentity is a validated client label. Its zero value uses the default.
type ClientIdentity struct {
	value string
}

// ParseClientIdentity checks an explicit label. An empty label is invalid.
func ParseClientIdentity(value string) (ClientIdentity, error) {
	invalid := errors.New("client identity must be 1 to 64 characters from A-Z, a-z, 0-9, ., _, and -")
	if len(value) < 1 || len(value) > 64 {
		return ClientIdentity{}, invalid
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9', c == '.', c == '_', c == '-':
		default:
			return ClientIdentity{}, invalid
		}
	}
	return ClientIdentity{value}, nil
}

func (id ClientIdentity) name() string {
	if id.value == "" {
		return defaultClientIdentity
	}
	return id.value
}
