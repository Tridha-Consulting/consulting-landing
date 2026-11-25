import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_DEADLINE_MS, MAX_BODY_BYTES, THROTTLE_MS, alertBody, alertInBackground, resetAlertThrottle, sendAlert } from '../lib/alert.js';
import { mail, sentMail } from './mail-fake.js';

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function logged(spy: { mock: { calls: unknown[][] } }, event: string): Record<string, unknown> | undefined {
  const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes(`"event":"${event}"`));
  return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
}

function configure(env: Record<string, string> = {}): void {
  vi.stubEnv('ALERT_SMTP_PASS', 'app-password-placeholder');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

const basic = { event: 'TEST_EVENT', subject: 'Something failed', error: 'boom', details: { a: 1 } };

beforeEach(() => {
  resetAlertThrottle();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('sendAlert, not configured', () => {
  it('without ALERT_SMTP_PASS creates no transport, sends nothing, does not throw, and logs ALERT_NOT_CONFIGURED', async () => {
    await expect(sendAlert(basic)).resolves.toBe(false);
    expect(mail.createTransport).not.toHaveBeenCalled();
    expect(mail.sendMail).not.toHaveBeenCalled();
    expect(logged(warnSpy, 'ALERT_NOT_CONFIGURED')).toEqual({ event: 'ALERT_NOT_CONFIGURED', alertEvent: 'TEST_EVENT' });
  });

  it('a whitespace-only password counts as not configured', async () => {
    vi.stubEnv('ALERT_SMTP_PASS', '   ');
    await sendAlert(basic);
    expect(mail.createTransport).not.toHaveBeenCalled();
  });

  it('reads the environment at call time, not at import', async () => {
    await sendAlert(basic);
    expect(mail.sendMail).not.toHaveBeenCalled();
    configure();
    await sendAlert(basic);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('sendAlert, configured', () => {
  it('sends plain text from the mailbox to itself by default, over implicit TLS on smtp.zoho.in', async () => {
    // The one test of the default host: setup points every other test at an unroutable address. The send goes
    // through the fake transport, so nothing reaches the real server.
    configure({ ALERT_SMTP_HOST: '' });
    await sendAlert(basic);
    expect(mail.createTransport).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    const options = mail.createTransport.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).toMatchObject({
      host: 'smtp.zoho.in',
      port: 465,
      secure: true,
      auth: { user: 'consulting@tridha.net', pass: 'app-password-placeholder' },
    });
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) expect(options[key], key).toBeLessThanOrEqual(ALERT_DEADLINE_MS);
    const [message] = sentMail();
    expect(message).toMatchObject({ from: 'consulting@tridha.net', to: 'consulting@tridha.net' });
    expect(message!.subject).toBe('[consulting.tridha.net] Something failed');
    expect(message!.html).toBeUndefined();
    expect(message!.text).toContain('TEST_EVENT');
    expect(message!.text).toContain('Error: boom');
    expect(message!.text).toMatch(/Time \(IST\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(message!.text).toContain('"a": 1');
    expect(mail.close).toHaveBeenCalled();
  });

  it('resolves true once the mail is accepted', async () => {
    configure();
    await expect(sendAlert(basic)).resolves.toBe(true);
  });

  it('honours ALERT_SMTP_USER, ALERT_TO (comma-separated) and ALERT_SMTP_HOST', async () => {
    configure({ ALERT_SMTP_USER: 'alerts@example.com', ALERT_TO: 'a@example.com, b@example.com', ALERT_SMTP_HOST: 'smtp.zoho.com' });
    await sendAlert(basic);
    expect(mail.createTransport.mock.calls[0]![0]).toMatchObject({ host: 'smtp.zoho.com', auth: { user: 'alerts@example.com' } });
    expect(sentMail()[0]).toMatchObject({ from: 'alerts@example.com', to: 'a@example.com, b@example.com' });
  });

  it('ALERT_TO defaults to ALERT_SMTP_USER', async () => {
    configure({ ALERT_SMTP_USER: 'alerts@example.com' });
    await sendAlert(basic);
    expect(sentMail()[0]!.to).toBe('alerts@example.com');
  });

  it('strips CR, LF and other control characters from a subject built from a name', async () => {
    configure();
    const name = 'Asha\r\nBcc: attacker@example.com\u0000' + String.fromCharCode(0x2028) + 'Rao';
    await sendAlert({ ...basic, subject: `Lead NOT saved: ${name} (Rao Textiles)` });
    const { subject } = sentMail()[0]!;
    expect(subject).not.toMatch(/[\r\n\u0000-\u001f]/);
    expect(subject).not.toContain(String.fromCharCode(0x2028));
    expect(subject).toBe('[consulting.tridha.net] Lead NOT saved: Asha Bcc: attacker@example.com Rao (Rao Textiles)');
  });

  it('caps the subject at 150 characters, prefix included', async () => {
    configure();
    await sendAlert({ ...basic, subject: 'x'.repeat(1000) });
    expect(sentMail()[0]!.subject).toHaveLength(150);
    expect(sentMail()[0]!.subject.startsWith('[consulting.tridha.net] ')).toBe(true);
  });

  it('never puts the password in the message or in any log', async () => {
    configure();
    await sendAlert(basic);
    expect(JSON.stringify(sentMail())).not.toContain('app-password-placeholder');
    expect(JSON.stringify([...errSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain('app-password-placeholder');
  });
});

describe('sendAlert, concurrent alerts', () => {
  it('five alerts started together all reach the transport, none the real module', async () => {
    configure();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => sendAlert({ ...basic, dedupeKey: `k${i}` })));
    expect(results).toEqual([true, true, true, true, true]);
    expect(mail.createTransport).toHaveBeenCalledTimes(5);
    expect(mail.sendMail).toHaveBeenCalledTimes(5);
    // setup.ts points the host at TEST-NET-1 unless a test asks for the default.
    for (const call of mail.createTransport.mock.calls) expect((call[0] as { host: string }).host).toBe('192.0.2.1');
  });

  it('a failed import is forgotten, so the next alert loads it again', async () => {
    vi.useFakeTimers();
    configure();
    vi.resetModules();
    let attempts = 0;
    vi.doMock('nodemailer', () => {
      attempts++;
      if (attempts === 1) throw new Error('cannot load');
      return { default: { createTransport: mail.createTransport }, createTransport: mail.createTransport };
    });
    try {
      const fresh = await import('../lib/alert.js');
      await expect(fresh.sendAlert(basic)).resolves.toBe(false);
      expect(logged(errSpy, 'ALERT_SEND_FAILED')).toMatchObject({ alertEvent: 'TEST_EVENT' });
      await expect(fresh.sendAlert(basic)).resolves.toBe(true);
    } finally {
      vi.doMock('nodemailer', async () => {
        const { mail: fake } = await import('./mail-fake.js');
        return { default: { createTransport: fake.createTransport }, createTransport: fake.createTransport };
      });
      vi.resetModules();
    }
  });
});

describe('sendAlert, failures', () => {
  it('a rejected sendMail does not throw and logs ALERT_SEND_FAILED', async () => {
    configure();
    mail.sendMail.mockRejectedValue(new Error('535 Authentication failed'));
    await expect(sendAlert(basic)).resolves.toBe(false);
    expect(logged(errSpy, 'ALERT_SEND_FAILED')).toEqual({ event: 'ALERT_SEND_FAILED', alertEvent: 'TEST_EVENT', error: '535 Authentication failed' });
  });

  it('a transport that cannot be created does not throw either', async () => {
    configure();
    mail.createTransport.mockImplementation(() => {
      throw new Error('bad options');
    });
    await expect(sendAlert(basic)).resolves.toBe(false);
    expect(logged(errSpy, 'ALERT_SEND_FAILED')).toMatchObject({ error: 'bad options' });
  });

  it('a details value that cannot be serialised does not throw and is noted in the body', async () => {
    configure();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(sendAlert({ ...basic, details: circular })).resolves.toBe(true);
    expect(sentMail()[0]!.text).toContain('details could not be serialised');
  });

  it('a hanging sendMail is abandoned at the deadline', async () => {
    vi.useFakeTimers();
    configure();
    mail.sendMail.mockReturnValue(new Promise(() => {}));
    let settled = false;
    const done = sendAlert(basic).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ALERT_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(settled).toBe(true);
    expect(ALERT_DEADLINE_MS).toBeLessThanOrEqual(6000);
    expect(logged(errSpy, 'ALERT_SEND_FAILED')).toMatchObject({ alertEvent: 'TEST_EVENT' });
    expect(String(logged(errSpy, 'ALERT_SEND_FAILED')!.error)).toMatch(/timed out/);
    expect(mail.close).toHaveBeenCalled();
  });

  it('a send that fails after the deadline is not an unhandled rejection', async () => {
    vi.useFakeTimers();
    configure();
    let fail!: (e: Error) => void;
    mail.sendMail.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    const done = sendAlert(basic);
    await vi.advanceTimersByTimeAsync(ALERT_DEADLINE_MS + 1);
    await done;
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('sendAlert, throttle', () => {
  it('skips a repeated dedupeKey inside ten minutes, logs ALERT_THROTTLED, and sends again after', async () => {
    vi.useFakeTimers();
    configure();
    const alert = { ...basic, dedupeKey: 'lead-1' };
    await sendAlert(alert);
    await sendAlert(alert);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(logged(warnSpy, 'ALERT_THROTTLED')).toEqual({ event: 'ALERT_THROTTLED', alertEvent: 'TEST_EVENT' });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS - 1000);
    await sendAlert(alert);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await sendAlert(alert);
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
  });

  it('a different dedupeKey, or the same key under another event, always sends', async () => {
    configure();
    await sendAlert({ ...basic, dedupeKey: 'lead-1' });
    await sendAlert({ ...basic, dedupeKey: 'lead-2' });
    await sendAlert({ ...basic, event: 'OTHER_EVENT', dedupeKey: 'lead-1' });
    expect(mail.sendMail).toHaveBeenCalledTimes(3);
  });

  it('an alert without a dedupeKey is never throttled', async () => {
    configure();
    await sendAlert(basic);
    await sendAlert(basic);
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
  });

  it('is not spent while alerts are not configured', async () => {
    await sendAlert({ ...basic, dedupeKey: 'k' });
    configure();
    await sendAlert({ ...basic, dedupeKey: 'k' });
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('alertBody', () => {
  it('truncates at 60 KB with a note, without splitting a multi-byte character', () => {
    const body = alertBody({ ...basic, details: { text: 'ह'.repeat(40_000) } });
    const note = '[truncated';
    expect(body).toContain(note);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES + 200);
    expect(body).not.toContain(String.fromCharCode(0xfffd));
    expect(body.startsWith('Something failed on consulting.tridha.net (TEST_EVENT).')).toBe(true);
  });

  it('leaves a body under the limit whole', () => {
    expect(alertBody({ ...basic, details: { text: 'a'.repeat(1000) } })).not.toContain('[truncated');
  });

  it('formats the time in IST', () => {
    expect(alertBody(basic, new Date('2026-11-25T18:45:09Z'))).toContain('Time (IST): 2026-11-26 00:15:09');
  });

  it('sends the whole truncated body through sendMail', async () => {
    configure();
    await sendAlert({ ...basic, details: { text: 'a'.repeat(100_000) } });
    const { text } = sentMail()[0]!;
    expect(text).toContain('[truncated');
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_BODY_BYTES + 200);
  });
});

describe('sendAlert, a failed send does not use up the throttle', () => {
  const keyed = { ...basic, dedupeKey: 'booking-1' };

  it('a rejected send leaves the key free, so a retry can alert', async () => {
    configure();
    mail.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(sendAlert(keyed)).resolves.toBe(false);
    await expect(sendAlert(keyed)).resolves.toBe(true);
    await expect(sendAlert(keyed)).resolves.toBe(false);
    expect(mail.sendMail).toHaveBeenCalledTimes(2);
  });

  it('a send that timed out leaves the key free too', async () => {
    vi.useFakeTimers();
    configure();
    mail.sendMail.mockReturnValueOnce(new Promise(() => {}));
    const first = sendAlert(keyed);
    await vi.advanceTimersByTimeAsync(ALERT_DEADLINE_MS + 1);
    await expect(first).resolves.toBe(false);
    await expect(sendAlert(keyed)).resolves.toBe(true);
  });

  it('a transport that cannot be created leaves the key free', async () => {
    configure();
    mail.createTransport.mockImplementationOnce(() => {
      throw new Error('bad options');
    });
    await expect(sendAlert(keyed)).resolves.toBe(false);
    await expect(sendAlert(keyed)).resolves.toBe(true);
  });
});

describe('sendAlert, window cap', () => {
  const capped = (n: number) => ({ ...basic, event: 'LEAD_SINK_MISCONFIGURED', dedupeKey: `lead-${n}` });

  it('sends at most five mails per ten minutes for a capped event, whatever the keys, the fifth saying so', async () => {
    vi.useFakeTimers();
    configure();
    for (let i = 0; i < 8; i++) await sendAlert(capped(i));
    expect(mail.sendMail).toHaveBeenCalledTimes(5);
    expect(sentMail().slice(0, 4).every((m) => !m.text.includes('suppressed'))).toBe(true);
    expect(sentMail()[4]!.text).toContain('Further alerts of this type are suppressed for 10 minutes; see the Vercel logs');
    expect(logged(warnSpy, 'ALERT_THROTTLED')).toMatchObject({ alertEvent: 'LEAD_SINK_MISCONFIGURED' });

    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    await sendAlert(capped(99));
    expect(mail.sendMail).toHaveBeenCalledTimes(6);
  });

  it('is per event: other events are not counted, and an uncapped event is never limited by the cap', async () => {
    configure();
    for (let i = 0; i < 5; i++) await sendAlert(capped(i));
    await sendAlert({ ...basic, event: 'LEAD_WRITE_FAILED', dedupeKey: 'a' });
    for (let i = 0; i < 8; i++) await sendAlert({ ...basic, event: 'LEAD_WRITE_FAILED', dedupeKey: `k${i}` });
    expect(mail.sendMail).toHaveBeenCalledTimes(5 + 9);
  });

  it('a failed send gives its slot back', async () => {
    configure();
    mail.sendMail.mockRejectedValue(new Error('smtp down'));
    for (let i = 0; i < 8; i++) await sendAlert(capped(i));
    expect(mail.sendMail).toHaveBeenCalledTimes(8);
    mail.sendMail.mockResolvedValue({ accepted: [] });
    for (let i = 10; i < 18; i++) await sendAlert(capped(i));
    expect(mail.sendMail).toHaveBeenCalledTimes(8 + 5);
  });
});

describe('sendAlert, time bound', () => {
  it('passes sendMail an abort signal that fires by the deadline, so an open connection is closed', async () => {
    configure();
    await sendAlert(basic);
    const { signal } = sentMail()[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it('the abort signal is the remainder of the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    configure();
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await sendAlert(basic);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBeLessThanOrEqual(ALERT_DEADLINE_MS);
    expect(spy.mock.calls[0]![0]).toBeGreaterThan(0);
  });

  it('loading nodemailer counts toward the deadline', async () => {
    vi.useFakeTimers();
    configure();
    vi.resetModules();
    vi.doMock('nodemailer', () => new Promise(() => {}));
    try {
      const fresh = await import('../lib/alert.js');
      let settled: boolean | undefined;
      const done = fresh.sendAlert(basic).then((sent) => {
        settled = sent;
      });
      await vi.advanceTimersByTimeAsync(ALERT_DEADLINE_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(settled).toBe(false);
      expect(String(logged(errSpy, 'ALERT_SEND_FAILED')!.error)).toMatch(/timed out/);
    } finally {
      vi.doMock('nodemailer', async () => {
        const { mail: fake } = await import('./mail-fake.js');
        return { default: { createTransport: fake.createTransport }, createTransport: fake.createTransport };
      });
      vi.resetModules();
    }
  });
});

describe('subject', () => {
  it('is cut by code point, never through a surrogate pair', async () => {
    configure();
    // The prefix is 24 characters; an emoji (two UTF-16 units) then sits across unit 150.
    const prefixLength = '[consulting.tridha.net] '.length;
    await sendAlert({ ...basic, subject: 'a'.repeat(150 - prefixLength - 1) + '\u{1F600}'.repeat(5) });
    const { subject } = sentMail()[0]!;
    expect(Array.from(subject)).toHaveLength(150);
    expect(subject.endsWith(String.fromCodePoint(0x1f600))).toBe(true);
    expect(subject).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    await sendAlert({ ...basic, subject: 'a'.repeat(150 - prefixLength - 1) + '\u{1F600}'.repeat(5) + 'tail' });
    const cut = sentMail()[1]!.subject;
    expect(Array.from(cut)).toHaveLength(150);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('alertInBackground', () => {
  it('returns at once, hands the send to waitUntil, and the mail goes out when it is awaited', async () => {
    configure();

    expect(alertInBackground(basic)).toBeUndefined();
    expect(mail.waitUntil).toHaveBeenCalledTimes(1);
    expect(mail.sendMail).not.toHaveBeenCalled();
    await mail.flush();
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('still sends when waitUntil throws (no request context), and never throws itself', async () => {
    configure();
    mail.waitUntil.mockImplementation(() => {
      throw new Error('no context');
    });

    expect(() => alertInBackground(basic)).not.toThrow();
    await vi.waitFor(() => expect(mail.sendMail).toHaveBeenCalledTimes(1));
  });

  it('a failing send is logged and never an unhandled rejection', async () => {
    configure();
    mail.sendMail.mockRejectedValue(new Error('smtp down'));

    alertInBackground(basic);
    await mail.flush();
    expect(logged(errSpy, 'ALERT_SEND_FAILED')).toMatchObject({ error: 'smtp down' });
  });
});
