import { describe, expect, it } from 'vitest';

import { DESIGNER_CHANNEL, isDesignerCommand, isDesignerEvent } from './designerProtocol';

describe('designerProtocol', () => {
  it('accepts the page’s open command, and nothing off the channel', () => {
    expect(isDesignerCommand({ channel: DESIGNER_CHANNEL, type: 'open', profile: { body: 'flat' } })).toBe(true);
    expect(isDesignerCommand({ channel: DESIGNER_CHANNEL, type: 'open', profile: [] })).toBe(false);
    expect(isDesignerCommand({ channel: DESIGNER_CHANNEL, type: 'open' })).toBe(false);
    expect(isDesignerCommand({ channel: 'pixel-index-radio', type: 'open', profile: {} })).toBe(false);
  });

  it('accepts the frame’s events', () => {
    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'ready' })).toBe(true);
    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'close' })).toBe(true);
    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'selection', profile: null, customItems: [] })).toBe(true);
    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'selection', profile: { body: 'flat' }, customItems: ['custom_x'] })).toBe(true);

    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'selection', profile: {}, customItems: [1] })).toBe(false);
    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'selection', customItems: [] })).toBe(false);
    expect(isDesignerEvent({ channel: DESIGNER_CHANNEL, type: 'save' })).toBe(false);
  });
});
