/** Source 10 Hz lightstyle patterns, from noclip.website WorldLightingState.ts
 * (Copyright 2018 Jasper St. Pierre, MIT; LICENSE.noclip). Shared by runtime atlas
 * updates and initial prop-cache sampling. A default is a pattern index, not gain. */
export interface SourceLightstyleDefinition { pattern: string | null; default: number; off: boolean }
const PATTERNS = [
  'm', 'mmnmmommommnonmmonqnmmo', 'abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba',
  'mmmmmaaaaammmmmaaaaaabcdefgabcdefg', 'mamamamamama', 'jklmnopqrstuvwxyzyxwvutsrqponmlkj',
  'nmonqnmomnmomomno', 'mmmaaaabcdefgmmmmaaaammmaamm',
  'mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa', 'aaaaaaaazzzzzzzz',
  'mmamammmmammamamaaamammma', 'abcdefghijklmnopqrrqponmlkjihgfedcba', 'mmnnmmnnnmmnn',
];
export function sourceLightstylePatterns(definitions: Readonly<Record<string, SourceLightstyleDefinition>>): string[] {
  const patterns = Array.from({ length: 256 }, (_, index) => PATTERNS[index] ?? 'm');
  for (const [style, definition] of Object.entries(definitions))
    patterns[Number(style)] = definition.off ? 'a' : definition.pattern || patterns[definition.default] || 'm';
  return patterns;
}
/** Tick is the already validated integer floor(seconds * 10). */
export function sourceLightstyleValue(pattern: string, tick: number): number {
  return (pattern.charCodeAt(tick % pattern.length) - 97) / 12;
}
