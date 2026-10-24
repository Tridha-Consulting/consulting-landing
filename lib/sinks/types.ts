import type { LeadRow } from '../columns.js';

export interface LeadSink {
  name: string;
  write(lead: LeadRow): Promise<void>;
}
