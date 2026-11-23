#!/usr/bin/env python3
"""Run the scripted desk checks, or serve the desk for a person."""
import argparse
import base64
import concurrent.futures
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

DEMO = Path(__file__).resolve().parent
HOST = DEMO / 'host/dist/main.js'
CASES = ['happy', 'refusal', 'verification', 'restart', 'duplicate']


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirect())


def check(test, message):
    if not test:
        raise RuntimeError(message)


def wait(probe, description):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        if value := probe():
            return value
        time.sleep(0.04)
    raise RuntimeError('timed out waiting for ' + description)


class Desk:
    def __init__(self, root, proc, url):
        self.root, self.proc, self.url = root, proc, url
        secret = (root / 'page.token').read_text().strip()
        self.page = 'Basic ' + base64.b64encode(('desk:' + secret).encode()).decode()
        self.webhook = 'Bearer ' + (root / 'events.token').read_text().strip()

    def request(self, path, body=None, token=None):
        req = Request(self.url + path, headers={'Authorization': token or self.page,
                      'Content-Type': 'application/json'},
                      data=None if body is None else json.dumps(body).encode())
        with HTTP.open(req, timeout=20) as res:
            return json.load(res)

    def event(self, kind='build-failed', payload='percentage(37) returned zero'):
        return self.request('/events', {'id': 'build-17', 'kind': kind, 'payload': payload}, self.webhook)['accepted']

    def state(self):
        check(self.proc.poll() is None, 'host exited')
        s = self.request('/state')
        check(not any(r['state'] == 'failed' for r in s['routes']),
              'route failed: ' + str([p['text'] for p in s['posts'] if p['kind'] == 'notice']))
        return s

    def approval(self):
        def first():
            s = self.state()
            return next((q for q in s['inbox'] if q['answerable']), None)
        q = wait(first, 'coder approval')
        check(q['agent'] == 'coder' and q['reason'] == 'approval' and q['toolCallId'] and
              'apply_change' in q['message'] and 'return' in q['message'] and q['expiresAt'], 'wrong approval view')
        return q

    def answer(self, q):
        return self.request('/answers', {'route': q['route'], 'answers': [
            {'interruptId': q['id'], 'status': 'resolved', 'payload': {'allow': True}}]})

    def settled(self):
        def done():
            s = self.state()
            return s if s['routes'] and all(r['state'] in ('done', 'reopened') for r in s['routes']) else None
        return wait(done, 'settled routes')

    def tree(self, agent, *args):
        return subprocess.check_output(['git', '-C', self.root / 'trees' / agent, *args], text=True).strip()


@contextmanager
def start(temp, case):
    root = temp / 'desk'
    env = {'HOME': str(temp), 'PATH': os.environ['PATH'], 'TMPDIR': os.environ['TMPDIR'],
           'DESK_DATA': str(root), 'DESK_PORT': '0', 'DESK_IDLE_MS': '500',
           'DESK_APPROVAL_MS': '800' if case == 'refusal' else '180000'}
    if case == 'restart':
        env['DESK_TEST_HOLD_HANDOFF'] = '1'
    if case == 'verification':
        # A stronger test, not a scripted failing verdict. The first fix misses the upper bound.
        sample = temp / 'regression'
        shutil.copytree(DEMO / 'sample', sample)
        fixtures = sample / 'cases.json'
        fixtures.write_text(json.dumps([*json.loads(fixtures.read_text()), [135, 100]]))
        env['DESK_SAMPLE'] = str(sample)
    with (temp / 'host.log').open('w') as log:
        proc = subprocess.Popen(['node', HOST], cwd=temp, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            with selectors.DefaultSelector() as sel:
                sel.register(proc.stdout, selectors.EVENT_READ)
                check(sel.select(10), 'host did not print a listener address')
            url = proc.stdout.readline().strip()
            check(url.startswith('http://127.0.0.1:'), 'no loopback listener')
            yield Desk(root, proc, url)
        except Exception:
            for path in [temp/'host.log', *sorted(root.glob('*.log'))]:
                with path.open('rb') as f:
                    f.seek(max(0, path.stat().st_size - 1500))
                    if detail := f.read().decode(errors='replace').strip():
                        print(f'{path.name}: {detail}', file=sys.stderr)
            raise
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=6)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                proc.stdout.close()


