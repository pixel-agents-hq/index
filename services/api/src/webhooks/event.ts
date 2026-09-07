/** Construct and runtime-check the exact versioned body sent to one subscription. */
import { layoutSchema, withFormats } from '@pixel-index/layout-core';
import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  SHARE_EVENT_SCHEMA_VERSION,
  SHARE_EVENT_TYPE,
  type ShareEventDataV1,
  type ShareEventV1,
  shareEventV1Schema,
} from './schema.js';

// The event schema's full-$id layout $ref only resolves when both schemas are
// registered in this Ajv instance. This deliberately mirrors layout-core's
// validator and schema.test.ts rather than compiling the event in isolation.
const ajv = withFormats(new Ajv2020({ allErrors: true, strict: false }));
ajv.addSchema(layoutSchema);
const validateShareEvent = ajv.compile<ShareEventV1>(shareEventV1Schema);

export function asShareEventData(value: unknown): ShareEventDataV1 {
  return value as ShareEventDataV1;
}

export function buildShareEvent(
  eventId: string,
  occurredAt: Date,
  subscriptionId: string,
  data: ShareEventDataV1,
): ShareEventV1 {
  const event: ShareEventV1 = {
    eventId,
    eventType: SHARE_EVENT_TYPE,
    schemaVersion: SHARE_EVENT_SCHEMA_VERSION,
    occurredAt: occurredAt.toISOString(),
    subscriptionId,
    data: { ...data, layout: data.layout },
  };
  if (!validateShareEvent(event)) {
    throw new Error(`Stored share event violates schema v1: ${ajv.errorsText(validateShareEvent.errors)}`);
  }
  return event;
}
