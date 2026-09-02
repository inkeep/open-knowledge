import { type AddressInfo, createServer as createNetServer } from 'node:net';

export async function getFreePort(
  loopbackHost: '127.0.0.1' | '::1' = '127.0.0.1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, loopbackHost, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
