import { describe, expect, it } from 'vitest';
import { BOTTLENECK_OPTIONS } from '../lib/schema.js';
import {
  COLUMNS,
  HEADERS,
  LAST_COLUMN_LETTER,
  MANUAL_HEADERS,
  SheetLayoutError,
  assertSheetLayout,
  columnIndex,
  columnLetter,
  formatIST,
  toRow,
  type LeadRow,
} from '../lib/columns.js';

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
    expect(COLUMNS).toHaveLength(40);
  });

  it('orders headers as specified', () => {
    expect(HEADERS).toEqual([
      'Submitted At (IST)', 'Full Name', 'Email', 'Phone', 'Status', 'Call Time (IST)', 'Booked At (IST)',
      'Designation', 'Company', 'Website', 'Annual Revenue', 'Budget (3-6 Months)', 'Bottleneck', 'Tech Team',
      'Timeline', 'Decision Maker', 'Booking Details', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Content',
      'UTM Term', 'fbclid', 'gclid', 'li_fat_id', 'Referrer', 'Landing URL', 'User Agent', 'IP', 'Lead ID',
      'Booking UID', 'Last Event At', 'Channel', 'twclid', 'gbraid', 'wbraid', 'Call Outcome', 'Qualified', 'Setter Notes', 'Deal Value (₹)',
    ]);
  });

  it('only ever appends: the first 32 headers are the layout the live sheet already holds', () => {
    expect(HEADERS.slice(0, 32).at(-1)).toBe('Last Event At');
    expect(HEADERS.slice(32)).toEqual(['Channel', 'twclid', 'gbraid', 'wbraid', ...MANUAL_HEADERS]);
  });

  it('maps values to the right columns, blank when absent', () => {
    expect(toRow(lead)).toEqual([
      '2026-10-25 00:15:09', 'Asha Rao', 'asha@example.com', '+919812345678', 'New', '', '',
      '', '', '', '', '', '', '', '', '', '',
      'meta', '', 'oct', '', '', '', 'G1', '', 'https://l.facebook.com/', 'https://consulting.tridha.net/',
      'UA/1.0', '203.0.113.9', '11111111-1111-4111-8111-111111111111', '', '',
      'Google Ads', '', '', '', '', '', '', '',
    ]);
  });

  it('places each qualification answer under its exact header, bottleneck joined in option order', () => {
    const row = toRow({
      ...lead,
      designation: 'Founder',
      company: 'Rao Textiles',
      website: 'raotextiles.in',
      revenue: '₹5 Crores – ₹20 Crores',
      budget: '₹15 Lakhs – ₹50 Lakhs',
      // ticked in reverse: the cell still follows BOTTLENECK_OPTIONS
      bottleneck: [BOTTLENECK_OPTIONS[3], BOTTLENECK_OPTIONS[0]],
      techTeam: 'Yes, but they lack AI expertise/are overwhelmed.',
      timeline: 'Within the next 2-3 months',
      decisionMaker: 'No',
    });
    const at = (h: string) => row[columnIndex(h)];
    expect(at('Designation')).toBe('Founder');
    expect(at('Company')).toBe('Rao Textiles');
    expect(at('Website')).toBe('raotextiles.in');
    expect(at('Annual Revenue')).toBe('₹5 Crores – ₹20 Crores');
    expect(at('Budget (3-6 Months)')).toBe('₹15 Lakhs – ₹50 Lakhs');
    expect(at('Bottleneck')).toBe(`${BOTTLENECK_OPTIONS[0]}; ${BOTTLENECK_OPTIONS[3]}`);
    expect(at('Tech Team')).toBe('Yes, but they lack AI expertise/are overwhelmed.');
    expect(at('Timeline')).toBe('Within the next 2-3 months');
    expect(at('Decision Maker')).toBe('No');
    // everything else is unchanged by the answers
    expect(at('Status')).toBe('New');
    expect(at('Booking Details')).toBe('');
    expect(at('Lead ID')).toBe(lead.leadId);
    expect(row).toHaveLength(40);
  });

  it('puts gbraid and wbraid right after twclid and before the team columns, and writes them', () => {
    expect(columnIndex('gbraid')).toBe(columnIndex('twclid') + 1);
    expect(columnIndex('wbraid')).toBe(columnIndex('twclid') + 2);
    expect(columnIndex('Call Outcome')).toBe(columnIndex('wbraid') + 1);
    const row = toRow({ ...lead, gclid: undefined, gbraid: 'GB1', wbraid: 'WB1' });
    expect(row[columnIndex('gbraid')]).toBe('GB1');
    expect(row[columnIndex('wbraid')]).toBe('WB1');
    expect(row[columnIndex('Channel')]).toBe('Google Ads');
    expect(toRow(lead)[columnIndex('gbraid')]).toBe('');
  });

  it('writes the click id and the classified channel, and the four team columns blank', () => {
    const row = toRow({ ...lead, gclid: undefined, twclid: 'TW1', utmSource: undefined, referrer: undefined });
    expect(row[columnIndex('twclid')]).toBe('TW1');
    expect(row[columnIndex('Channel')]).toBe('X Ads');
    for (const h of MANUAL_HEADERS) expect(row[columnIndex(h)]).toBe('');
  });

  it('keeps the four team columns last, after every column the code fills', () => {
    expect(MANUAL_HEADERS).toEqual(['Call Outcome', 'Qualified', 'Setter Notes', 'Deal Value (₹)']);
    expect(HEADERS.slice(-4)).toEqual([...MANUAL_HEADERS]);
  });

  it('joins a single bottleneck without a separator', () => {
    expect(toRow({ ...lead, bottleneck: [BOTTLENECK_OPTIONS[2]] })[columnIndex('Bottleneck')]).toBe(BOTTLENECK_OPTIONS[2]);
  });

  it('formats IST across a day boundary and zero-pads', () => {
    expect(formatIST(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01 05:30:00');
    expect(formatIST(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01 00:00:00');
  });

  it('leaves every booking column blank for a fresh lead', () => {
    const row = toRow(lead);
    const booking = ['Call Time (IST)', 'Booked At (IST)', 'Booking Details', 'Booking UID', 'Last Event At'];
    for (const h of booking) expect(row[columnIndex(h)]).toBe('');
  });

  it('leaves the answer columns blank for a lead without answers (a booking made without the site form)', () => {
    const row = toRow(lead);
    const answers = ['Designation', 'Company', 'Website', 'Annual Revenue', 'Budget (3-6 Months)', 'Bottleneck', 'Tech Team', 'Timeline', 'Decision Maker'];
    for (const h of answers) expect(row[columnIndex(h)]).toBe('');
  });

  it('resolves column positions from the headers', () => {
    expect(columnIndex('Status')).toBe(4);
    expect(columnIndex('Booked At (IST)')).toBe(6);
    expect(columnIndex('Booking UID')).toBe(30);
    expect(columnIndex('Channel')).toBe(32);
    expect(() => columnIndex('Nope')).toThrow(/unknown sheet column/);
    expect(LAST_COLUMN_LETTER).toBe('AN');
  });

  it('converts indexes to A1 letters past Z', () => {
    expect([0, 4, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'E', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('assertSheetLayout', () => {
  it('accepts exactly our headers, with stray spaces in the cells', () => {
    expect(() => assertSheetLayout(HEADERS)).not.toThrow();
    expect(() => assertSheetLayout(HEADERS.map((h) => ` ${h} `))).not.toThrow();
  });

  it('accepts extra columns after the last of ours, named or empty', () => {
    expect(() => assertSheetLayout([...HEADERS, 'Follow-up date'])).not.toThrow();
    expect(() => assertSheetLayout([...HEADERS, '', 'Another', ''])).not.toThrow();
    expect(() => assertSheetLayout([...HEADERS, '', ''])).not.toThrow();
  });

  it('refuses a column inserted in the middle, whatever it is called', () => {
    for (const at of [0, 5, 20, HEADERS.length - 1]) {
      const row = [...HEADERS.slice(0, at), 'Inserted', ...HEADERS.slice(at)];
      expect(() => assertSheetLayout(row), `insert at ${at}`).toThrow(SheetLayoutError);
    }
    // An insert whose text equals a header of ours is still a shift.
    expect(() => assertSheetLayout([...HEADERS.slice(0, 3), 'Status', ...HEADERS.slice(3)])).toThrow(SheetLayoutError);
  });

  it('names the first position that differs', () => {
    const row = [...HEADERS.slice(0, 5), 'Inserted', ...HEADERS.slice(5)];
    expect(() => assertSheetLayout(row)).toThrow(/column F \(position 6\): expected "Call Time \(IST\)", found \(other text, 8 characters\)/);
  });

  it('refuses a missing column, at the end or in the middle', () => {
    expect(() => assertSheetLayout(HEADERS.slice(0, -1))).toThrow(/column AN \(position 40\): expected "Deal Value \(\u20B9\)", found \(empty\)/);
    expect(() => assertSheetLayout(HEADERS.slice(0, 32))).toThrow(/position 33\): expected "Channel"/);
    expect(() => assertSheetLayout([...HEADERS.slice(0, 7), ...HEADERS.slice(8)])).toThrow(SheetLayoutError);
  });

  it('refuses a renamed or reordered column', () => {
    const renamed = [...HEADERS];
    renamed[8] = 'Compnay';
    expect(() => assertSheetLayout(renamed)).toThrow(SheetLayoutError);
    const swapped = [...HEADERS];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(() => assertSheetLayout(swapped)).toThrow(SheetLayoutError);
  });

  it('refuses a missing or empty header row', () => {
    expect(() => assertSheetLayout(undefined)).toThrow(/no header row/);
    expect(() => assertSheetLayout([])).toThrow(/no header row/);
  });

  it('never quotes text that is not one of our headers', () => {
    const row = [...HEADERS];
    row[3] = 'asha@example.com';
    try {
      assertSheetLayout(row);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain('asha@example.com');
    }
  });
});
