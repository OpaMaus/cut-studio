'use strict';
const crypto=require('node:crypto');
const TOTAL_PATH='docs/downloads.json';
const STATE_PATH='.github/data/download-total-state.json';
const eligible=name=>/^CUT-STUDIO-(?:Setup\.exe|macOS-(?:arm64|x64)\.dmg)(?:\.rollback-[a-f0-9-]+)?$/i.test(name);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function accumulate(previous,state,assets){
 if(!integer(previous.total)||state.schema!==1||!state.seen||typeof state.seen!=='object'||Array.isArray(state.seen))throw Error('Invalid saved download counter; refusing to reset it');
 const seen={...state.seen};for(const [id,count]of Object.entries(seen))if(!/^[a-f0-9]{64}$/.test(id)||!integer(count))throw Error('Invalid checkpoint');
 let total=previous.total;
 for(const asset of assets){if(!eligible(asset.name))continue;if(!Number.isSafeInteger(asset.id)||asset.id<1||!integer(asset.download_count))throw Error('Invalid GitHub download count');const key=crypto.createHash('sha256').update(String(asset.id)).digest('hex'),old=seen[key]??0;total+=Math.max(0,asset.download_count-old);if(!integer(total))throw Error('Download counter overflow');seen[key]=Math.max(old,asset.download_count);}
 return {total:{total},state:{schema:1,seen}};
}
async function sync({token=process.env.GITHUB_TOKEN,repo=process.env.GITHUB_REPOSITORY||'OpaMaus/cut-studio',initialize=false}={}){
 if(!token||!/^[-\w.]+\/[-\w.]+$/.test(repo))throw Error('GitHub access is required');
 const base='https://api.github.com/repos/'+repo,headers={Authorization:'Bearer '+token,'User-Agent':'CUT-STUDIO-total-downloads',Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
 async function api(route,method='GET',body,missing=false){const r=await fetch(base+route,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});if(missing&&r.status===404)return null;if(!r.ok){const e=Error(method+' '+route+' HTTP '+r.status);e.status=r.status;throw e;}return r.status===204?null:r.json();}
 const assets=[];for(let page=1;page<=100;page++){const releases=await api('/releases?per_page=100&page='+page);for(const release of releases){if(release.draft)continue;for(let p=1;p<=100;p++){const items=await api('/releases/'+release.id+'/assets?per_page=100&page='+p);assets.push(...items.filter(a=>eligible(a.name)));if(items.length<100)break;if(p===100)throw Error('Too many release assets');}}if(releases.length<100)break;if(page===100)throw Error('Too many releases');}
 if(!assets.length)throw Error('No installers found; preserving saved total');
 for(let attempt=0;attempt<5;attempt++){
  const ref=await api('/git/ref/heads/main'),head=await api('/git/commits/'+ref.object.sha);
  async function read(name){const file=await api('/contents/'+name+'?ref='+ref.object.sha,'GET',undefined,true);return file?JSON.parse(Buffer.from(file.content,'base64').toString('utf8')):null;}
  const prior=await read(TOTAL_PATH),state=await read(STATE_PATH);
  if((!prior||!state)&&!(initialize&&!prior&&!state))throw Error('Counter data missing; refusing to discard its history');
  const next=accumulate(prior??{total:0},state??{schema:1,seen:{}},assets);
  if(prior&&JSON.stringify(next.total)===JSON.stringify(prior)&&JSON.stringify(next.state)===JSON.stringify(state)){console.log('Download total unchanged: '+next.total.total);return next.total;}
  const tree=[];for(const [name,value]of [[TOTAL_PATH,next.total],[STATE_PATH,next.state]]){const blob=await api('/git/blobs','POST',{encoding:'utf-8',content:JSON.stringify(value,null,2)+'\n'});tree.push({path:name,mode:'100644',type:'blob',sha:blob.sha});}
  const files=await api('/git/trees','POST',{base_tree:head.tree.sha,tree});const commit=await api('/git/commits','POST',{message:'Update aggregate installer download total',tree:files.sha,parents:[ref.object.sha]});
  try{await api('/git/refs/heads/main','PATCH',{sha:commit.sha,force:false});console.log('Saved download total: '+next.total.total);return next.total;}catch(e){if(![409,422].includes(e.status)||attempt===4)throw e;}
 }
 throw Error('Could not safely save download total');
}
function selfTest(){const assert=require('node:assert/strict');const win={id:11,name:'CUT-STUDIO-Setup.exe',download_count:2},mac={id:12,name:'CUT-STUDIO-macOS-arm64.dmg',download_count:3};let a=accumulate({total:0},{schema:1,seen:{}},[win,mac]);assert.equal(a.total.total,5);a=accumulate(a.total,a.state,[win,mac]);assert.equal(a.total.total,5);a=accumulate(a.total,a.state,[{...win,download_count:4},mac]);assert.equal(a.total.total,7);a=accumulate(a.total,a.state,[{...win,name:win.name+'.rollback-12345678',download_count:5},mac,{...win,id:13,download_count:1}]);assert.equal(a.total.total,9);a=accumulate(a.total,a.state,[mac,{...win,id:13,download_count:2},{id:14,name:'CUT-STUDIO-Source.zip',download_count:99}]);assert.equal(a.total.total,10);a=accumulate(a.total,a.state,[{...win,id:13,download_count:0},mac]);assert.equal(a.total.total,10);assert.throws(()=>accumulate({total:-1},a.state,[]));console.log('PASS cumulative total: initial sum, no double count, growth, replacements, archived files, ignored source downloads and lower transient counts');}
module.exports={accumulate,sync,selfTest};
if(require.main===module){if(process.argv.includes('--self-test'))selfTest();else sync().catch(e=>{console.error(e.message);process.exitCode=1;});}
