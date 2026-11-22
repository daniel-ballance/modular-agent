package grok

import (
	"strings"
	"testing"
)

func TestClientIdentityValidation(t *testing.T) {
	for _, value := range []string{"", strings.Repeat("x", 65), "two words", "name/", "name\n", "café"} {
		if _, err := ParseClientIdentity(value); err == nil {
			t.Errorf("accepted invalid client identity %q", value)
		}
	}
	for _, value := range []string{"A", "My-agent_2.0", strings.Repeat("x", 64)} {
		if _, err := ParseClientIdentity(value); err != nil {
			t.Errorf("rejected valid client identity %q: %v", value, err)
		}
	}
}
