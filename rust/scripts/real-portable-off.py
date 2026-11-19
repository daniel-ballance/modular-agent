#!/usr/bin/env python3
"""Reopen a synthetic interrupted portable turn against gpt-6-luna once.

Use a disposable History HTTP service via MODULAR_AGENT_HISTORY_URL and
MODULAR_AGENT_HISTORY_TOKEN_FILE. Only the agent reads the OpenAI credential.
"""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import time
from urllib.request import Request, urlopen
from uuid import uuid4

BIN = Path(__file__).resolve().parents[1] / 'target/debug/modular-agent'
MODEL = {'provider': 'openai', 'id': 'gpt-6-luna'}
ACTOR = 'off-check-host'
PROOF = 'PORTABLE-OFF-OK'


def seed(history, session, project):
    entries = []
    now = int(time.time() * 1000)

    def add(kind, id, data=None, message=None, **scope):
        entry = dict(id=id, kind=kind, sessionId=session, time=now,
                     parentId=entries[-1]['id'] if entries else None,
                     writer='portable-off-fixture', modelVisible=message is not None, **scope)
        if data is not None:
            entry['data'] = data
        if message is not None:
            entry['message'] = message
        entries.append(entry)

    settings = {'reasoning': 'off', 'maxOutput': 128, 'maxSteps': 2}
    command = 'touch must-not-run'
    bash = {'name': 'bash', 'description': 'Run a shell command',
            'parameters': {'type': 'object', 'properties': {'command': {'type': 'string'}},
                           'required': ['command']}}
    content = [{'type': 'text', 'text': f'Do not run any more tools. Reply with exactly {PROOF}.'}]
    turn = dict(turnId='turn', actorId=ACTOR)
    step = dict(turn, stepId='step')
    add('setting', 'setting', {'key': 'settings', 'value': dict(settings, model=MODEL)})
    add('actorJoined', 'actor', {'operatorAdmission': True,
        'actor': {'id': ACTOR, 'kind': 'host', 'rights': ['watch', 'input']}})
    add('inputAccepted', 'receipt', {'when': 'now', 'content': content},
        inputId='receipt', actorId=ACTOR)
    add('turnStart', 'start', {'model': MODEL, 'settings': settings, 'tools': [bash],
        'system': 'Continue from the interruption without using any more tools.',
        'startedBy': {'kind': 'actor', 'id': ACTOR}}, **turn)
    add('input', 'input', {'inputId': 'receipt'}, {'role': 'user', 'content': content}, **turn)
    add('modelRequest', 'request', {'model': MODEL, 'tools': ['bash'], 'safeToRepeat': False,
        'tracksStepAfter': True}, **step)
    add('response', 'response', message={'role': 'assistant', 'stop': 'toolUse', 'content': [
        {'type': 'toolCall', 'id': 'call', 'name': 'bash', 'arguments': {'command': command}}
    ]}, **step)
    add('toolStarted', 'bash-start', {'call': {'id': 'call', 'name': 'bash',
        'input': {'command': command}, 'startedBy': 'model', 'actorId': ACTOR},
        'safeToRepeat': False, 'source': {'plugin': 'tools.builtin', 'toolSource': 'tools.builtin'},
        'definition': bash}, toolCallId='call', **step)
    history('PUT', '', {'project': str(project), 'created': now})
    lease = history('POST', '/lease', {'owner': str(uuid4())})['lease']
    try:
        assert history('POST', '/entries', {'lease': lease, 'entries': entries})['kept'] == len(entries)
    finally:
        history('DELETE', '/lease/' + lease)


async def reopen(session, project):
    env = dict(os.environ, MODULAR_AGENT_ACTOR=ACTOR, MODULAR_AGENT_DATA_DIR=str(project / 'state'))
    for name in ('MODULAR_AGENT_CONFORMANCE', 'MODULAR_AGENT_PLUGINS', 'MODULAR_AGENT_PLUGIN_PARTS'):
        env.pop(name, None)
    agent = await asyncio.create_subprocess_exec(
        BIN, '--acp', '--runtime', 'durable', '--provider-mode', 'stateless',
        cwd=project, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL)

    async def rpc(id, method, params):
        request = dict(jsonrpc='2.0', id=id, method=method, params=params)
        agent.stdin.write(json.dumps(request).encode() + b'\n')
        await agent.stdin.drain()
        while line := await agent.stdout.readline():
            event = json.loads(line)
            if event.get('id') == id and 'method' not in event:
                assert 'error' not in event, f'{method} failed: code {event["error"]["code"]}'
                return event['result']
            assert 'id' not in event, 'unexpected ACP client request'
        raise RuntimeError(f'agent closed without replying to {method}')

    try:
        await asyncio.wait_for(rpc(1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {}}), 10)
        result = await asyncio.wait_for(rpc(2, 'session/resume', {
            'sessionId': session, 'cwd': str(project), 'mcpServers': []}), 110)
        options = {option['id']: option for option in result['configOptions']}
        assert options['model']['currentValue'] == 'openai/gpt-6-luna'
        assert options['thinking']['currentValue'] == 'off'
        assert 'off' in [option['value'] for option in options['thinking']['options']]
        await asyncio.wait_for(rpc(3, 'session/close', {'sessionId': session}), 10)
        agent.stdin.close()
        assert await asyncio.wait_for(agent.wait(), 5) == 0
    finally:
        if agent.returncode is None:
            agent.kill()
            await agent.wait()


def main():
    session = str(uuid4())
    url = os.environ['MODULAR_AGENT_HISTORY_URL'].rstrip('/') + '/v1/sessions/' + session
    token = Path(os.environ['MODULAR_AGENT_HISTORY_TOKEN_FILE']).read_text().strip()

    def history(method, path='', data=None):
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        body = json.dumps(data).encode() if data is not None else None
        with urlopen(Request(url + path, body, headers, method=method), timeout=10) as reply:
            return json.load(reply)

    with tempfile.TemporaryDirectory(prefix='ma-live-off-') as directory:
        project = Path(directory).resolve()
        seed(history, session, project)
        asyncio.run(reopen(session, project))
        entries = history('GET')['entries']
        current = [e for e in entries if e['kind'] == 'setting' and e['data']['key'] == 'settings']
        assert current[-1]['data']['value']['reasoning'] == 'off'
        turn = [e for e in entries if e.get('turnId') == 'turn']
        start, = [e for e in turn if e['kind'] == 'turnStart']
        assert start['data']['settings']['reasoning'] == 'off'
        end, = [e for e in turn if e['kind'] == 'turnEnd']
        outcome = end['data']['outcome']['kind']
        assert outcome == 'completed', f'recovered turn ended {outcome}'
        assert end['data']['result']['text'].strip() == PROOF
        assert sum(e['kind'] == 'modelRequest' for e in turn) == 2  # one seeded, one live
        result, = [e for e in turn if e['kind'] == 'toolResult']
        assert result['toolCallId'] == 'call' and result['data']['status'] == 'outcomeUnknown'
        assert sum(e['kind'] == 'toolStarted' for e in turn) == 1
        assert not (project / 'must-not-run').exists()
        print(json.dumps({'session': session, 'model': 'openai/gpt-6-luna', 'reasoning': 'off',
                          'bashResult': 'outcomeUnknown', 'outcome': outcome, 'answer': PROOF}))


if __name__ == '__main__':
    main()
