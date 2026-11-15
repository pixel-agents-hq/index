import { isSeedCode } from '@pixel-index/pixatar';
import { describe, expect, it } from 'vitest';

import { defaultAvatarSeed } from '../avatars/defaults.js';
import type { Layout, User } from '../db/schema.js';
import { toDetail, toSummary } from './serialize.js';

function makeLayout(overrides: Partial<Layout> = {}): Layout {
  const raw = '{"version":1,"cols":10,"rows":10}';
  return {
    id: 'layout-id',
    slug: 'a-layout',
    title: 'A Layout',
    description: 'a description',
    authorUserId: 'author-id',
    authorDisplay: null,
    raw,
    layout: JSON.parse(raw),
    sha256: 'a'.repeat(64),
    cols: 10,
    rows: 10,
    visibleCols: 10,
    visibleRows: 10,
    furnitureCount: 3,
    areaCount: 1,
    petCount: 0,
    carpetCount: 2,
    seatCount: 4,
    layoutRevision: 1,
    pixelAgentsVersion: '1.4.0',
    visibility: 'public',
    visibilityReason: null,
    visibilityChangedAt: null,
    visibilityChangedBy: null,
    searchVector: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'author-id',
    discordId: '123',
    username: 'someone',
    globalName: null,
    guildNickname: null,
    avatarUrl: 'https://cdn.discordapp.com/avatars/123/abc.png',
    avatarSeed: 'px.stored-seed',
    role: 'user',
    isSystem: false,
    discordGuildMember: null,
    discordMembershipCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('toSummary — author mapping', () => {
  it('a real user is exposed with their Discord id, not the internal UUID (#61)', () => {
    const summary = toSummary(makeLayout(), makeUser(), []);
    expect(summary.author).toEqual({
      discordId: '123',
      username: 'someone',
      displayName: 'someone',
      avatarUrl: 'https://cdn.discordapp.com/avatars/123/abc.png',
      avatarSeed: 'px.stored-seed',
    });
  });

  it('authorDisplay remains a fallback for legacy system-owned layouts', () => {
    // The system user's id (#3) is an implementation detail — a seed layout
    // is credited to a person, not to the account that technically owns the row.
    // The system user never has a discordId either, so this stays null.
    const summary = toSummary(
      makeLayout({ authorDisplay: 'legacy-credit' }),
      makeUser({ isSystem: true, discordId: null }),
      [],
    );
    expect(summary.author).toEqual({
      discordId: null,
      username: 'legacy-credit',
      displayName: 'legacy-credit',
      avatarUrl: null,
      // No account behind a legacy credit, so no stored default either: not
      // the system user's, which every legacy credit would then share.
      avatarSeed: null,
    });
  });

  it('falls back to "unknown" if somehow there is no author row and no display name', () => {
    const summary = toSummary(makeLayout(), null, []);
    expect(summary.author.username).toBe('unknown');
    expect(summary.author.discordId).toBeNull();
    expect(summary.author.avatarSeed).toBeNull();
  });
});

describe('toSummary — default avatars (#133)', () => {
  it('keeps a provided avatar, and still gives the stored default seed beside it', () => {
    const { author } = toSummary(makeLayout(), makeUser(), []);
    expect(author.avatarUrl).toBe('https://cdn.discordapp.com/avatars/123/abc.png');
    expect(author.avatarSeed).toBe('px.stored-seed');
  });

  it('gives an author without a picture their stored seed, never one dealt from their name', () => {
    const { author } = toSummary(makeLayout(), makeUser({ avatarUrl: null, avatarSeed: 'px.mine' }), []);
    expect(author.avatarUrl).toBeNull();
    expect(author.avatarSeed).toBe('px.mine');
    // Renaming the account changes nothing about the avatar.
    const renamed = toSummary(makeLayout(), makeUser({ avatarUrl: null, avatarSeed: 'px.mine', username: 'new' }), []);
    expect(renamed.author.avatarSeed).toBe('px.mine');
  });

  it('deals the same seed the backfill would for a row that has none yet', () => {
    const { author } = toSummary(makeLayout(), makeUser({ avatarSeed: null }), []);
    expect(author.avatarSeed).toBe(defaultAvatarSeed('author-id'));
    expect(isSeedCode(author.avatarSeed ?? '')).toBe(true);
  });
});

describe('toSummary — fields', () => {
  it('maps every stat column to its public name', () => {
    const summary = toSummary(makeLayout(), makeUser(), ['cosy', 'small']);
    expect(summary).toMatchObject({
      slug: 'a-layout',
      title: 'A Layout',
      description: 'a description',
      tags: ['cosy', 'small'],
      cols: 10,
      rows: 10,
      visibleCols: 10,
      visibleRows: 10,
      furniture: 3,
      areas: 1,
      pets: 0,
      carpets: 2,
      seats: 4,
      layoutRevision: 1,
      pixelAgentsVersion: '1.4.0',
      sha256: 'a'.repeat(64),
    });
  });

  it('bytes is the UTF-8 byte length of raw, not the parsed object', () => {
    const raw = '{"a":"café"}'; // multi-byte character
    const summary = toSummary(makeLayout({ raw, layout: JSON.parse(raw) }), makeUser(), []);
    expect(summary.bytes).toBe(Buffer.byteLength(raw, 'utf-8'));
    expect(summary.bytes).not.toBe(raw.length); // would differ if this ever regresses to .length
  });

  it('timestamps are ISO strings', () => {
    const summary = toSummary(makeLayout(), makeUser(), []);
    expect(summary.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(summary.updatedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('files are relative API paths keyed on the slug', () => {
    const summary = toSummary(makeLayout({ slug: 'my-office' }), makeUser(), []);
    expect(summary.files).toEqual({
      layout: '/api/v1/layouts/my-office/download',
      preview: '/api/v1/layouts/my-office/preview.png',
      thumbnail: '/api/v1/layouts/my-office/thumbnail.png',
    });
  });
});

describe('toDetail', () => {
  it('includes everything toSummary has, plus the parsed layout', () => {
    const layout = makeLayout();
    const detail = toDetail(layout, makeUser(), []);
    expect(detail).toMatchObject(toSummary(layout, makeUser(), []));
    expect(detail.layout).toEqual(layout.layout);
  });
});
