#!/usr/bin/env python3
"""Run the scripted checks, serve the desk, or send one build failure to live agents."""
import argparse
import base64
import concurrent.futures
import json
import os
import selectors
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path
from tempfile import TemporaryDirectory, gettempdir, mkdtemp
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

DEMO = Path(__file__).resolve().parent
HOST = DEMO / 'host/dist/main.js'
CASES = ['happy', 'refusal', 'verification', 'restart', 'duplicate', 'host-restart', 'host-decline', 'callers']


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
    def __init__(self, root, proc, url, deadline=None):
        self.root, self.proc, self.url = root, proc, url
        self.deadline = deadline
        secret = (root / 'page.token').read_text().strip()
        self.page = 'Basic ' + base64.b64encode(('desk:' + secret).encode()).decode()
        self.webhook = 'Bearer ' + (root / 'events.token').read_text().strip()

    def request(self, path, body=None, token=None):
        req = Request(self.url + path, headers={'Authorization': token or self.page,
                      'Content-Type': 'application/json'},
                      data=None if body is None else json.dumps(body).encode())
        # A page answer waits for the next interrupt or the end of the run,
        # including any live inference. Bound live exchanges by the event budget.
        timeout = 20 if self.deadline is None else self.deadline - time.monotonic()
        check(timeout > 0, 'live event exceeded its time budget')
        with HTTP.open(req, timeout=timeout) as res:
            return json.load(res)

    def event(self, kind='build-failed', payload='percentage(37) returned zero'):
        return self.request('/events', {'id': 'build-17', 'kind': kind, 'payload': payload}, self.webhook)['accepted']

    def state(self):
        check(self.proc.poll() is None, 'host exited')
        s = self.request('/state')
        check(not any(r['state'] in ('failed', 'unconfirmed') for r in s['routes']),
              'route failed: ' + str([p['text'] for p in s['posts'] if p['kind'] == 'notice']))
        return s

    def approval(self):
        def first():
            s = self.state()
            return next((q for q in s['inbox'] if q['answerable']), None)
        q = wait(first, 'coder approval')
        call = json.loads((DEMO / 'coder/model.json').read_text())[0]['toolCalls'][0]
        metadata = q.get('metadata', {})
        check(metadata.get('modular-agent.approvalCall') == call, 'approval did not carry the exact call for display')
        check(q['agent'] == 'coder' and q['reason'] == 'approval' and q['toolCallId'] and q['expiresAt'] and
              metadata.get('modular-agent.coversNested') is True and
              call['name'] in q['message'] and json.dumps(call['input']['code']) in q['message'],
              'approval did not show the complete script and its nested-call coverage')
        return q

    def answer(self, q):
        return self.request('/answers', {'route': q['route'], 'answers': [
            {'interruptId': q['id'], 'status': 'resolved', 'payload': {'allow': True}}]})

    def settled(self):
        def done():
            s = self.state()
            return s if s['routes'] and all(r['state'] == 'done' for r in s['routes']) else None
        return wait(done, 'settled routes')

    def tree(self, agent, *args):
        return subprocess.check_output(['git', '-C', self.root / 'trees' / agent, *args], text=True).strip()


