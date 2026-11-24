// Approval covers nested calls. It does not widen this sample's file or command scope.
const commit = "git add -- limits.py change.txt && git commit -m 'Fix percentage bounds' -- limits.py change.txt";
const numeric = (s: unknown) =>
  typeof s === 'string' && /^ *(?:return +)?(?:min|max|value|[0-9 (),+-])+$/u.test(s) && !s.includes('\n');

export function coderScope({ name, input }: { name: string; input: Record<string, unknown> }) {
  switch (name) {
    case 'codemode':
    case 'post':
    case 'hand_off':
      return;
    case 'read':
      if (['limits.py', 'test_limits.py', 'cases.json', 'change.txt'].includes(String(input.path))) return;
      break;
    case 'find':
    case 'list':
      if ((input.path ?? '.') === '.') return;
      break;
    case 'edit': {
      const edits = input.edits;
      if (input.path === 'limits.py' && Array.isArray(edits) && edits.length === 1 &&
          numeric(edits[0]?.oldText) && numeric(edits[0]?.newText)) return;
      break;
    }
    case 'write':
      if (input.path === 'change.txt') return;
      break;
    case 'exec':
      if (input.command === commit) return;
  }
  return { refuse: 'Outside the sample: edit the numeric expression, write change.txt and use the fixed commit command.' };
}
