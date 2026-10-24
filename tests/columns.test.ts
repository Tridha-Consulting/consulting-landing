import { describe, expect, it } from 'vitest';
import { COLUMNS, HEADERS, formatIST, toRow, type LeadRow } from '../lib/columns.js';

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
    expect(COLUMNS).toHaveLength(18);
  });

  it('orders headers as specified', () => {
    expect(HEADERS).toEqual([
      'Submitted At (IST)', 'Full Name', 'Email', 'Phone', 'Status', 'UTM Source', 'UTM Medium',
      'UTM Campaign', 'UTM Content', 'UTM Term', 'fbclid', 'gclid', 'li_fat_id', 'Referrer',
      'Landing URL', 'User Agent', 'IP', 'Lead ID',
    ]);
  });

  it('maps values to the right columns, blank when absent', () => {
    expect(toRow(lead)).toEqual([
      '2026-10-25 00:15:09', 'Asha Rao', 'asha@example.com', '+919812345678', 'New', 'meta', '',
      'oct', '', '', '', 'G1', '', 'https://l.facebook.com/', 'https://consulting.tridha.net/',
      'UA/1.0', '203.0.113.9', '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('formats IST across a day boundary and zero-pads', () => {
    expect(formatIST(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01 05:30:00');
    expect(formatIST(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01 00:00:00');
  });
});