def live_environment():
    # Pass paths, not credentials. Each Provider takes the SDK's refresh lock
    # beside the original file. Keep the agents' own data directories separate.
    config = Path(os.getenv('XDG_CONFIG_HOME') or Path.home() / '.config') / 'modular-agent'
    config = Path(os.getenv('MODULAR_AGENT_DATA_DIR') or config)
    env = {'DESK_LIVE': '1', 'DESK_LOGINS': str((config / 'auth.json').absolute()),
           'CLAUDE_CONFIG_DIR': str(Path(os.getenv('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').absolute()),
           'DESK_IDLE_MS': '60000', 'OTEL_SERVICE_NAME': 'ops-desk'}
    for key in ('OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SDK_DISABLED', 'DESK_PORT', 'DESK_APPROVAL_MS'):
        if key in os.environ:
            env[key] = os.environ[key]
    for agent, default in [('triage', 'grok/grok-4.7'), ('coder', 'claude/claude-sonnet-5-5'),
                           ('verifier', 'chatgpt/gpt-6.1-sol')]:
        key = 'DESK_' + agent.upper() + '_MODEL'
        provider, _, model = os.getenv(key, default).partition('/')
        check(provider == default.split('/')[0] and model, f'{key} must name a {default.split("/")[0]} model (provider/id)')
        env[key] = f'{provider}/{model}'
    return env


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    if proc.stdout:
        proc.stdout.close()


@contextmanager
def check_traces():
    with subprocess.Popen(['node', DEMO / 'scripts/trace-receiver.mjs'], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True) as proc:
        try:
            endpoint = proc.stdout.readline().strip()
            check(endpoint.startswith('http://127.0.0.1:'), 'trace receiver did not start on loopback')
            yield endpoint
            # The desk and its agents have stopped and flushed their exporters.
            out, _ = proc.communicate(timeout=10)
            check(proc.returncode == 0, 'trace receiver failed')
            result = json.loads(out)
            events, invocations = result['events'], result['invocations']
            check(len(events) == 1 and len(events[0]) == 32 and int(events[0], 16), 'expected one desk.event trace')
            origins = [s for s in invocations if s['trace'] == events[0]]
            check({s['service'] for s in origins} == {'desk-triage', 'desk-coder', 'desk-verifier'},
                  f'missing agent invocation in the event trace: {origins}')
            coder = next(s for s in origins if s['service'] == 'desk-coder')
            check(len(invocations) == 4 and any(
                s['thread'] == coder['thread'] and any(link['traceId'] == coder['trace'] and
                link['spanId'] == coder['span'] for link in s['links']) for s in invocations),
                'the approval continuation did not link to the coder turn')
        finally:
            stop(proc)


@contextmanager
def station(env, cwd, log):
    side = subprocess.Popen(['setpriv', '--pdeathsig', 'KILL', '--', 'node', HOST.with_name('station.js')],
                            env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=log, text=True)
    try:
        url = side.stdout.readline().strip()
        check(url.startswith('ws://127.0.0.1:'), 'agent station did not print its loopback plugin address')
        yield url
    finally:
        stop(side)


@contextmanager
def start(temp, case, trace_endpoint=None):
    root = temp / 'desk'
    env = {'HOME': str(temp), 'PATH': os.environ['PATH'], 'TMPDIR': os.environ['TMPDIR'],
           'DESK_DATA': str(root), 'DESK_PORT': '0', 'DESK_IDLE_MS': '500',
           'DESK_APPROVAL_MS': '800' if case == 'refusal' else '180000'}
    if trace_endpoint:
        env['OTEL_EXPORTER_OTLP_ENDPOINT'] = trace_endpoint
    if case == 'live':
        env.update(live_environment())
    if case == 'restart':
        env['DESK_TEST_HOLD_HANDOFF'] = '1'
    if case == 'verification':
        # A stronger test, not a scripted failing verdict. The first fix misses the upper bound.
        sample = temp / 'regression'
        shutil.copytree(DEMO / 'sample', sample)
        fixtures = sample / 'cases.json'
        fixtures.write_text(json.dumps([*json.loads(fixtures.read_text()), [135, 100]]))
        env['DESK_SAMPLE'] = str(sample)
    with (temp / 'host.log').open('w') as log, station(env, temp, log) as tools:
        def launch():
            proc = subprocess.Popen(['node', HOST], cwd=temp, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=log, text=True)
            try:
                with selectors.DefaultSelector() as sel:
                    sel.register(proc.stdout, selectors.EVENT_READ)
                    check(sel.select(10), 'host did not print a listener address')
                url = proc.stdout.readline().strip()
                check(url.startswith('http://127.0.0.1:'), 'no loopback listener')
                return proc, url
            except BaseException:
                stop(proc)
                raise

        desk = None
        try:
            desk = Desk(root, *launch(), time.monotonic() + 600 if case == 'live' else None)
            desk.launch = launch
            desk.tools = tools
            yield desk
        except Exception:
            if case == 'live':
                print(f'Live run kept at {temp}. See host.log and desk/*.log.', file=sys.stderr)
                raise
            for path in [temp/'host.log', *sorted(root.glob('*.log'))]:
                with path.open('rb') as f:
                    f.seek(max(0, path.stat().st_size - 1500))
                    if detail := f.read().decode(errors='replace').strip():
                        print(f'{path.name}: {detail}', file=sys.stderr)
            raise
        finally:
            if desk:
                stop(desk.proc)


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
        check(any(f"Question {q['id']}: expired" == p['text'] for p in s['posts']), 'missing expiry post')
        try:
            d.answer(q)
        except HTTPError as error:
            check(error.code == 409, 'late answer should conflict')
        else:
            raise RuntimeError('accepted a late answer')
        view = d.request(f"/sessions/{q['route']}")
        check(not view['waiting']['questions'] and any(m.get('toolCallId') == q['toolCallId'] and
              m.get('error') == 'timeLimit' for m in view['messages']), 'missing deadline settlement')
        check(d.tree('coder', 'rev-parse', 'HEAD') == seed and not d.tree('coder', 'status', '--porcelain'),
              'deadline changed the checkout')
        return
    q = d.approval()
    if case == 'callers':
        subprocess.run([DEMO / 'triage/.venv/bin/python', DEMO / 'scripts/check-callers.py', d.tools, q['thread']],
                       cwd=d.root, check=True, timeout=20)
    if case in ('host-restart', 'host-decline'):
        d.proc.kill()
        check(d.proc.wait() == -signal.SIGKILL, 'host was not killed')
        d.proc.stdout.close()
        if case == 'host-decline':
            # Commit the decision directly on the coder while no desk can observe the run.
            subprocess.run(['node', DEMO / 'scripts/decline.mjs', q['thread'], q['id']],
                           cwd=d.root, check=True, timeout=20)
            with sqlite3.connect(d.root / 'desk.sqlite') as db:
                db.execute('DELETE FROM inbox')  # no prompt cache; only the feed has the reason
            d.proc, d.url = d.launch()
            s = d.settled()
            check([(item['id'], item['status']) for item in s['inbox']] == [(q['id'], 'declined')],
                  'host missed the decline committed while it was down')
            check(d.tree('coder', 'rev-parse', 'HEAD') == seed and not d.tree('coder', 'status', '--porcelain'),
                  'declined script wrote files')
            return
        # Erase both shortcuts. The route and event are the host's own data.
        with sqlite3.connect(d.root / 'desk.sqlite') as db:
            db.execute('DELETE FROM inbox')
            db.execute('UPDATE runs SET terminal=NULL,work=NULL')
            db.execute('UPDATE wait_feeds SET cursor=? WHERE agent=? AND thread=?', ('foreign', 'coder', q['thread']))
            db.execute('UPDATE routes SET thread=NULL WHERE id=?', (q['route'],))
        d.proc, d.url = d.launch()
        again = d.approval()
        receipts = [r for r in d.state()['runs'] if r['thread'] == q['thread']]
        check([(r['kind'], r['terminal'], r['work']) for r in receipts] == [('input', 'interrupt', 'completed')],
              'the restored receipt must describe the parked input, not its later answer')
        check(all(again[k] == q[k] for k in ('route', 'thread', 'id', 'message', 'toolCallId', 'expiresAt')),
              'listing did not restore the same open approval')
    check(d.tree('coder', 'rev-parse', 'HEAD') == seed and not d.tree('coder', 'status', '--porcelain'),
          'coder wrote before approval')
    if case == 'restart':
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            answer = pool.submit(d.answer, q)
            marker = d.root / 'held-handoff'
            pid = wait(lambda: int(marker.read_text()) if marker.exists() and marker.stat().st_size else None,
                       'queued hand-off before its tool result')
            # This agent does not keep feed cursors across its own restart. Drain
            # the decision we assert below before taking that reader away.
            wait(lambda: any(i['id'] == q['id'] and i['status'] == 'answered' for i in d.state()['inbox']),
                 'committed allow in the closure feed')
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
    check(all(q['status'] == 'answered' for q in s['inbox']), 'missing allowed decision from feed')
    check([r['agent'] for r in s['routes']] == ['triage', 'coder', 'verifier'] + (['coder', 'verifier'] if case == 'verification' else []), 'duplicate or missing route')
    check(s['cursor'] == 1, 'wrong listener cursor')
    commit = d.tree('coder', 'rev-parse', 'HEAD')
    check(commit != seed and commit == d.tree('verifier', 'rev-parse', 'HEAD') == s['routes'][-1]['revision'],
          'verifier did not test the coder commit')
    check(d.tree('verifier', 'diff', '--name-only', 'seed', 'HEAD').splitlines() == ['change.txt', 'limits.py'] and
          d.tree('coder', 'rev-list', '--count', 'seed..HEAD') == ('2' if case == 'verification' else '1') and
          len(s['inbox']) == (2 if case == 'verification' else 1),
          'expected both file changes and just one approval per script')
    if case == 'restart':
        receipts = [r for r in s['runs'] if r['thread'] == q['thread']]
        check([(r['kind'], r['terminal'], r['work']) for r in receipts] ==
              [('input', 'interrupt', 'completed'), ('answer', 'unknown', 'completed')] and
              receipts[1]['stream'] == 'lost' and receipts[0]['runId'] != receipts[1]['runId'],
              'lost answer stream and recovered work were not reported separately: ' + str(receipts))
        check(s['routes'][1]['state'] == 'done' and s['routes'][1]['thread'] == q['thread'], 'coder work not completed')
        snap = d.request(f"/sessions/{q['route']}")
        messages = snap['messages']
        check(snap['threadId'] == q['thread'] and snap['declaration']['continuesAfterRestart'] and
              not snap['waiting']['questions'], 'wrong recovered session')
        check(len([m for m in messages if m['role'] == 'user']) == 1, 'coder input admitted twice')
        check(any(m.get('toolCallId') == q['toolCallId'] and m.get('error') == 'interrupted after start'
                  for m in messages) and
              any(m.get('content') == 'The coder turn is finished.' for m in messages),
              'missing uncertain settlement or recovered completion')
        verifier = d.request(f"/sessions/{s['routes'][-1]['id']}")
        check(len([m for m in verifier['messages'] if m['role'] == 'user']) == 1, 'hand-off delivered twice')
    if case == 'host-restart':
        receipts = [r for r in s['runs'] if r['thread'] == q['thread']]
        check([(r['kind'], r['terminal'], r['work']) for r in receipts] ==
              [('input', 'interrupt', 'completed'), ('answer', 'success', 'completed')],
              'missing receipt for the restored approval or its answer')
    if case in ('happy', 'duplicate'):
        wait(lambda: all(v == 'stopped' for v in d.state()['agents'].values()), 'idle agents to stop')
        snap = d.request(f"/sessions/{posts[1]['route']}")
        check(snap['threadId'] == posts[1]['thread'] and len([m for m in snap['messages'] if m['role'] == 'user']) == 1,
              'snapshot link did not reopen one triage input')


def check_live_result(d, s):
    routes = s['routes']
    for r in routes:
        print(f"{r['agent']} thread {r['thread']}: {r['state']}", flush=True)
    check(all(r['state'] == 'done' for r in routes), 'not every live route finished')
    posts = [p for p in s['posts'] if p['kind'] != 'notice']
    attempts = len([r for r in routes if r['agent'] == 'verifier'])
    check(1 <= attempts <= 3 and [p['kind'] for p in posts] == ['event', 'summary'] + ['change', 'verdict'] * attempts,
          'live flow ended without the expected summary, change and verdict')
    check(not any(q['status'] == 'open' for q in s['inbox']), 'inbox still has open questions')
    for r in routes:
        if r['agent'] == 'coder':
            check(any(q['route'] == r['id'] and q['reason'] == 'approval' and q['status'] == 'answered'
                      for q in s['inbox']), 'coder route lacks an answered approval')
        if r['agent'] == 'verifier':
            verdict = next(p['text'] for p in posts if p['route'] == r['id'] and p['kind'] == 'verdict')
            messages = d.request(f"/sessions/{r['id']}")['messages']
            calls = {c['id'] for m in messages for c in m.get('toolCalls', []) if c['function']['name'] == 'exec'}
            check(any(m.get('toolCallId') in calls and m.get('content') == verdict and not m.get('error')
                      for m in messages), 'verdict does not match the verifier test result')
    check(posts[-1]['text'].startswith('PASS: '), 'verification failed')
    commit = d.tree('coder', 'rev-parse', 'HEAD')
    check(commit != d.tree('coder', 'rev-parse', 'seed') and commit == d.tree('verifier', 'rev-parse', 'HEAD')
          == routes[-1]['revision'], 'verifier did not test the coder commit')
    print(f'PASS live: verifier tested {commit}', flush=True)


def allow_approvals(d, inbox):
    # The page submits one decision for every open question on a route. Never
    # pass an approval off as a text answer or answer a partly stale group.
    for route in sorted({q['route'] for q in inbox if q['status'] == 'open'}):
        group = [q for q in inbox if q['route'] == route and q['status'] == 'open']
        if not all(q['answerable'] and q['reason'] == 'approval' for q in group):
            continue
        for q in group:
            print(f"Allow ({q['agent']}): {q['message']}", flush=True)
        d.request('/answers', {'route': route, 'answers': [
            {'interruptId': q['id'], 'status': 'resolved', 'payload': {'allow': True}} for q in group]})


def run_live(d, approve):
    print(f'Desk: {d.url} (username desk; password in {d.root / "page.token"})', flush=True)
    started = time.monotonic()
    check(d.event(payload='The percentage tests failed: percentage(37) returned 0, expected 37. '
                          'The function should clamp a number to the range 0 to 100.'), 'event not accepted')
    seen = 0
    while True:
        s = d.state()
        for p in s['posts'][seen:]:
            print(f"{time.monotonic() - started:.1f}s {p['kind']}: {p['text']}", flush=True)
        seen = len(s['posts'])
        if approve == 'auto':
            allow_approvals(d, s['inbox'])
        if s['routes'] and all(r['state'] == 'done' for r in s['routes']):
            check_live_result(d, s)
            return
        time.sleep(0.25)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--only', choices=CASES)
    mode.add_argument('--live', action='store_true', help='send one event using your model subscriptions')
    mode.add_argument('--serve', action='store_true', help='start a persistent, scripted desk')
    p.add_argument('--approve', choices=('auto', 'manual'), help='live approvals: answer via the page API or leave for the page (default: manual)')
    args = p.parse_args()
    if args.approve and not args.live:
        p.error('--approve requires --live')
    os.umask(0o077)
    temp = Path(os.environ.get('TMPDIR') or gettempdir()).resolve()
    temp.mkdir(parents=True, exist_ok=True)
    os.environ['TMPDIR'] = str(temp)
    if args.live:
        # Keep the live posts, checkouts and logs for inspection after shutdown.
        directory = Path(mkdtemp(prefix='ops-desk-live-', dir=temp))
        with start(directory, 'live') as desk:
            run_live(desk, args.approve or 'manual')
        return
    if args.serve:
        # Never pass sign-ins, provider keys or the operator's plugin settings.
        keys = ('HOME', 'PATH', 'TMPDIR', 'DESK_BIND', 'DESK_PORT', 'DESK_DATA', 'DESK_IDLE_MS',
                'DESK_APPROVAL_MS', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SDK_DISABLED')
        env = {k: os.environ[k] for k in keys if k in os.environ}
        env['OTEL_SERVICE_NAME'] = 'ops-desk'
        with station(env, Path.cwd(), None):
            while True:
                proc = subprocess.Popen(['setpriv', '--pdeathsig', 'KILL', '--', 'node', HOST], env=env)
                try:
                    if proc.wait() != -signal.SIGKILL:
                        break
                    print('Host killed; rediscovering work from the agents.', file=sys.stderr)
                except KeyboardInterrupt:
                    break
                finally:
                    stop(proc)
        return
    for case in [args.only] if args.only else CASES:
        with TemporaryDirectory(prefix=f'ops-desk-{case}-', dir=temp) as directory:
            with check_traces() if case == 'happy' else nullcontext() as endpoint:
                with start(Path(directory), case, endpoint) as desk:
                    run(desk, case)
        print(f'PASS {case}', flush=True)


if __name__ == '__main__':
    main()
