import { vi } from 'vitest';

// No test may query real DNS: the default resolver of lib/email-domain.ts cannot be constructed here,
// so a test that reaches it without injecting a resolver gets 'Unchecked' at once instead of waiting on the network.
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    constructor() {
      throw new Error('real DNS is never queried in tests: inject a resolver or mock lib/email-domain.js');
    }
  },
}));
