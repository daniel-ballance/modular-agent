package subscription_test

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

const fakeClaude = `
const send = row => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...row}) + '\n');
const reply = (id,result) => send({id,result});
const io = require('node:readline').createInterface({input:process.stdin});
const model = {provider:'claude', id:'claude-haiku-5-5', input:['text','image'], reasoning:true, thinking:['off','low'], contextWindow:314159, maxOutput:128000};
const pending = new Map();
let seq = 0;
function hook(parent, hook, payload, next) {
 const id = 'fake-' + (++seq);
 pending.set(id,next);
 send({id,method:'host/hook',params:{parentRequestId:parent,hook,payload}});
}
io.on('line', line => {
 const {id,method,params:p,result} = JSON.parse(line);
 switch(method) {
 case 'plugin/initialize':
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) process.exit(2);
  reply(id,{binding:p.binding,name:'fake-claude',providers:[{id:'claude',supports:{keepsState:false,runsTools:false}, models:[model]}]});
  break;
 case 'provider/models': reply(id,{models:[model]}); break;
 case 'provider/available': reply(id,process.env.CLAUDE_CONFIG_DIR === 'fake-api-key' ? {available:false,reason:'Claude Code is using an API key from user'} : {available:true}); break;
 case 'provider/request': {
  const scope = {provider:p.provider,model:p.model,sessionId:p.sessionId ?? null};
  hook(id,'provider.request',{...scope,request:p.request}, grant => {
   if (!grant || grant.request.messages[0]?.content[0]?.text !== 'hello') process.exit(3);
   send({method:'provider/event',params:{parentRequestId:id,event:{type:'text',delta:'from Claude fixture'}}});
   const message = {role:'assistant',content:[{type:'text',text:'from Claude fixture'}],stop:'finished',usage:{input:4,output:5}};
   hook(id,'provider.response',{...scope,message}, () => reply(id,message));
  }); break;
 }
 case 'plugin/shutdown': reply(id,{}); break;
 default: { const next = pending.get(id); if(next){ pending.delete(id); next(result); } }
 }
});
`

func fakeClaudeProgram(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("the Claude program needs Node.js")
	}
	path := filepath.Join(t.TempDir(), "main.cjs")
	if err := os.WriteFile(path, []byte(fakeClaude), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClaudeProcessProvider(t *testing.T) {
	path := fakeClaudeProgram(t)
	for _, wire := range []bool{false, true} {
		name := "inProcess"
		if wire {
			name = "overWire"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-do-not-forward")
			t.Setenv("ANTHROPIC_API_KEY", "fixture-do-not-forward")
			t.Setenv("CLAUDE_CONFIG_DIR", "fake-subscription")
			t.Setenv("MODULAR_AGENT_CLAUDE_SIDECAR", path)
			c, err := subscription.Claude(t.Context(), subscription.ClaudeOptions{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = c.Close() })
			available, reason := c.Status(t.Context())
			if !available || reason != "" {
				t.Fatal("fake plan not available", reason)
			}
			opt := modular.WithPlugin(c.Plugin())
			if wire {
				opt = modulartest.OverWire(c.Plugin())
			}
			a, err := modular.New(t.Context(), modular.WithProject(t.TempDir()), opt)
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(t.Context())
			models := a.Models()
			if len(models) != 1 || models[0].ContextWindow != 314159 || models[0].ModelRef.String() != "claude/claude-haiku-5-5" {
				t.Fatalf("account catalog not returned: %+v", models)
			}
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Prompt(t.Context(), "hello")
			if err != nil || out.Outcome == nil || out.Outcome.Kind != "completed" || out.Text != "from Claude fixture" {
				t.Fatalf("unexpected result: %+v %v", out, err)
			}
		})
	}
}

func TestClaudeRefusesAPIKeyAccount(t *testing.T) {
	t.Setenv("CLAUDE_CONFIG_DIR", "fake-api-key")
	c, err := subscription.Claude(t.Context(), subscription.ClaudeOptions{Program: fakeClaudeProgram(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if available, reason := c.Status(t.Context()); available || !strings.Contains(reason, "API key from user") || c.Provider().Available() {
		t.Fatal("key-based account should be unavailable with its source", reason)
	}
}

func TestClaudeMissingProgramNamesBothOptions(t *testing.T) {
	_, err := subscription.Claude(t.Context(), subscription.ClaudeOptions{Program: filepath.Join(t.TempDir(), "missing.js")})
	var e *modular.Error
	if !errors.As(err, &e) || e.Code != modular.InvalidComposition || !strings.Contains(e.Message, "Program") || !strings.Contains(e.Message, "MODULAR_AGENT_CLAUDE_SIDECAR") {
		t.Fatal(err)
	}
}
