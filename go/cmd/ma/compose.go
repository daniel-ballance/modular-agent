package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
	"github.com/daniel-ballance/modular-agent/go/modular/mcp"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

func (d layout) auth() subscription.Logins {
	return subscription.SubscriptionLogins(filepath.Join(d.config, "auth.json")).WithAliases(providerAliases)
}
func (d layout) compose(ctx context.Context, o options, settings modular.Settings, store modular.HistoryStore, stderr io.Writer) (*modular.Agent, error) {
	durability := modular.Durable
	if o.transient {
		durability = modular.Kept
	}
	opts := []modular.Option{modular.WithAgentName("ma"), modular.WithProject(o.project), modular.WithProviderAliases(providerAliases), modular.WithDataDir(d.state), modular.WithHistory(store), modular.WithDurability(durability), modular.WithPluginHost(o.acp || o.agui), modular.WithJobReportsStartTurns(true), modular.WithLateAnswersStartTurns(true), modular.WithRefusedSettingsDuringTurn()}
	opts = append(opts, modular.WithCapacityLimits(o.policy.Limits))
	if len(o.policy.Tenants) != 0 {
		opts = append(opts, modular.WithTenants(o.policy.Tenants))
	}
	fixture := o.acp && os.Getenv("MODULAR_AGENT_CONFORMANCE") == "1"
	if fixture {
		if os.Getenv("MODULAR_AGENT_DATA_DIR") == "" {
			return nil, errors.New("conformance mode requires isolated MODULAR_AGENT_DATA_DIR")
		}
		if os.Getenv("MODULAR_AGENT_SCRIPT") != "" || chosenModel(settings) != "" || os.Getenv("OPENAI_API_KEY") != "" || os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("CLAUDE_CODE_OAUTH_TOKEN") != "" || len(d.mcp(o.project, io.Discard)) > 0 {
			return nil, errors.New("conformance mode refuses configured production Providers or servers")
		}
		for _, v := range []string{"chatgpt", "grok"} {
			l, err := d.auth().Login(v)
			if err != nil {
				return nil, err
			}
			if l != nil {
				return nil, errors.New("conformance mode refuses saved sign-ins")
			}
		}
		return modular.New(ctx, append(opts, modular.WithConformanceFixtures(), modular.WithTool(files.FixtureBash()), modular.WithTool(files.Tools("")[0]))...)
	}
	if !o.acp || o.agui || o.startupProject {
		opts = append(opts, mcp.WithServers(d.mcp(o.project, stderr), func(err error) { fmt.Fprintln(stderr, err) }))
	}
	opts = append(opts, modular.WithPlugin(files.Plugin(filepath.Join(d.state, "output"))), modular.WithTool(codemode.Tool(codemode.StandardLimits())),
		modular.WithInputTransform(func(_ context.Context, c modular.Content) (modular.Content, error) {
			if !strings.HasPrefix(c.Text(), "/skill:") {
				return c, nil
			}
			skills, _ := discover(skillFolders(d.config, d.home, o.project))
			text, err := expandSkill(skills, c.Text())
			if err != nil {
				return nil, err
			}
			out := modular.Text(text)
			for _, p := range c {
				if p.Type != "text" {
					out = append(out, p)
				}
			}
			return out, nil
		}), modular.WithPlugin(modular.Plugin{Name: "standard-prompt", Setup: func(r *modular.Registrar) error {
			if err := r.Command(modular.Command{Name: "skills", Description: "List available skills.", Run: func(_ context.Context, _ string, _ *modular.CommandContext) (string, error) {
				skills, problems := discover(skillFolders(d.config, d.home, o.project))
				var out strings.Builder
				showSkills(&out, stderr, skills, problems)
				return strings.TrimSuffix(out.String(), "\n"), nil
			}}); err != nil {
				return err
			}
			return r.OnTurnBefore(func(_ context.Context, turn modular.TurnBefore) (modular.TurnContribution, error) {
				defs := turn.Tools
				// List the file tools in the Rust definition order, then MCP names.
				order := map[string]int{"read": 0, "exec": 1, "edit": 2, "write": 3, "find": 4, "list": 5}
				rank := func(s string) int {
					if i, ok := order[s]; ok {
						return i
					}
					return len(order)
				}
				slices.SortStableFunc(defs, func(a, b modular.ToolDefinition) int {
					if rank(a.Name) != rank(b.Name) {
						return rank(a.Name) - rank(b.Name)
					}
					return strings.Compare(a.Name, b.Name)
				})
				catalog, err := codemode.Prompt(defs)
				if err != nil {
					return modular.TurnContribution{}, err
				}
				skills, _ := discover(skillFolders(d.config, d.home, turn.Project))
				prompt, err := systemPrompt(filepath.Join(d.config, "AGENTS.md"), turn.Project, skills, catalog, time.Now())
				return modular.TurnContribution{System: prompt}, err
			})
		}}))
	var claude *subscription.ClaudeProvider
	if script := os.Getenv("MODULAR_AGENT_SCRIPT"); script != "" {
		p, err := scripted(script, os.Getenv("MODULAR_AGENT_SCRIPT_LOG"))
		if err != nil {
			return nil, err
		}
		settings["model"] = modulartest.ScriptedModel
		opts = append(opts, modular.WithProvider(p))
	} else {
		overrides, err := d.modelOverrides()
		if err != nil {
			return nil, err
		}
		logins := d.auth()
		chatgpt, err := subscription.ChatGPT(subscription.ChatGPTOptions{Logins: logins, ClientIdentity: o.clientIdentity, CatalogOverrides: overrides["chatgpt"]})
		if err != nil {
			return nil, err
		}
		grok, err := subscription.Grok(subscription.GrokOptions{Logins: logins, ClientIdentity: o.clientIdentity, CatalogOverrides: overrides["grok"]})
		if err != nil {
			return nil, err
		}
		opts = append(opts, modular.WithProvider(chatgpt), modular.WithProvider(grok))
		_, available := subscription.FindClaudeProgram(subscription.ClaudeOptions{})
		if containsClaude(settings) || o.loadClaude || o.command == "models" && available == nil {
			claude, err = subscription.Claude(ctx, subscription.ClaudeOptions{})
			if err != nil {
				return nil, err
			}
			opts = append(opts, modular.WithPlugin(claude.Plugin()))
		}
	}
	a, err := modular.New(ctx, append(opts, modular.WithSettings(settings), modular.WithCredentials(d.auth().CredentialStore()))...)
	if err != nil && claude != nil {
		_ = claude.Close()
	}
	return a, err
}

