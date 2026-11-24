const byId = (id) => document.getElementById(id);
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
const stream = new EventSource('/stream');
let generation = 0,
  previous = '';
async function refresh() {
  const n = ++generation,
    res = await fetch('/state');
  if (!res.ok) throw Error('Could not load the desk.');
  const { agents, inbox, posts } = await res.json();
  if (n !== generation) return;
  byId('agents').textContent = Object.entries(agents)
    .map(([a, s]) => a + ': ' + s)
    .join(' · ');
  byId('posts').replaceChildren(
    ...posts.map((p) => {
      const li = el('li');
      li.append(el('small', p.event + ' · ' + (p.agent ?? 'listener') + ' · ' + p.kind), el('p', p.text));
      if (p.thread) {
        const link = el('a', 'Session snapshot');
        link.href = '/sessions/' + p.route;
        li.append(link);
      }
      return li;
    })
  );
  const open = inbox.filter((q) => q.status === 'open');
  byId('closed').replaceChildren(
    ...inbox
      .filter((q) => q.status !== 'open')
      .map((q) => el('li', q.agent + ' · ' + q.status + ': ' + q.message))
  );
  if (previous === JSON.stringify(open)) return;
  previous = JSON.stringify(open);
  const groups = new Map();
  for (const q of open) {
    if (!groups.has(q.route)) groups.set(q.route, []);
    groups.get(q.route).push(q);
  }
  byId('inbox').replaceChildren(
    ...(groups.size ? [...groups.values()].map(questionForm) : [el('p', 'No open questions.')])
  );
}
function hasButtons(q) {
  return q.reason === 'approval' || (q.reason === 'choice' && q.responseSchema?.enum?.length);
}
function questionForm(questions) {
  const form = el('form'),
    answers = new Map();
  form.append(el('strong', questions[0].agent));
  for (const q of questions) {
    const label = el('label');
    label.append(el('pre', q.message)); // the unchanged interrupt, not a description from the model
    if (q.toolCallId) label.append(el('small', 'Call: ' + q.toolCallId));
    if (q.metadata?.['modular-agent.coversNested'] === true) {
      label.append(el('strong', 'Allow covers the writes, commands and other calls this script makes.'));
      // ma puts the exact JSON input in the prompt. Also show its code with real line breaks.
      const input = /^Allow codemode with (\{.*\})\? /.exec(q.message);
      if (input) {
        try {
          const { code } = JSON.parse(input[1]);
          if (typeof code === 'string') label.append(el('pre', code));
        } catch { /* Other prompt formats still show the complete unchanged view. */ }
      }
    }
    form.append(label);
    if (q.expiresAt) form.append(el('small', 'Deadline: ' + new Date(q.expiresAt).toLocaleTimeString()));
    if (!q.answerable) {
      form.append(el('small', 'Not answerable'));
      continue;
    }
    if (hasButtons(q)) {
      const choices = q.reason === 'approval' ? ['Allow', 'Refuse'] : (q.responseSchema?.enum ?? []);
      for (const choice of choices) {
        const b = el('button', choice);
        b.type = 'button';
        b.onclick = () => {
          answers.set(q.id, {
            interruptId: q.id,
            status: 'resolved',
            payload: q.reason === 'approval' ? { allow: choice === 'Allow' } : choice
          });
          b.parentElement.querySelector('small.selection').textContent = 'Selected: ' + choice;
          if (questions.length === 1) form.requestSubmit();
        };
        label.append(b);
      }
      const selected = el('small');
      selected.className = 'selection';
      label.append(selected);
    } else {
      if (q.reason === 'link') label.append(el('small', q.metadata?.['modular-agent.link'] ?? ''));
      const input = el('input');
      input.required = true;
      label.append(input);
      input.oninput = () =>
        answers.set(q.id, { interruptId: q.id, status: 'resolved', payload: input.value });
    }
  }
  if (
    questions.every((q) => q.answerable) &&
    (questions.length > 1 || !hasButtons(questions[0]))
  )
    form.append(el('button', 'Send answers'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (answers.size !== questions.length) return;
    try {
      for (const b of form.elements) b.disabled = true;
      const res = await fetch('/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: questions[0].route, answers: [...answers.values()] })
      });
      byId('message').textContent = res.ok ? 'Answer sent.' : (await res.json()).error;
      previous = '';
      await refresh();
    } catch {
      unavailable('Answer exchange interrupted. Refresh to check its status.');
    }
  };
  return form;
}
function unavailable(message) {
  ++generation;
  previous = '';
  byId('inbox').replaceChildren();
  byId('message').textContent = message;
}
stream.onmessage = () => refresh().catch((e) => unavailable(e.message));
stream.onerror = () => unavailable('Disconnected. Waiting for the desk.');
