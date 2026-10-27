export interface MapXmlElement {
  name: string;
  attributes: Record<string, string>;
}
/** Quote-aware MJCF metadata tokenizer; MuJoCo still owns schema validation. */
export function parseMapXml(text: string, label: string): MapXmlElement[];
/** Raw references paired with the XML-relative or map-root resolution base. */
export function mapXmlReferences(
  elements: readonly MapXmlElement[],
  base: string,
  inherited: Readonly<Record<string, string>>,
): Array<{ value: string; base: string }>;
