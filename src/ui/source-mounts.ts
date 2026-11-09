import type { SourceMount } from '../maps/raw-source-files';

/** UI validation only; the local worker independently validates every mounted path and body. */
function path(value: string): string {
  if (value.length > 4096) throw new Error('Selected path is too long. Choose a shallower game folder.');
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || value !== value.normalize('NFC') || /[:\u0000-\u001f\u007f]/.test(value)
    || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`Unsafe selected path: ${value}. Choose files under one game folder.`);
  return normalized.toLowerCase();
}

/** A file chooser supplies names, a folder chooser supplies complete root-relative paths. */
export function companionMounts(files: readonly File[]): SourceMount[] {
  if (files.length > 262144) throw new Error('Too many companion files. Choose only the required archives.');
  const selected = new Set<string>(), directories = new Set<string>();
  const ordered: { key: string; file: File; kind: 'zip' | 'gma' | 'vpk' }[] = [];
  const groups = new Map<string, { chunks: { index: number; blob: Blob }[]; indices: Set<number>; first: string }>();
  let pathChars = 0;
  for (const file of files) {
    const name = file.webkitRelativePath || file.name;
    if (name.length > 16 * 1024 * 1024 - pathChars) throw new Error('Companion path metadata is too large.');
    pathChars += name.length;
    const key = path(name);
    if (selected.has(key)) throw new Error(`Duplicate companion: ${key}. Select each archive once; add different folders separately.`);
    selected.add(key);
    if (/\.(zip|gma)$/.test(key)) ordered.push({ key, file, kind: key.endsWith('.gma') ? 'gma' : 'zip' });
    else if (key.endsWith('_dir.vpk')) {
      directories.add(key.slice(0, -7)); ordered.push({ key, file, kind: 'vpk' });
    } else {
      const match = /^(.*_)(\d{3,5})\.vpk$/.exec(key);
      if (!match) throw new Error(key.endsWith('.vpk')
        ? `Unmatched VPK: ${key}. Select its matching _dir.vpk and numbered chunks together.`
        : `Unsupported companion: ${key}. Choose ZIP, GMA or a VPK directory with its numbered chunks.`);
      const index = Number(match[2]);
      let group = groups.get(match[1]);
      if (!group) { group = { chunks: [], indices: new Set(), first: key }; groups.set(match[1], group); }
      if (index >= 0x7fff || group.indices.has(index))
        throw new Error(`Ambiguous VPK chunk: ${key}. Select one file for each numbered chunk.`);
      group.indices.add(index); group.chunks.push({ index, blob: file });
    }
    if (ordered.length > 126) throw new Error('Too many companion mounts. Remove unused mounts.');
  }
  for (const [prefix, group] of groups) if (!directories.has(prefix))
    throw new Error(`Unmatched VPK: ${group.first}. Select its matching _dir.vpk and numbered chunks together.`);
  return ordered.map(({ key, file, kind }): SourceMount => {
    if (kind !== 'vpk') return { kind, file, label: key };
    const chunks = groups.get(key.slice(0, -7))?.chunks ?? [];
    chunks.sort((a, b) => a.index - b.index);
    return { kind: 'vpk', directory: file, chunks, label: key };
  });
}

export function looseMount(files: readonly File[]): SourceMount {
  if (!files.length) throw new Error('The selected game folder is empty.');
  if (files.length > 262144) throw new Error('Too many game files. Choose a smaller game folder.');
  const first = files[0].webkitRelativePath;
  const root = first.slice(0, first.indexOf('/'));
  if (!root) throw new Error('Choose a game folder to preserve material and model paths.');
  const names = new Set<string>();
  let pathChars = 0;
  const entries = files.map(file => {
    if (!file.webkitRelativePath.startsWith(`${root}/`)) throw new Error('Choose one game folder at a time.');
    const value = file.webkitRelativePath.slice(root.length + 1);
    if (value.length > 16 * 1024 * 1024 - pathChars) throw new Error('Game-folder path metadata is too large.');
    pathChars += value.length;
    const relative = path(value);
    if (names.has(relative)) throw new Error(`Duplicate game path: ${relative}. Remove the case-conflicting file.`);
    names.add(relative);
    return { path: relative, blob: file };
  });
  return { kind: 'loose', label: root, files: entries };
}