def run(d, case):
    initial = d.state()
    check(not initial['posts'] and all(v == 'stopped' for v in initial['agents'].values()),
          'desk started work before an event')
    if case == 'duplicate':
        try:
            d.request('/events', {'id': 'no-grant', 'kind': 'build-failed', 'payload': {}}, d.page)
        except HTTPError as error:
            check(error.code == 401, 'page login should not authorize the webhook')
        else:
            raise RuntimeError('webhook accepted the page credential')
    check(d.event(), 'first event not accepted')
    if case == 'duplicate':
        check(not d.event('issue-opened', 'different payload'), 'duplicate event accepted as new work')
    seed = d.tree('coder', 'rev-parse', 'seed')
    if case == 'refusal':
        # Do not race the deadline to click or even see a button. The terminal
        # record is still available to an operator who arrives after expiry.
        s = d.settled()
        check(len(s['inbox']) == 1, 'expected one closed approval')
        q = s['inbox'][0]
        check(q['agent'] == 'coder' and q['reason'] == 'approval' and q['expiresAt'] and
              not q['answerable'], 'wrong expired approval')
        check(not any(r['agent'] == 'verifier' for r in s['routes']), 'unapproved hand-off')
        check([(x['id'], x['status']) for x in s['inbox']] == [(q['id'], 'expired')], 'wrong inbox closure')
        check(any('Approval refused' in p['text'] for p in s['posts']), 'missing refusal post')
        try:
            d.answer(q)
        except HTTPError as error:
            check(error.code == 409, 'late answer should conflict')
        else:
            raise RuntimeError('accepted a late answer')
        view = d.request(f"/sessions/{q['route']}")
        check(not view['waiting']['questions'] and 'refused' in json.dumps(view['messages']).lower(),
              'agent snapshot does not show the refused change')
        check(d.tree('coder', 'rev-parse', 'HEAD') == seed and not d.tree('coder', 'status', '--porcelain'),
              'deadline changed the checkout')
        return
    q = d.approval()
    check(d.tree('coder', 'rev-parse', 'HEAD') == seed and not d.tree('coder', 'status', '--porcelain'),
          'coder wrote before approval')
    if case == 'restart':
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            answer = pool.submit(d.answer, q)
            marker = d.root / 'held-handoff'
            pid = wait(lambda: int(marker.read_text()) if marker.exists() and marker.stat().st_size else None,
                       'queued hand-off before its tool result')
            os.kill(pid, signal.SIGKILL)
            # The in-flight HTTP exchange can fail, never resubmit the answer.
            try:
                answer.result()
            except HTTPError as error:
                check(error.code == 503, 'unexpected interrupted exchange status')
    else:
        d.answer(q)
    if case == 'verification':
        second = d.approval()
        check(second['id'] != q['id'], 'expected another approval')
        d.answer(second)
    s = d.settled()
    posts = [p for p in s['posts'] if p['kind'] != 'notice']
    kinds = ['event', 'summary', 'change', 'verdict']
    if case == 'verification':
        kinds += ['change', 'verdict']
        check(posts[3]['text'] == 'FAIL: percentage(135): expected 100, got 135', 'first verdict is not the failed test')
    check([p['kind'] for p in posts] == kinds, 'unexpected post order: ' + str([p['kind'] for p in posts]))
    check(posts[-1]['text'] == f"PASS: {3 if case == 'verification' else 2} percentage checks passed", 'wrong pass verdict')
    check(not any(q['status'] == 'open' for q in s['inbox']), 'inbox still has open questions')
    check([r['agent'] for r in s['routes']] == ['triage', 'coder', 'verifier'] + (['coder', 'verifier'] if case == 'verification' else []), 'duplicate or missing route')
    check(s['cursor'] == 1, 'wrong listener cursor')
    commit = d.tree('coder', 'rev-parse', 'HEAD')
    check(commit != seed and commit == d.tree('verifier', 'rev-parse', 'HEAD') == s['routes'][-1]['revision'],
          'verifier did not test the coder commit')
    if case == 'restart':
        check(s['routes'][1]['state'] == 'reopened' and s['routes'][1]['thread'] == q['thread'], 'coder session not reopened')
        snap = d.request(f"/sessions/{q['route']}")
        messages = snap['messages']
        check(snap['threadId'] == q['thread'] and snap['declaration']['continuesAfterRestart'] and
              not snap['waiting']['questions'], 'wrong recovered session')
        check(len([m for m in messages if m['role'] == 'user']) == 1, 'coder input admitted twice')
        check(any('effects are unknown' in m.get('error', '') for m in messages) and
              any(m.get('content') == 'The coder turn is finished.' for m in messages),
              'missing uncertain settlement or recovered completion')
        verifier = d.request(f"/sessions/{s['routes'][-1]['id']}")
        check(len([m for m in verifier['messages'] if m['role'] == 'user']) == 1, 'hand-off delivered twice')
    if case in ('happy', 'duplicate'):
        wait(lambda: all(v == 'stopped' for v in d.state()['agents'].values()), 'idle agents to stop')
        snap = d.request(f"/sessions/{posts[1]['route']}")
        check(snap['threadId'] == posts[1]['thread'] and len([m for m in snap['messages'] if m['role'] == 'user']) == 1,
              'snapshot link did not reopen one triage input')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--only', choices=CASES)
    mode.add_argument('--serve', action='store_true', help='start a persistent, scripted desk')
    args = p.parse_args()
    os.umask(0o077)
    temp = Path(os.environ.get('TMPDIR') or Path.home() / '.cache/ma-std-tmp').resolve()
    temp.mkdir(parents=True, exist_ok=True)
    os.environ['TMPDIR'] = str(temp)
    if args.serve:
        # Never pass sign-ins, provider keys or the operator's plugin settings.
        keys = ('HOME', 'PATH', 'TMPDIR', 'DESK_BIND', 'DESK_PORT', 'DESK_DATA', 'DESK_IDLE_MS',
                'DESK_APPROVAL_MS', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SDK_DISABLED')
        env = {k: os.environ[k] for k in keys if k in os.environ}
        env['OTEL_SERVICE_NAME'] = 'ops-desk'
        os.execvpe('node', ['node', str(HOST)], env)
    for case in [args.only] if args.only else CASES:
        with TemporaryDirectory(prefix=f'ops-desk-{case}-', dir=temp) as directory:
            with start(Path(directory), case) as desk:
                run(desk, case)
        print(f'PASS {case}', flush=True)


if __name__ == '__main__':
    main()
