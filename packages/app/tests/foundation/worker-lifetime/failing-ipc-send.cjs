process.send = function send(message, ...rest) {
  process.stderr.write(`failing ipc send: ${message?.type}\n`);
  const error = Object.assign(new Error('write EPIPE'), {
    code: 'EPIPE',
    errno: -32,
    syscall: 'write',
  });
  const callback = rest.find((part) => typeof part === 'function');
  if (callback === undefined) process.nextTick(() => process.emit('error', error));
  else process.nextTick(callback, error);
  return false;
};
