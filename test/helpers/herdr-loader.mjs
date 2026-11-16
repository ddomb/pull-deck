// Node module hooks that stand in for the Herdr.app runtime's built-in modules, so a test can load the
// Herdr mod (claude-mod/herdr/main.js) and read what it would draw.
const STUB = new URL('./herdr-runtime.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'gpui-kit' || specifier === 'gpui-base' || specifier === 'herdr') {
    return { url: `${STUB}?${specifier}`, shortCircuit: true };
  }
  return next(specifier, context);
}
