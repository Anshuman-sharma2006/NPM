export function dispatch(handlers, key) {
  const handler = handlers[key];
  return handler();
}

export function handleMessage() {}

export function installListener(target) {
  target.on('message', handleMessage);
}
