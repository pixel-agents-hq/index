export type PixatarErrorCode =
  /** A seed starting with the seed prefix that isn't a seed. */
  | 'invalid-seed'
  /** A profile Pixel Agents wouldn't read. */
  | 'invalid-profile'
  /** A seed naming a part this wardrobe doesn't have (made by a version with more parts). */
  | 'unknown-part';

export class PixatarError extends Error {
  readonly code: PixatarErrorCode;

  constructor(code: PixatarErrorCode, message: string) {
    super(message);
    this.name = 'PixatarError';
    this.code = code;
  }
}