func (d layout) modelOverrides() (map[string][]subscription.ResponsesModelOverride, error) {
	var overrides map[string][]struct {
		ID        string            `json:"id"`
		Context   int               `json:"contextWindow"`
		MaxTokens int               `json:"maxTokens"`
		Effort    map[string]string `json:"effort"`
	}
	if err := readJSON(filepath.Join(d.config, "models.json"), &overrides); err != nil {
		return nil, err
	}
	for old, current := range providerAliases {
		if models, ok := overrides[old]; ok {
			// Later entries replace earlier entries with the same model id.
			overrides[current] = append(models, overrides[current]...)
			delete(overrides, old)
		}
	}
	out := make(map[string][]subscription.ResponsesModelOverride)
	for provider, models := range overrides {
		for _, model := range models {
			info := modular.ModelInfo{
				ModelRef:      modular.ModelRef{ID: model.ID},
				ContextWindow: model.Context,
				MaxOutput:     model.MaxTokens,
				Input:         []string{"text", "image"},
			}
			out[provider] = append(out[provider], subscription.ResponsesModelOverride{Model: info, Effort: model.Effort})
		}
	}
	return out, nil
}

func scripted(path, log string) (modular.Provider, error) {
	var script []modulartest.Reply
	b, err := os.ReadFile(path)
	if err != nil {
		return modular.Provider{}, err
	}
	if err := json.Unmarshal(b, &script); err != nil {
		return modular.Provider{}, err
	}
	if script == nil {
		return modular.Provider{}, errors.New("model script must be an array")
	}
	p := modulartest.ScriptedProvider(script)
	if log == "" {
		return p, nil
	}
	request := p.Request
	p.Request = func(ctx context.Context, m modular.ModelRef, r modular.ModelRequest, c *modular.ProviderContext) (modular.AssistantMessage, error) {
		tools := []string{}
		for _, t := range r.Tools {
			tools = append(tools, t.Name)
		}
		messages := []map[string]any{}
		for _, m := range r.Messages {
			record := map[string]any{"role": m.Role, "text": m.Content.Text()}
			switch m.Role {
			case "assistant":
				calls := []map[string]any{}
				for _, p := range m.Content {
					if p.Type == "toolCall" {
						calls = append(calls, map[string]any{"name": p.Fields["name"], "input": p.Fields["arguments"]})
					}
				}
				record["toolCalls"] = calls
			case "toolResult":
				record["name"] = m.ToolName
			case "user":
			default:
				continue
			}
			messages = append(messages, record)
		}
		f, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		err = writeJSON(f, map[string]any{"system": r.SystemPrompt, "tools": tools, "messages": messages}, false)
		err = errors.Join(err, f.Close())
		if err != nil {
			return modular.AssistantMessage{}, err
		}
		return request(ctx, m, r, c)
	}
	return p, nil
}
