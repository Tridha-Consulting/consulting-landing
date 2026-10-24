import { sheetsSink } from './sheets.js';
import type { LeadSink } from './types.js';

export type { LeadSink } from './types.js';

/** Active sinks, written in order. Add a CRM by adding one file and one entry here. */
export const sinks: LeadSink[] = [sheetsSink];
