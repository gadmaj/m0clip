'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let directory;
/** One private output directory per invocation, including repeated runs under the same QA_ARTIFACT_DIR. */
module.exports=function artifactPath(name=''){
  if(!directory){
    const parent=process.env.QA_ARTIFACT_DIR||os.tmpdir();
    fs.mkdirSync(parent,{recursive:true});
    const check=path.basename(process.argv[1]||'check','.cjs');
    directory=fs.mkdtempSync(path.join(parent,'m0clip-'+check+'-'));
  }
  return path.join(directory,name);
};
