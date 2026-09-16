import type { SeedreamInput, SeedreamProvider } from '../types.js';

/**
 * Development provider: no network, no credits. Returns the first input image unchanged
 * after a short delay so the whole UI flow (mask → generate → composite → layer) can be exercised.
 */
export function createMockProvider(): SeedreamProvider {
  return {
    name: 'mock',
    async edit(input: SeedreamInput): Promise<string> {
      await new Promise((r) => setTimeout(r, 800));
      // For masked edits image[1] is the "marked" copy — return it so the effect of the mask is visible.
      return input.images[input.images.length - 1];
    },
  };
}
