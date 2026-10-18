/** Source's flat diffuse lightmap path, ported from noclip.website:
 * Materials/Lightmap.ts (RGBM6), Material_Generic.ts (albedo * diffuse),
 * Main.ts (linear -> gamma 2.2). Copyright (c) 2018 Jasper St. Pierre, MIT;
 * see LICENSE.noclip. No additional studio / sun illumination is applied to baked surfaces. */
import * as THREE from "three";
import { sourceTextureControl,sourceTextureShader,SOURCE_TEXTURE_FALLBACK } from './source-textures';

export function sourceMaterial(original: THREE.MeshStandardMaterial, lightmap: THREE.Texture,
                               exposure: { value: number },linearOutput={value:0}): THREE.MeshBasicMaterial {
  lightmap.colorSpace = THREE.NoColorSpace;
  lightmap.channel = 1;
  lightmap.flipY = false;
  lightmap.wrapS = lightmap.wrapT = THREE.ClampToEdgeWrapping;
  lightmap.magFilter = lightmap.minFilter = THREE.LinearFilter;
  lightmap.generateMipmaps = false;
  lightmap.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    name: original.name, color: original.color, map: original.map,
    opacity: original.opacity, transparent: original.transparent, alphaTest: original.alphaTest,
    side: original.side, depthWrite: original.depthWrite,
    lightMap: lightmap, lightMapIntensity: Math.PI, toneMapped: false, fog: false,
  });
  sourceTextureControl(material);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sourceExposure = exposure;
    shader.uniforms.sourceLinearOutput=linearOutput;
    shader.fragmentShader = 'uniform float sourceExposure;uniform float sourceLinearOutput;\n' + shader.fragmentShader
      .replace('lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI',
               'lightMapTexel.rgb * lightMapTexel.a * 6.0 * sourceExposure')
      .replace('#include <colorspace_fragment>',
               'if(sourceLinearOutput<.5) gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));');
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>'+SOURCE_TEXTURE_FALLBACK);
    sourceTextureShader(material,shader);
  };
  material.customProgramCacheKey = () => 'source-rgbm6-gamma22-v2';
  return material;
}

/** Prop colors contain Source diffuse lighting in COLOR_0, normalized to a range of six.
 * Geometry and textures can be shared while each placed prop keeps its own baked lighting. */
export function sourceVertexMaterial(original: THREE.MeshStandardMaterial, scale: number,
                                     exposure: { value: number },linearOutput={value:0},keepTextureColor=false): THREE.MeshBasicMaterial {
  const unlit = original.userData.sourceUnlit === true;
  const selfIllum = original.userData.sourceSelfIllum === true;
  const material = new THREE.MeshBasicMaterial({
    name: original.name, color: original.color, map: original.map, vertexColors: !unlit,
    opacity: original.opacity, transparent: original.transparent, alphaTest: original.alphaTest,
    side: original.side, depthWrite: original.depthWrite, toneMapped: false, fog: false,
  });
  sourceTextureControl(material,keepTextureColor);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.sourceExposure = exposure;
    shader.uniforms.sourceLinearOutput=linearOutput;
    shader.uniforms.sourceVertexLightScale = { value: scale };
    const tint = original.userData.sourceSelfIllumTint as number[] | undefined;
    shader.uniforms.sourceSelfIllumTint = { value: new THREE.Vector3(...(tint?.length === 3 ? tint : [1, 1, 1]) as [number, number, number]) };
    shader.fragmentShader = 'uniform float sourceExposure;uniform float sourceLinearOutput; uniform float sourceVertexLightScale; uniform vec3 sourceSelfIllumTint;\n'
      + shader.fragmentShader.replace('vec3 outgoingLight = reflectedLight.indirectDiffuse;',
          `vec3 outgoingLight = reflectedLight.indirectDiffuse * ${unlit ? '1.0' : 'sourceVertexLightScale'} * sourceExposure;
          ${selfIllum ? `
            #ifdef USE_MAP
              outgoingLight = mix(outgoingLight, diffuse * sampledDiffuseColor.rgb * sourceSelfIllumTint * sourceExposure, sampledDiffuseColor.a);
            #endif
          ` : ''}`)
        .replace('#include <colorspace_fragment>',
          'if(sourceLinearOutput<.5) gl_FragColor.rgb = pow(max(gl_FragColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));');
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>'+SOURCE_TEXTURE_FALLBACK);
    sourceTextureShader(material,shader);
  };
  material.customProgramCacheKey = () => `source-vertex-lighting-v2-${unlit}-${selfIllum}`;
  original.vertexColors = false; // deliberate Studio / custom re-lighting uses the unlit albedo
  original.needsUpdate = true;
  return material;
}
