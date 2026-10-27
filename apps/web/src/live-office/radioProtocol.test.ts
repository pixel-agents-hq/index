import { describe, expect, it } from 'vitest';

import { isRadioCommand, isRadioEvent, RADIO_CHANNEL } from './radioProtocol';

describe('radioProtocol', () => {
  it('accepts the page’s commands and nothing off the channel', () => {
    expect(isRadioCommand({ channel: RADIO_CHANNEL, type: 'describe', codes: ['TOWN-5-8F3A21C0'] })).toBe(true);
    expect(isRadioCommand({ channel: RADIO_CHANNEL, type: 'play', code: 'TOWN-5-8F3A21C0' })).toBe(true);
    expect(isRadioCommand({ channel: RADIO_CHANNEL, type: 'pause' })).toBe(true);

    expect(isRadioCommand({ channel: 'pixel-index-live-office', type: 'pause' })).toBe(false);
    expect(isRadioCommand({ channel: RADIO_CHANNEL, type: 'describe', codes: [1] })).toBe(false);
    expect(isRadioCommand({ channel: RADIO_CHANNEL, type: 'play' })).toBe(false);
    expect(isRadioCommand({ channel: RADIO_CHANNEL, type: 'skip' })).toBe(false);
    expect(isRadioCommand(null)).toBe(false);
  });

  it('accepts the frame’s events', () => {
    expect(isRadioEvent({ channel: RADIO_CHANNEL, type: 'ready' })).toBe(true);
    expect(isRadioEvent({ channel: RADIO_CHANNEL, type: 'described', tunes: {}, invalid: ['JAZZ-1-0'] })).toBe(true);
    expect(isRadioEvent({ channel: RADIO_CHANNEL, type: 'described', tunes: {}, invalid: [1] })).toBe(false);
    expect(isRadioEvent({ channel: RADIO_CHANNEL, type: 'state', code: null, playing: false, blocked: false })).toBe(true);

    expect(isRadioEvent({ channel: RADIO_CHANNEL, type: 'state', playing: 'yes', blocked: false })).toBe(false);
    expect(isRadioEvent({ channel: RADIO_CHANNEL, type: 'described' })).toBe(false);
    expect(isRadioEvent({ type: 'ready' })).toBe(false);
  });
});
