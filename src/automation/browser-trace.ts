import {z} from 'zod';
/** Safe structural events. Rich target labels and typed values remain ephemeral. */
export const TraceEvent=z.object({
  version:z.literal(1),sequence:z.number().int().positive(),at:z.number().int().nonnegative(),
  phase:z.enum(['decision','dispatch','action','effect','field','recovery','terminal']),
  requestId:z.string().uuid().optional(),operationId:z.string().uuid().optional(),
  operation:z.string().regex(/^[A-Z_]{1,32}$/).optional(),
  model:z.string().max(200).optional(),elapsedMs:z.number().nonnegative().optional(),
  outcome:z.enum(['confirmed','unknown','not_executed']).optional(),
  targetRef:z.string().max(100).optional(),
  cause:z.string().regex(/^[A-Z][A-Z_0-9]{2,80}$/).optional(),
  reason:z.string().regex(/^[A-Z][A-Z_0-9]{2,80}$/).optional(),
  status:z.enum(['succeeded','blocked','cancelled','failed','needs_verification']).optional(),
  steps:z.number().int().nonnegative().optional(),evaluations:z.number().int().nonnegative().optional(),
  staleRetries:z.number().int().nonnegative().optional(),consecutiveStale:z.number().int().nonnegative().optional(),
  effect:z.enum(['value-changed','selection-changed','expanded-changed']).optional(),
  pageChanged:z.boolean().optional(),valueMatched:z.boolean().optional(),optionCount:z.number().int().nonnegative().optional(),
  recoveryCalls:z.number().int().nonnegative().optional(),fieldsUpdated:z.number().int().nonnegative().optional(),
  effectObserved:z.boolean().optional(),verified:z.boolean().optional(),
}).strict();
export type BrowserTraceEvent=z.infer<typeof TraceEvent>;
export type BrowserTrace={version:1;events:BrowserTraceEvent[];truncated:boolean;sinkFailed:boolean};
