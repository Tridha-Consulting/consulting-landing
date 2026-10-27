import { describe, expect, it } from 'vitest';
import { COLUMNS, HEADERS, LAST_COLUMN_LETTER, columnIndex, columnLetter, formatIST, toRow, type LeadRow } from '../lib/columns.js';

const lead: LeadRow = {
  fullName: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+919812345678',
  utmSource: 'meta',
  utmCampaign: 'oct',
  gclid: 'G1',
  referrer: 'https://l.facebook.com/',
  landingUrl: 'https://consulting.tridha.net/',
  leadId: '11111111-1111-4111-8111-111111111111',
  submittedAt: new Date('2026-10-24T18:45:09Z'),
  userAgent: 'UA/1.0',
  ip: '203.0.113.9',
};

describe('columns', () => {
  it('has one value per header', () => {
    expect(toRow(lead)).toHaveLength(HEADERS.length);
    expect(COLUMNS).toHaveLength(32);
  });

  it('orders headers as specified', () => {
    expect(HEADERS).toEqual([
      'Submitted At (IST)', 'Full Name', 'Email', 'Phone', 'Status', 'Call Time (IST)', 'Booked At (IST)',
      'Designation', 'Company', 'Website', 'Annual Revenue', 'Budget (3-6 Months)', 'Bottleneck', 'Tech Team',
      'Timeline', 'Decision Maker', 'Booking Details', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Content',
      'UTM Term', 'fbclid', 'gclid', 'li_fat_id', 'Referrer', 'Landing URL', 'User Agent', 'IP', 'Lead ID',
      'Booking UID', 'Last Event At',
    ]);
  });

  it('maps values to the right columns, blank when absent', () => {
    expect(toRow(lead)).toEqual([
      '2026-10-25 00:15:09', 'Asha Rao', 'asha@example.com', '+919812345678', 'New', '', '',
      '', '', '', '', '', '', '', '', '', '',
      'meta', '', 'oct', '', '', '', 'G1', '', 'https://l.facebook.com/', 'https://consulting.tridha.net/',
      'UA/1.0', '203.0.113.9', '11111111-1111-4111-8111-111111111111', '', '',
    ]);
  });

  it('formats IST across a day boundary and zero-pads', () => {
    expect(formatIST(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01 05:30:00');
    expect(formatIST(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01 00:00:00');
  });

  it('leaves every booking column blank for a fresh lead', () => {
    const row = toRow(lead);
    const booking = ['Call Time (IST)', 'Booked At (IST)', 'Designation', 'Company', 'Website', 'Annual Revenue', 'Budget (3-6 Months)', 'Bottleneck', 'Tech Team', 'Timeline', 'Decision Maker', 'Booking Details', 'Booking UID', 'Last Event At'];
    for (const h of booking) expect(row[columnIndex(h)]).toBe('');
  });

  it('resolves column positions from the headers', () => {
    expect(columnIndex('Status')).toBe(4);
    expect(columnIndex('Booked At (IST)')).toBe(6);
    expect(columnIndex('Booking UID')).toBe(30);
    expect(() => columnIndex('Nope')).toThrow(/unknown sheet column/);
    expect(LAST_COLUMN_LETTER).toBe('AF');
  });

  it('converts indexes to A1 letters past Z', () => {
    expect([0, 4, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'E', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});
