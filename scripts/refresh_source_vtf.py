#!/usr/bin/env python3
"""Embed a Source map's native VTF files, preserving geometry and image payloads."""
import argparse,hashlib,io,json,struct,zlib
from pathlib import Path
from PIL import Image
from import_source_bsp import BSP,MOUNTS,STORAGE
from import_source_props import GLB
from source_assets import FileSystem,VPK,material,decode_vtf
from optimize_map_textures import read_glb,write_glb


def normalize(path):
    path='/'.join(p for p in path.replace('\\','/').lower().strip('/').split('/') if p)
    return path.removeprefix('materials/').removesuffix('.vtf').removesuffix('.vmt')


def refresh(path,fs,bsp,initial_prop_textures=None):
    document,binary=read_glb(path)
    glb=GLB();glb.json=document;glb.buffer=bytearray(binary)
    bindings={};payloads={};hashes={};compressed_views=set();replacements={}
    for texture in document['textures']:
        meta=texture.get('extras',{}).get('sourceVtf')
        if meta:
            payloads[meta['path']]=meta['bufferView']
            if meta.get('compression')=='zlib':compressed_views.add(meta['bufferView'])
    def bind(index,name,frame=0,face=0):
        if index is None:return
        value=(normalize(name),frame,face)
        if index in bindings and bindings[index]!=value:raise ValueError(f'Conflicting native texture {index}: {bindings[index]} vs {value}')
        bindings[index]=value
    for record in document['materials']:
        meta=record.get('extras',{}).get('sourceMaterial') or material(fs,record.get('name',''))
        if not meta:continue
        bind(record.get('pbrMetallicRoughness',{}).get('baseColorTexture',{}).get('index'),meta['basetexture'])
        for channel in ('bumpmap','envmapmask','phongexponenttexture','selfillummask','basetexture2','detail'):
            if channel+'Index' in meta:bind(meta[channel+'Index'],meta[channel])
        for frame,index in enumerate(meta.get('animationFrames',[])):bind(index,meta['basetexture'],frame)
        if meta.get('envmapFaces'):
            if meta['envmap']=='env_cubemap':raise ValueError('Explicit cubemap path is missing')
            for face,index in enumerate(meta['envmapFaces']):bind(index,meta['envmap'],face=face)
    # The props importer inserts the native cubemap table immediately after its
    # original base textures. Validate every face against its existing PNG below.
    if initial_prop_textures is not None:
        index=initial_prop_textures
        for x,y,z,_ in struct.iter_unpack('<iiiI',bsp.lump(42)):
            name=f'maps/{path.parent.name}/c{x}_{y}_{z}';raw=fs.read('materials/'+name+'.vtf')
            if raw is None or decode_vtf(raw) is None:continue
            for face in range(6):bind(index+face,name,face=face)
            index+=6
    def image_hash(index):
        if index not in hashes:
            texture=document['textures'][index];image=document['images'][texture['source']]
            view=document['bufferViews'][image['bufferView']];at=view.get('byteOffset',0)
            pixels=Image.open(io.BytesIO(binary[at:at+view['byteLength']])).convert('RGBA')
            hashes[index]=(pixels.size,hashlib.sha256(pixels.tobytes()).digest())
        return hashes[index]
    mip_levels=0;formats={}
    for index,(name,frame,face) in sorted(bindings.items()):
        raw=fs.read('materials/'+name+'.vtf')
        if raw is None:raise ValueError(f'Missing native texture: {name}')
        decoded=decode_vtf(raw,frame,face)
        if decoded is None:raise ValueError(f'Unsupported native texture: {name}')
        expected=((decoded.shape[1],decoded.shape[0]),hashlib.sha256(decoded.tobytes()).digest())
        if image_hash(index)!=expected:raise ValueError(f'Native texture differs from existing PNG: {name} frame {frame} face {face} index {index}')
        encoded=zlib.compress(raw,9)
        if name not in payloads:payloads[name]=glb.view(encoded);compressed_views.add(payloads[name])
        else:
            view=document['bufferViews'][payloads[name]];at=view.get('byteOffset',0)
            existing=bytes(glb.buffer[at:at+view['byteLength']])
            if (zlib.decompress(existing) if payloads[name] in compressed_views else existing)!=raw:raise ValueError(f'Native payload changed: {name}')
            replacements[payloads[name]]=encoded
        document['textures'][index].setdefault('extras',{})['sourceVtf']=dict(path=name,bufferView=payloads[name],frame=frame,face=face,compression='zlib')
        mip_levels+=raw[56];fmt=struct.unpack_from('<I',raw,52)[0];formats[str(fmt)]=formats.get(str(fmt),0)+1
    compact=bytearray()
    for index,view in enumerate(document['bufferViews']):
        at=view.get('byteOffset',0);data=replacements.get(index,glb.buffer[at:at+view['byteLength']]);compact.extend(bytes(-len(compact)%4))
        view['byteOffset']=len(compact);view['byteLength']=len(data);compact.extend(data)
    write_glb(path,document,compact)
    return dict(file=path.name,textures=len(bindings),vtf_files=len(payloads),mip_levels=mip_levels,formats=formats,
                preserved_geometry=True,preserved_images=True,embedded_bytes=sum(document['bufferViews'][i]['byteLength'] for i in payloads.values()))


if __name__=='__main__':
    from import_source_bsp import GAMES
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--map',choices=GAMES['neotokyo'][2],required=True);args=parser.parse_args()
    root=Path(__file__).resolve().parent.parent;cache=root/'assets/bsp-cache';directory=root/'public/assets/maps'/args.map
    bsp=BSP((cache/f'z.noclip.website_NeoTokyo_NeotokyoSource_maps_{args.map}.bsp').read_bytes())
    loose,archives=MOUNTS['neotokyo'];fs=FileSystem(bsp.lump(40),f'{STORAGE}/{loose}',[VPK(f'{STORAGE}/{v}',str(cache)) for v in archives],str(cache))
    report={'files':[refresh(directory/'visual.glb',fs,bsp),refresh(directory/'props.glb',fs,bsp,json.loads((directory/'props-report.json').read_text())['textured'])]}
    (directory/'native-textures-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
