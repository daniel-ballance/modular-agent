"""Only for the scripted desk. All three tokens belong to this disposable fixture."""
import json
import sys
from pathlib import Path
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

url, coder_thread = sys.argv[1:]
root = Path.cwd()


def connection(token):
    return connect(url, subprotocols=['modular-agent-plugin-1'], proxy=None,
                   additional_headers={'Authorization': 'Bearer ' + token})


def rpc(ws, key, method, params):
    ws.send(json.dumps({'jsonrpc': '2.0', 'id': key, 'method': method, 'params': params}))
    reply = json.loads(ws.recv(timeout=5))
    assert reply['id'] == key, 'wrong RPC response'
    return reply


try:
    with connection('not-a-desk-token'):
        raise AssertionError('listener accepted the wrong token')
except InvalidStatus as e:
    assert e.response.status_code == 401, 'wrong token must get HTTP 401'

for agent in ('triage', 'coder', 'verifier'):
    claim = 'verifier' if agent == 'coder' else 'coder'
    project = str(root / 'trees' / claim)
    with connection((root / (agent + '-tools.token')).read_text().strip()) as ws:
        reg = rpc(ws, 'init', 'plugin/initialize', {
            'binding': 'modular-agent-plugin/1',
            'host': {'name': claim, 'version': '1'}, 'project': project, 'home': str(root / 'home'),
            'config': {'callerId': claim}
        })['result']
        source, = reg['toolSources']
        names = {t['name'] for t in source['tools']}
        assert names == ({'post'} if agent == 'verifier' else {'post', 'hand_off'}), 'claim changed registration'
        if agent == 'verifier':
            reply = rpc(ws, 'post', 'tools/call', {
                'toolSource': source['id'], 'sessionId': coder_thread, 'project': project,
                'call': {'id': 'claimed-post', 'name': 'post', 'actorId': 'coder', 'startedBy': 'model',
                         'input': {'kind': 'change', 'text': 'Not from the coder.'}}
            })
            assert reply.get('result', {}).get('status') in ('refused', 'failed'), 'verifier posted as coder'
