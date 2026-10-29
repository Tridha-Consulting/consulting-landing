import { HEADERS } from '../lib/columns.js';
import { EVENT_HEADERS } from '../lib/event-log.js';

// Tab-separated so each line pastes across cells in Google Sheets: paste the line under a label into A1 of that tab.
console.log('Leads tab (SHEET_TAB, default "Leads"), paste into A1:');
console.log(HEADERS.join('\t'));
console.log('');
console.log('Events tab (EVENTS_TAB, default "Events"), paste into A1:');
console.log(EVENT_HEADERS.join('\t'));
