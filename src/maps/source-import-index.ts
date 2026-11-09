/** Worker-only index/header operations, deliberately independent of assembly. */
import { canonicalSourcePath, defaultSourceFileSystemLimits, SourceFileSystem, type SourceMount } from './raw-source-files';
import type { SourceFormat, SourceImportChoice, SourceInspection } from './source-import-protocol';

export async function checkSourceBspHeader(file: Blob): Promise<void> {
  if (file.size < 1036) throw new Error('Truncated VBSP header: select a complete Source BSP.');
  const header = new DataView(await file.slice(0, 1036).arrayBuffer());
  if (header.getUint32(0, true) !== 0x50534256) throw new Error('Not a Source VBSP file.');
  const version = header.getInt32(4, true);
  if (version < 19 || version > 22) throw new Error(`Unsupported VBSP version ${version}; supported versions are 19–22.`);
}

export async function inspectSourceFile(file: File): Promise<SourceInspection> {
  // Converted .map.zip is exclusively handled by the existing bundle consumer.
  if (/\.map\.zip$/i.test(file.name)) throw new Error('Use converted map intake for .map.zip files; a damaged converted bundle is not a raw Source archive.');
  const extension = file.name.match(/\.(bsp|gma|zip)$/i)?.[1]?.toLowerCase() as SourceFormat | undefined;
  let format = extension;
  if (!format) {
    const header = new DataView(await file.slice(0, 4).arrayBuffer());
    if (header.byteLength === 4 && header.getUint32(0, true) === 0x50534256) format = 'bsp';
    else if (header.byteLength === 4 && header.getUint32(0, true) === 0x44414d47) format = 'gma';
    else if (header.byteLength === 4 && [0x04034b50, 0x06054b50].includes(header.getUint32(0, true))) format = 'zip';
  }
  if (!format) throw new Error('Select a Source BSP, GMA or ZIP archive.');
  const name = (file.name.replace(/\.(bsp|gma|zip)$/i, '').trim() || 'Local Source map').slice(0, 256);
  const game = format === 'gma' ? 'Garry’s Mod' : 'Source';
  if (format === 'bsp') {
    await checkSourceBspHeader(file);
    return { kind: 'source', format, name, game, maps: [{ path: canonicalSourcePath(/\.bsp$/i.test(file.name) ? file.name : `${file.name}.bsp`), bytes: file.size }] };
  }
  const filesystem = await SourceFileSystem.create([{ kind: format, file, label: file.name }]);
  return { kind: 'source', format, name, game,
    maps: filesystem.mapCandidates.map(map => ({ path: map.path, bytes: map.bytes })) };
}

export async function selectedSourceBsp(choice: SourceImportChoice): Promise<{ file: Blob; mapName: string; mounts: readonly SourceMount[] }> {
  if (/\.map\.zip$/i.test(choice.file.name)) throw new Error('Converted .map.zip files must use the converted map decoder.');
  const path = canonicalSourcePath(choice.mapPath);
  if (path !== choice.mapPath || !path.endsWith('.bsp')) throw new Error('Select an exact BSP path from the current archive.');
  const mapName = path.slice(path.lastIndexOf('/') + 1, -4);
  if (!/^[a-z\d_-]{1,128}$/i.test(mapName)) throw new Error('The selected BSP filename is not a supported Source map stem.');
  if (choice.format === 'bsp') {
    if (path !== canonicalSourcePath(/\.bsp$/i.test(choice.file.name) ? choice.file.name : `${choice.file.name}.bsp`)) throw new Error('The selected BSP path does not match this file.');
    await checkSourceBspHeader(choice.file);
    return { file: choice.file, mapName, mounts: choice.mounts };
  }
  const archive: SourceMount = { kind: choice.format, file: choice.file, label: choice.file.name };
  // This filesystem performs exactly one read: the chosen BSP, under the default
  // limits, so a compressed member keeps its decompression working-memory bound.
  // Only a stored slice (GMA, VPK, stored ZIP) can exceed the per-member limit; it
  // allocates nothing, so like a directly selected BSP the total is lifted just for it
  // (readSourceBsp bounds each lump). readFile still refuses a compressed member above it.
  const limits = defaultSourceFileSystemLimits;
  let filesystem = await SourceFileSystem.create([archive]);
  if (!filesystem.mapCandidates.length) throw new Error('This archive contains no Source BSP maps.');
  const candidate = filesystem.mapCandidates.find(map => map.path === path);
  if (!candidate) throw new Error('The selected BSP is not in this archive. Select a listed map explicitly.');
  if (candidate.bytes > limits.maxResourceBytes) filesystem = await SourceFileSystem.create([archive], undefined, { maxTotalResourceBytes: Math.max(limits.maxTotalResourceBytes, 2 * candidate.bytes) });
  const file = await filesystem.readFile(path, undefined, candidate.bytes);
  if (!file) throw new Error('The selected BSP is unavailable in this archive.');
  await checkSourceBspHeader(file);
  // The assembler prepends the chosen BSP pak. Archive beats explicit companions.
  return { file, mapName, mounts: [archive, ...choice.mounts] };
}
