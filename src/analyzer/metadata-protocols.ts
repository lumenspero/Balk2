/**
 * A `Reflect` metadata convention. `defines` names the call that stores metadata on a target;
 * `reads` names the call that reads it. A protocol matches only when its metadata key is a
 * configured constant, so an unrelated `Reflect.getMetadata` with another key is ignored.
 */
export interface MetadataProtocol {
  /** The metadata key, as the string passed to `Reflect`. Matched exactly. */
  readonly key: string;
  /** Whether this key is written to targets (`Reflect.defineMetadata` and its variants) */
  readonly defines?: boolean;
  /** Whether this key is read from targets (`Reflect.getMetadata` and its variants) */
  readonly reads?: boolean;
}

/** The `Reflect` method lists live in the metadata engine; re-exported for existing importers. */
export { METADATA_DEFINE_METHODS, METADATA_READ_METHODS } from '../facts/metadata-engine.js';
