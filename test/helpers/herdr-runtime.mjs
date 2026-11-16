// A stand-in for gpui-kit, gpui-base and herdr: every element builder returns a node that records its
// id and children and accepts any styling call, so a test can walk the tree a mod's render() describes.
// `runtime.props` and `runtime.calls` let the test set the mod's props and see what it ran.

export const runtime = { props: {}, calls: [] };

function element() {
  const node = { id: null, text: [], kids: [] };
  const self = new Proxy(
    {},
    {
      get(_target, name) {
        if (name === 'node') return node;
        return (...args) => {
          if (name === 'id') node.id = args[0];
          if (name === 'child') add(node, args[0]);
          if (name === 'children') for (const kid of args[0]) add(node, kid);
          if (name === 'when' && args[0]) return args[1](self);
          return self;
        };
      },
    }
  );
  return self;
}
function add(node, kid) {
  if (kid === null || kid === undefined || kid === false) return;
  if (typeof kid === 'string') node.text.push(kid);
  else if (kid.node) node.kids.push(kid.node);
}

export class View {}
export const div = element;
export const svg = element;
export const image = element;
export const h_flex = element;
export const v_flex = element;
export const Input = { new: () => element() };
export const ScrollHandle = { new: () => ({ scroll_to_item() {} }) };
export const InputState = {
  new: () => {
    let value = '';
    return { on() {}, value: () => value, set_value: (next) => (value = next), focus() {} };
  },
};

export const props = () => runtime.props;
export const theme = () => new Proxy({}, { get: (_t, name) => `#${String(name)}` });
export const settings = () => ({ zoom: 1 });
export const checking = () => true;
export const home = () => '/Users/someone';
export const nextCommand = () => new Promise(() => {});
export const notify = (n) => runtime.calls.push(['notify', n]);
export const exec = async (...args) => {
  runtime.calls.push(['exec', ...args]);
  return { code: 7, stdout: '000', stderr: '' };
};

/** Every node in draw order. */
export function walk(node, out = []) {
  out.push(node);
  for (const kid of node.kids) walk(kid, out);
  return out;
}
