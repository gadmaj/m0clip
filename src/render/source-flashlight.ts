/** Camera flashlight adapted from noclip.website SourceEngine/Main.ts and
 * Materials/Material_Generic.ts. Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
import * as THREE from 'three';

export class SourceFlashlight {
  readonly exposure = { value: 1 };
  private enabled = { value: 0 };
  private matrix = { value: new THREE.Matrix4() };
  private position = { value: new THREE.Vector3() };
  private cookie = { value: new THREE.Texture() };
  private projector = new THREE.PerspectiveCamera(90, 1, 5 * 0.0254, 1000 * 0.0254);
  private angle = new THREE.Quaternion();
  private depthMaterials = new WeakMap<THREE.Material, THREE.MeshDepthMaterial>();
  private target = new THREE.WebGLRenderTarget(512, 512, {
    depthTexture: new THREE.DepthTexture(512, 512, THREE.UnsignedIntType),
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private patched = new WeakSet<THREE.Material>();
  private previous = performance.now();
  private reset = true;
  private ready = false;
  on = false;

  constructor() {
    new THREE.TextureLoader().load('/assets/source/flashlight.png', (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      this.cookie.value = texture;
      this.ready = true;
    }, undefined, (e) => console.warn('Source flashlight texture could not be loaded; re-run the Source map importer.', e));
  }

  set(on: boolean) { this.on = on; this.reset = true; }

  withoutLight(draw: () => void) {
    const previous = this.enabled.value;
    this.enabled.value = 0;
    try { draw(); } finally { this.enabled.value = previous; }
  }

  renderDepth(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.enabled.value = this.on && this.ready ? 1 : 0;
    const now = performance.now(), dt = Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;
    if (!this.enabled.value) return;
    camera.updateMatrixWorld();
    const orientation = camera.getWorldQuaternion(new THREE.Quaternion());
    if (this.reset) { this.angle.copy(orientation); this.reset = false; }
    else this.angle.slerp(orientation, Math.min(1, dt * 10));
    this.projector.quaternion.copy(this.angle);
    camera.getWorldPosition(this.projector.position);
    this.projector.position.add(new THREE.Vector3(0, 0, -10 * 0.0254).applyQuaternion(this.angle));
    this.projector.updateMatrixWorld();
    this.position.value.copy(this.projector.position);
    this.matrix.value.set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1)
      .multiply(this.projector.projectionMatrix).multiply(this.projector.matrixWorldInverse);
    const hidden: THREE.Object3D[] = [];
    scene.traverse(o => { if (o.visible && (o.userData.sourceSky || o.userData.sourceSprite || o.userData.sourceOverlay)) { o.visible = false; hidden.push(o); } });
    const swapped: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const originals = [object.material].flat();
      if (originals.every(m => m.transparent && m.alphaTest === 0)) { object.visible = false; hidden.push(object); return; }
      const depths = originals.map(m => {
        let depth = this.depthMaterials.get(m);
        if (!depth) {
          depth = new THREE.MeshDepthMaterial({ side: m.side, alphaTest: m.alphaTest });
          this.depthMaterials.set(m, depth);
          const owned = depth; m.addEventListener('dispose', () => owned.dispose());
        }
        const map = (m as THREE.MeshBasicMaterial).map ?? null;
        if (!!depth.map !== !!map) depth.needsUpdate = true;
        depth.map = map;
        return depth;
      });
      swapped.push({ mesh: object, material: object.material });
      object.material = Array.isArray(object.material) ? depths : depths[0];
    });
    const target = renderer.getRenderTarget(), override = scene.overrideMaterial;
    const shadow = renderer.shadowMap.enabled;
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    try {
      scene.overrideMaterial = null;
      renderer.shadowMap.enabled = false;
      renderer.setRenderTarget(this.target);
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.render(scene, this.projector);
    } finally {
      for (const { mesh, material } of swapped) mesh.material = material;
      for (const object of hidden) object.visible = true;
      scene.overrideMaterial = override;
      renderer.shadowMap.enabled = shadow;
      renderer.setRenderTarget(target);
      renderer.setViewport(viewport);
      renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest);
    }
  }

  patch(material: THREE.Material) {
    if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial)
        || this.patched.has(material)) return;
    this.patched.add(material);
    const original = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey.bind(material);
    const originalKey = key();
    material.onBeforeCompile = (shader, renderer) => {
      original(shader, renderer);
      Object.assign(shader.uniforms, {
        flashlightEnabled: this.enabled, flashlightMatrix: this.matrix,
        flashlightPosition: this.position, flashlightCookie: this.cookie,
        flashlightDepth: { value: this.target.depthTexture }, flashlightExposure: this.exposure,
      });
      shader.vertexShader = 'varying vec3 vFlashPosition; varying vec3 vFlashNormal;\n' + shader.vertexShader
        .replace('#include <project_vertex>', `
          #include <project_vertex>
          vFlashPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #ifdef USE_SKINNING
            vFlashNormal = normalize(mat3(modelMatrix) * objectNormal);
          #else
            vFlashNormal = normalize(mat3(modelMatrix) * normal);
          #endif
        `);
      shader.fragmentShader = `
        #define SOURCE_FLASHLIGHT
        varying vec3 vFlashPosition;
        varying vec3 vFlashNormal;
        uniform float flashlightEnabled;
        uniform mat4 flashlightMatrix;
        uniform vec3 flashlightPosition;
        uniform sampler2D flashlightCookie;
        uniform sampler2D flashlightDepth;
        uniform float flashlightExposure;
        float flashlightVisible(vec3 p, vec2 offset) {
          return step(p.z - 0.001, texture2D(flashlightDepth, p.xy + offset / 512.0).r);
        }
        vec3 sourceFlashlight(vec3 position, vec3 normal) {
          if (flashlightEnabled < 0.5) return vec3(0.0);
          vec4 projected = flashlightMatrix * vec4(position, 1.0);
          if (projected.w <= 0.0) return vec3(0.0);
          vec3 p = projected.xyz / projected.w;
          if (any(lessThanEqual(p, vec3(0.0))) || any(greaterThanEqual(p, vec3(1.0)))) return vec3(0.0);
          vec3 delta = flashlightPosition - position;
          float attenuation = clamp((1.0 - length(delta) / 25.4) / 0.4, 0.0, 1.0);
          attenuation *= clamp(dot(normalize(delta), normal), 0.0, 1.0);
          float visibility = (flashlightVisible(p, vec2(0.0)) + flashlightVisible(p, vec2(0.0, 1.0))
                            + flashlightVisible(p, vec2(0.0, -1.0)) + flashlightVisible(p, vec2(1.0, 0.0))
                            + flashlightVisible(p, vec2(-1.0, 0.0))) / 5.0;
          return texture2D(flashlightCookie, vec2(p.x, 1.0 - p.y)).rgb * attenuation * visibility;
        }
      ` + shader.fragmentShader.replace('#include <opaque_fragment>', `
        #ifndef SOURCE_MATERIAL_EFFECTS
          outgoingLight += diffuseColor.rgb * sourceFlashlight(vFlashPosition, normalize(vFlashNormal))
            ${material instanceof THREE.MeshBasicMaterial ? '* flashlightExposure' : ''};
        #endif
        #include <opaque_fragment>
      `);
    };
    material.customProgramCacheKey = () => originalKey + '-source-flashlight-v3';
    material.needsUpdate = true;
  }
}
