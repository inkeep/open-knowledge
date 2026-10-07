import { afterAll, afterEach } from 'vitest';
import { commands } from 'vitest/browser';

await commands.installNetworkGuard();

async function failOnBlockedRequests(when: string): Promise<void> {
  const blocked = await commands.takeBlockedNetworkRequests();
  if (blocked.length > 0) {
    throw new Error(
      `The browser tier reaches only loopback hosts, and ${when} requested ${blocked.join(', ')}. Fake the dependency at its seam, or serve it from the test server.`,
    );
  }
}

afterEach(() => failOnBlockedRequests('this test'));
afterAll(() => failOnBlockedRequests('this file, after its last test,'));
