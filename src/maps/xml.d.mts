export interface MapXmlElement {
  name: string;
  attributes: Record<string, string>;
}
export interface MapXmlParseOptions {
  signal?: AbortSignal;
  /** Borrowed text/workspace plus actual retained metadata, default 64 MiB.
   * Callers separately reserve encoded/text reads before decoding. */
  maxAllocationBytes?: number;
  /** Import-owned aggregate reservation before tokenizer copies/records. */
  reserve?: (bytes: number) => void;
}
/** Quote-aware MJCF metadata tokenizer; MuJoCo still owns schema validation. */
export function parseMapXml(text: string, label: string, options?: MapXmlParseOptions): MapXmlElement[];
export interface MapXmlReferenceOptions {
  signal?: AbortSignal;
  /** Unique expanded edges plus prepared directory/base context characters.
   * Default 16 Mi characters; checked before concatenation/normalization. */
  maxExpandedCharacters?: number;
  /** Import-owned aggregate reservation, called before new expanded ownership. */
  reserve?: (characters: number) => void;
}
/** Incremental deduplicated edges; caller retains root containment policy. */
export function mapXmlReferences(
  elements: readonly MapXmlElement[],
  base: string,
  inherited: Readonly<Record<string, string>>,
  options?: MapXmlReferenceOptions,
): IterableIterator<{ value: string; base: string }>;
