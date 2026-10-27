/** Portable viewport choices; no renderer dependency. */
export interface SceneDisplay {
  textures: boolean;
  wireframe: boolean;
  characterWireframe?: boolean;
  map: boolean;
  robot: boolean;
  decals?: boolean;
}

export const DEFAULT_DISPLAY: Readonly<Required<SceneDisplay>> = Object.freeze({
  textures: true, wireframe: false, characterWireframe: false, map: true, robot: true, decals: true,
});

/** Legacy views predate independent character wireframe and decal visibility. */
export function validDisplay(value: unknown): value is SceneDisplay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const display = value as Record<string, unknown>;
  return ['textures', 'wireframe', 'map', 'robot'].every(key => typeof display[key] === 'boolean')
    && ['characterWireframe', 'decals'].every(key => display[key] === undefined || typeof display[key] === 'boolean');
}

export function normalizeDisplay(display: SceneDisplay = DEFAULT_DISPLAY): Required<SceneDisplay> {
  return {
    textures: display.textures, wireframe: display.wireframe,
    characterWireframe: display.characterWireframe ?? display.wireframe,
    map: display.map, robot: display.robot, decals: display.decals ?? true,
  };
}
