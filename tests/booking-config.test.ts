import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function scriptOrder(html: string): string[] {
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
}

describe('Cal.com booking wiring', () => {
  it('points at the live event as a bare <user>/<event> path', () => {
    expect(read('js/config.js')).toMatch(/CAL_LINK: 'tridha-consulting\/exploration-call',/);
  });

  it.each(['index.html', 'book.html'])('%s loads config.js before booking.js, and booking.js before form.js', (page) => {
    const order = scriptOrder(read(page));
    const config = order.indexOf('js/config.js');
    const booking = order.indexOf('js/booking.js');
    expect(config).toBeGreaterThanOrEqual(0);
    expect(booking).toBeGreaterThan(config);
    const form = order.indexOf('js/form.js');
    if (form !== -1) expect(form).toBeGreaterThan(booking);
  });

  it('loads track.js before booking.js so a booking can be counted', () => {
    for (const page of ['index.html', 'book.html']) {
      const order = scriptOrder(read(page));
      expect(order.indexOf('js/track.js')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('js/track.js')).toBeLessThan(order.indexOf('js/booking.js'));
    }
  });

  it('never loads the Cal embed from a page script tag', () => {
    for (const page of ['index.html', 'book.html']) expect(read(page)).not.toMatch(/embed\.js/);
  });
});
