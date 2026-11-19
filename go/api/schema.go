package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
)

func ResolveSchema(raw json.RawMessage) (*jsonschema.Resolved, error) {
	var schema *jsonschema.Schema
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, err
	}
	if schema == nil {
		return nil, errors.New("expected a JSON Schema")
	}
	return schema.Resolve(nil)
}

func ValidateJSON(schema *jsonschema.Resolved, raw json.RawMessage) error {
	if !json.Valid(raw) {
		return errors.New("expected a single JSON value")
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	return schema.Validate(value)
}

// ValidateToolResult checks the final, transformed value against the dispatched tool's schema.
func ValidateToolResult(result ToolResult) error {
	if result.Status != "completed" || len(result.Returns) == 0 {
		return nil
	}
	if len(result.Structured) == 0 {
		return errors.New("completed tool result is missing a value")
	}
	schema, err := ResolveSchema(result.Returns)
	if err == nil {
		err = ValidateJSON(schema, result.Structured)
	}
	if err != nil {
		return fmt.Errorf("tool output: %w", err)
	}
	return nil
}

func ValidateResult(raw json.RawMessage, check *ResultCheck) error {
	schema, err := ResolveSchema(raw)
	if err != nil {
		return err
	}
	value := check.Value
	if len(value) == 0 {
		value = json.RawMessage(check.Result.Text())
	}
	if err := ValidateJSON(schema, value); err != nil {
		return fmt.Errorf("structured turn result did not match schema: %w", err)
	}
	check.Value = bytes.TrimSpace(value)
	return nil
}
