'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const popup=read('popup/popup.js');
const fn=name=>popup.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
test('popup never opens directory picker or requests filesystem permission',()=>{
  assert.doesNotMatch(popup,/window\.showDirectoryPicker\(|fs\.pickDirectory\(/);
  assert.doesNotMatch(popup,/ensureWritableDirectory\(existingKey, true\)/);
});
for(const mode of ['initial','missing','denied','repick','granted'])test(`destination preparation: ${mode}`,async()=>{
  const tabs=[];let queried=0;
  const state=mode==='initial'?{}:{preferredSaveDirectoryKey:'archive-directory:old',archive:{pauseReason:mode==='repick'?'save_permission':null}};
  const c=vm.createContext({state,window:{showDirectoryPicker(){}},
    SMZFileSystem:{getHandle:async key=>{
      queried++;
      return mode==='missing'?null:{name:'A'};
    }},openSaveDirectoryTab:async key=>tabs.push(key)
  });
  vm.runInContext(fn('prepareSaveDestination'),c);
  const result=await c.prepareSaveDestination();
  if(mode==='granted'||mode==='denied'){assert.equal(result.saveDirectoryKey,'archive-directory:old');assert.equal(tabs.length,0);}
  else {assert.equal(result.needsDirectorySelection,true);assert.deepEqual(tabs,[mode==='initial'?null:'archive-directory:old']);}
  if(['initial','repick'].includes(mode))assert.equal(queried,0);
});
test('change button opens account-scoped selection tab without altering destination',async()=>{
  const tabs=[];
  const c=vm.createContext({directoryChangePending:false,collectionViewRevision:0,
    target:{platform:'x',handle:'demo'},canChangeSaveDirectory:()=>true,
    currentSaveDirectoryInfo:()=>({key:'archive-directory:old'}),URLSearchParams,
    chrome:{runtime:{getURL:p=>'chrome-extension://test/'+p},tabs:{create:async options=>tabs.push(options)}},
    setStatusFeedback(){},render(){}
  });
  vm.runInContext(fn('openSaveDirectoryTab')+'\n'+fn('changeSaveDirectory'),c);
  await c.changeSaveDirectory();
  assert.equal(tabs.length,1);
  assert.equal(new URL(tabs[0].url).searchParams.get('expectedKey'),'archive-directory:old');
});
test('confirmed destination does not loop on popup-only permission query',async()=>{
  let opened=0;
  const c=vm.createContext({state:{preferredSaveDirectoryKey:'archive-directory:new'},window:{showDirectoryPicker(){}},
    SMZFileSystem:{getHandle:async()=>({name:'G test'}),ensureWritableDirectory:async()=>{throw Object.assign(Error('prompt in popup'),{code:'SAVE_PERMISSION_REQUIRED'});}},
    openSaveDirectoryTab:async()=>{opened++;}
  });
  vm.runInContext(fn('prepareSaveDestination'),c);
  for(let i=0;i<3;i++){
    const result=await c.prepareSaveDestination();
    assert.equal(result.saveDirectoryKey,'archive-directory:new');
    assert.equal(opened,0,'actual writer, not popup permission query, must decide whether selection is required');
  }
});
for(const mode of ['success','reject','lost','cancel'])test(`tab selection ${mode}: preserve live handle and honest status`,async()=>{
  const elements=Object.fromEntries(['target','current','choose','result'].map(id=>[id,{textContent:'',className:'',disabled:true,addEventListener(type,fn){this.click=fn;}}]));
  const records=new Map([['archive-directory:old',{name:'A'}]]);const events=[];
  const c=vm.createContext({document:{getElementById:id=>elements[id]},location:{search:'?platform=x&handle=demo&expectedKey=archive-directory%3Aold'},URLSearchParams,
    crypto:{randomUUID:()=> 'tab-test'},
    SMZFileSystem:{setHandle:async(k,h)=>records.set(k,h),removeHandle:async k=>records.delete(k)},
    window:{showDirectoryPicker:async()=>{events.push('picker');if(mode==='cancel')throw Object.assign(Error('original abort'),{name:'AbortError'});return {name:'写真集'};}},
    chrome:{runtime:{sendMessage:async m=>{
      if(m.type==='SMZ_GET_COLLECTION')return {ok:true,state:{preferredSaveDirectoryKey:'archive-directory:old',preferredSaveDirectoryName:'A'}};
      assert.equal(m.type,'SMZ_COMMIT_SAVE_DIRECTORY');assert.equal(records.get('archive-directory:old').name,'A');
      assert.equal(records.get(m.candidateKey).name,'写真集');
      if(mode==='lost')return undefined;
      return mode==='reject'?{ok:false,error:'ZIP保存中'}:{ok:true,saveDirectoryName:'写真集'};
    }}}
  });
  vm.runInContext(read('archive/directory.js'),c);await new Promise(r=>setTimeout(r,0));
  await elements.choose.click();assert.equal(events[0],'picker');assert.equal(records.get('archive-directory:old').name,'A');
  assert.equal(records.size,['success','lost'].includes(mode)?2:1);
  if(mode==='success')assert.match(elements.result.textContent,/写真集.*変更しました/);
  else assert.doesNotMatch(elements.result.textContent,/変更しました/);
  if(mode==='cancel')assert.notEqual(elements.result.className,'error');
});
