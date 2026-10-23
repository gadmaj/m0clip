/** Intermediate shader outputs for diagnosis only; neither renderer's equations are replaced. */
module.exports = {
  normal: { app: 'sn * .5 + .5', native: 't_NormalWorld * .5 + .5' },
  'normal-flat': { app: 'sn * .5 + .5', native: 't_NormalWorld * .5 + .5', flatBump: true },
  reflection: { app: 'normalize(sourceEffectRotation * reflected) * .5 + .5', native: 'normalize(CalcReflection(t_NormalWorld, t_WorldDirectionToEye)) * .5 + .5' },
  eye: { app: '(sourceEffectRotation * eye) * .5 + .5', native: 't_WorldDirectionToEye * .5 + .5' },
  bump: { app: 'bump.rgb', native: 't_BumpmapSample.rgb * .5 + .5' },
  cube: { app: 'textureCube(sourceEffectCube, sourceEffectRotation * reflected).rgb', native: 'texture(SAMPLER_Cube(u_TextureEnvmap), CalcReflection(t_NormalWorld, t_WorldDirectionToEye)).rgb' },
};
