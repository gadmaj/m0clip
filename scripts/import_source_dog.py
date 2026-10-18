#!/usr/bin/env python3
"""Extract Half-Life 2 Dog's original mesh, native skin and bind rig for R1 cosmetics.

Uses noclip.website's existing HL2 mounts; no map conversions or simulation edits.
Native vertices, indices, UVs, weights and inverse bind matrices are preserved.
"""
import argparse
import io
from PIL import Image
import json
from pathlib import Path
import numpy as np
from import_source_bsp import SCALE
from import_source_props import GLB
from source_models import StudioModel
from source_animation import AnimationModel
from source_assets import VPK, FileSystem, material
from source_materials import MaterialExport

ROOT=Path(__file__).resolve().parent.parent


def export(output):
    cache=str(ROOT/'assets/bsp-cache');base='https://z.noclip.website/HalfLife2/'
    fs=FileSystem(None,None,[VPK(base+'hl2_misc',cache),VPK(base+'hl2_textures',cache)],cache)
    model=StudioModel(fs,'models/dog.mdl');rig=AnimationModel(model.mdl)
    output.mkdir(parents=True,exist_ok=True)
    glb=GLB();glb.json['asset']['generator']='Original Half-Life 2 Dog mesh and native skin'
    exporter=MaterialExport(glb,fs);materials={}
    for name in model.materials:
        record=dict(name=name,pbrMetallicRoughness=dict(metallicFactor=0,roughnessFactor=.65))
        exporter.apply(record,name)
        meta=material(fs,name)
        if meta.get('selfillum'):
            # Source uses the base alpha channel as its self-illumination mask.
            index=record['pbrMetallicRoughness']['baseColorTexture']['index']
            view=glb.json['bufferViews'][glb.json['images'][glb.json['textures'][index]['source']]['bufferView']]
            pixels=np.array(Image.open(io.BytesIO(glb.buffer[view['byteOffset']:view['byteOffset']+view['byteLength']])).convert('RGBA'))/255
            linear=np.where(pixels[:,:,:3]<=.04045,pixels[:,:,:3]/12.92,((pixels[:,:,:3]+.055)/1.055)**2.4)
            light=linear*pixels[:,:,3:4]
            srgb=np.where(light<=.0031308,light*12.92,1.055*light**(1/2.4)-.055)
            png=io.BytesIO();Image.fromarray(np.rint(srgb*255).clip(0,255).astype('uint8')).save(png,'PNG')
            image=len(glb.json['images']);glb.json['images'].append(dict(bufferView=glb.view(png.getvalue()),mimeType='image/png'))
            texture=len(glb.json['textures']);glb.json['textures'].append(dict(sampler=0,source=image))
            record.update(emissiveTexture=dict(index=texture),emissiveFactor=meta['selfillumtint'])
        if meta.get('translucent'):record['alphaMode']='BLEND' 
        if meta.get('alphatest'):record.update(alphaMode='MASK',alphaCutoff=meta['alphatestreference'])
        materials[name]=len(glb.json['materials']);glb.json['materials'].append(record)
    if exporter.missing:raise FileNotFoundError('Missing native Dog textures: '+', '.join(exporter.missing))
    primitives=[];mesh_report=[]
    for mesh in model.selected(0):
        if not np.allclose(mesh.weights.sum(axis=1),1,atol=1e-6):raise ValueError('Invalid native Dog weights')
        joints=np.column_stack([mesh.joints,np.zeros(len(mesh.joints))])
        if np.any(joints[mesh.weights>0]>=len(rig.bones)):raise ValueError('Invalid native Dog bone index')
        primitives.append(dict(attributes=dict(POSITION=glb.accessor(mesh.positions*SCALE,'VEC3'),
            NORMAL=glb.accessor(mesh.normals,'VEC3'),TANGENT=glb.accessor(mesh.tangents,'VEC4'),
            TEXCOORD_0=glb.accessor(mesh.uv,'VEC2'),JOINTS_0=glb.accessor(joints,'VEC4',joints=True),
            WEIGHTS_0=glb.accessor(mesh.weights,'VEC4')),
            indices=glb.accessor(mesh.triangles.ravel(),'SCALAR',index=True),material=materials[model.material(mesh,0)]))
        mesh_report.append(dict(vertices=len(mesh.positions),triangles=len(mesh.triangles),material=model.material(mesh,0)))
    node=glb.node('HalfLife2_Dog',primitives,None,dict(sourceProp='models/dog.mdl',sourceRobot=True))
    # The one-frame bind pose copies native header transforms, without guessing an idle animation.
    clip=dict(times=np.array([0],dtype=np.float32),positions=np.array([[b['pos'] for b in rig.bones]]),
              quaternions=np.array([[b['quat'] for b in rig.bones]]),loop=False)
    glb.skin(node,rig,clip)
    bones=[]
    for b in rig.bones:
        inverse=b['inverse'].copy();inverse[:3,3]*=SCALE
        bones.append(dict(name=b['name'],parent=b['parent'],position=(b['pos']*SCALE).tolist(),
                          quaternion=b['quat'].tolist(),inverseBind=inverse.astype('float32').T.ravel().tolist()))
    foot_bones={i for i,b in enumerate(rig.bones) if b['name'] in ('Dog_Model.Foot_L','Dog_Model.Foot_R')}
    for i,b in enumerate(rig.bones):
        if b['parent'] in foot_bones:foot_bones.add(i)
    foot_samples={}
    for mesh in model.selected(0):
        for position,joints,weights in zip(mesh.positions,mesh.joints,mesh.weights):
            if sum(float(w) for j,w in zip(joints,weights) if int(j) in foot_bones)<=.5:continue
            sample=dict(position=(position*SCALE).tolist(),joints=joints.tolist(),weights=(weights[:3]/weights[:3].sum()).tolist())
            foot_samples[tuple(position)+tuple(joints)+tuple(weights)]=sample
    vertices=np.concatenate([m.positions for m in model.selected(0)])*SCALE
    report=dict(game='Half-Life 2',source='models/dog.mdl',visual='dog.glb',units='metres',
                bones=bones,footSamples=list(foot_samples.values()),meshes=mesh_report,triangles=sum(m['triangles'] for m in mesh_report),
                vertices=sum(m['vertices'] for m in mesh_report),bounds=[vertices.min(0).tolist(),vertices.max(0).tolist()],
                materials=model.materials,textures=len(glb.json['textures']),missing_textures=exporter.missing,
                native_weights=True,native_inverse_bind_matrices=True,changes_physics=False)
    glb.json['nodes'][node]['extras']['sourceRig']=report
    glb.write(output/'dog.glb');(output/'analysis.json').write_text(json.dumps(report,indent=2))
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'public/assets/source-robots/halflife2-dog')
    args=parser.parse_args();report=export(args.output)
    print(json.dumps({k:v for k,v in report.items() if k not in ('bones','footSamples')},indent=2))
