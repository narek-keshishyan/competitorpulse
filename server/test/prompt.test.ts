import { describe, expect, it } from 'vitest';
import type { Listing } from '@competitorpulse/shared';
import { buildSummaryMessages } from '../src/summaries/prompt.js';

const previous: Listing = {
  title: 'Acme CRM',
  tagline: 'Simple CRM for small teams',
  price: '$39/mo',
  description: 'Track leads and deals in one place.',
};
const current: Listing = { ...previous, price: '$29/mo', tagline: 'The CRM small teams love' };

describe('buildSummaryMessages', () => {
  const [system, user] = buildSummaryMessages(previous, current, ['tagline', 'price']);

  it('sets the task and output constraints in the system message', () => {
    expect(system?.role).toBe('system');
    expect(system?.content).toMatch(/one or two short sentences/i);
    expect(system?.content).toMatch(/untrusted/i);
  });

  it('leads the user message with the concrete before and after values', () => {
    expect(user?.role).toBe('user');
    expect(
      user?.content.startsWith(
        'Changes: tagline: "Simple CRM for small teams" -> "The CRM small teams love"; price: "$39/mo" -> "$29/mo".',
      ),
    ).toBe(true);
  });

  it('includes both full listings for context', () => {
    expect(user?.content).toContain(JSON.stringify(previous, null, 2));
    expect(user?.content).toContain(JSON.stringify(current, null, 2));
  });
});
