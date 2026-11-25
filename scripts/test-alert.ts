import { sendAlert } from '../lib/alert.js';

// Sends one clearly-labelled test alert with the ALERT_* variables of the environment (README "Failure alerts").
// Prints only the outcome, never the password. Usage: ALERT_SMTP_PASS=... npx tsx scripts/test-alert.ts

if (!process.env.ALERT_SMTP_PASS?.trim()) {
  console.error('Not sent: ALERT_SMTP_PASS is not set.');
  process.exit(1);
}

const sent = await sendAlert({
  event: 'ALERT_TEST',
  subject: 'TEST alert, nothing is wrong',
  summary: 'This is a test of the failure alerts, sent by scripts/test-alert.ts. Nothing failed; no action is needed.',
});

console.log(sent ? 'Sent: the mail server accepted the test alert.' : 'Not sent: see the ALERT_SEND_FAILED line above for the reason.');
process.exit(sent ? 0 : 1);
