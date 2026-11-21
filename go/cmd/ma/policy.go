package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"unicode/utf8"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type policyScope struct {
	Actor      modular.Actor   `json:"actor"`
	Projects   json.RawMessage `json:"projects"`
	Tenants    json.RawMessage `json:"tenants"`
	Represents []string        `json:"represents"`
}

type aclPolicy struct {
	TokenFile string `json:"tokenFile"`
	policyScope
}

type operatorPolicy struct {
	stdio   *modular.ACPActor
	actors  []modular.ACPActor
	tenants map[string]modular.Tenant
	limits  modular.CapacityLimits
}

func defaultLimits() modular.CapacityLimits {
	return modular.CapacityLimits{
		Session: modular.CapacityBounds{Inputs: 32, Calls: 64, Jobs: 16, BufferedBytes: 16 << 20, StorageBytes: 1 << 30, ControlBytes: 8 << 20},
		Tenant:  modular.CapacityBounds{Inputs: 128, Calls: 256, Jobs: 64, BufferedBytes: 64 << 20, StorageBytes: 8 << 30, ControlBytes: 32 << 20},
		Agent:   modular.CapacityBounds{Inputs: 512, Calls: 1024, Jobs: 256, BufferedBytes: 256 << 20, StorageBytes: 32 << 30, ControlBytes: 128 << 20},
	}
}

func readPolicy(path string, optional bool) (policy operatorPolicy, err error) {
	policy.limits = defaultLimits()
	defer func() {
		if err != nil {
			err = fmt.Errorf("policy %s: %w", path, err)
		}
	}()
	f, err := os.Open(path)
	if optional && errors.Is(err, os.ErrNotExist) {
		return policy, nil
	}
	if err != nil {
		return policy, err
	}
	defer f.Close()
	const maxPolicyBytes = 1 << 20
	raw, err := io.ReadAll(io.LimitReader(f, maxPolicyBytes+1))
	if err != nil {
		return policy, err
	}
	if len(raw) > maxPolicyBytes || !utf8.Valid(raw) {
		return policy, errors.New("file must be UTF-8 JSON of at most 1 MiB")
	}
	var parsed struct {
		Stdio  *policyScope           `json:"stdio"`
		Actors []aclPolicy            `json:"actors"`
		Limits modular.CapacityLimits `json:"limits"`
	}
	parsed.Limits = policy.limits
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&parsed); err != nil {
		return policy, err
	}
	if next := bytes.TrimSpace(raw); len(next) == 0 || next[0] != '{' {
		return policy, errors.New("expected a policy object")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return policy, errors.New("expected one policy object")
	}
	for _, b := range []modular.CapacityBounds{parsed.Limits.Session, parsed.Limits.Tenant, parsed.Limits.Agent} {
		for _, v := range []int64{b.Inputs, b.Calls, b.Jobs, b.BufferedBytes, b.StorageBytes, b.ControlBytes} {
			if v < 0 || v > 9007199254740991 {
				return policy, errors.New("limits must be nonnegative safe integers")
			}
		}
		if b.ControlBytes > b.StorageBytes {
			return policy, errors.New("controlBytes exceeds storageBytes")
		}
	}
	policy.limits = parsed.Limits
	convert := func(s policyScope) (modular.ACPActor, error) {
		r := modular.ACPActor{Actor: s.Actor}
		if len(s.Represents) != 0 {
			return r, errors.New("represents must be empty in ma")
		}
		if s.Actor.ID == "" || !slices.Contains([]string{"host", "user", "agent", "program"}, s.Actor.Kind) || s.Actor.Rights == nil || slices.ContainsFunc(s.Actor.Rights, func(right string) bool { return !slices.Contains(modular.LocalACPActor().Rights, right) }) {
			return r, errors.New("actor requires an ID, known kind and a rights list")
		}
		if s.Projects != nil {
			if err := json.Unmarshal(s.Projects, &r.Projects); err != nil || r.Projects == nil {
				return r, errors.New("projects must be a list of absolute directory paths")
			}
			for i, project := range r.Projects {
				if !filepath.IsAbs(project) {
					return r, errors.New("projects must be absolute directory paths")
				}
				p, err := canonical(project)
				if err != nil {
					return r, fmt.Errorf("projects: %w", err)
				}
				if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
					return r, errors.New("projects must name existing directories")
				}
				r.Projects[i] = p
			}
		}
		if s.Tenants != nil {
			var names []*string
			if err := json.Unmarshal(s.Tenants, &names); err != nil || names == nil {
				return r, errors.New("tenants must be a list of names or null entries")
			}
			r.Tenants = make([]string, len(names))
			for i, name := range names {
				if name == nil {
					continue
				}
				if *name == "" {
					return r, errors.New("tenant name is empty; use null for no tenant")
				}
				r.Tenants[i] = *name
				if policy.tenants == nil {
					policy.tenants = map[string]modular.Tenant{}
				}
				policy.tenants[*name] = modular.Tenant{Rights: modular.LocalACPActor().Rights}
			}
		}
		return r, nil
	}
	if parsed.Stdio != nil {
		s, err := convert(*parsed.Stdio)
		if err != nil {
			return policy, fmt.Errorf("stdio: %w", err)
		}
		policy.stdio = &s
	}
	if parsed.Actors != nil {
		policy.actors = make([]modular.ACPActor, 0, len(parsed.Actors))
	}
	for i, row := range parsed.Actors {
		actor, err := convert(row.policyScope)
		if err != nil {
			return policy, fmt.Errorf("actors[%d]: %w", i, err)
		}
		path := row.TokenFile
		if path == "" {
			return policy, fmt.Errorf("actors[%d] needs tokenFile", i)
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(filepath.Dir(f.Name()), path)
		}
		actor.TokenFile = path
		policy.actors = append(policy.actors, actor)
	}
	return policy, modular.ValidateACPActorTokens(policy.actors)
}
