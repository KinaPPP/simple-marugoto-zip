'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const popup=fs.readFileSync(path.join(__dirname,'..','popup/popup.js'),'utf8');
const fn=name=>popup.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
test('ZIP resume cannot start while directory change is pending',async()=>{
  let prepared=0,started=0;
  const c=vm.createContext({directoryChangePending:true,archiveStartPending:false,collectionViewRevision:0,
    document:{querySelector:()=>({value:'5'})},els:{includeImages:{checked:true},includeVideos:{checked:false}},
    state:{counts:{images:10}},target:{platform:'x',handle:'demo'},
    prepareSaveDestination:async()=>{prepared++;return {saveMode:'directory',saveDirectoryKey:'old'};},
    chrome:{runtime:{sendMessage:async()=>{started++;return {ok:true};}}},refresh:async()=>{},render(){},setNotice(){}
  });
  vm.runInContext(fn('startArchive'),c);
  await c.startArchive();
  assert.equal(prepared,0);assert.equal(started,0);
});
test('pre-change polling response cannot overwrite a committed destination',async()=>{
  let resolve;
  const c=vm.createContext({directoryChangePending:false,collectionViewRevision:0,refreshRequestId:0,
    target:{platform:'x',handle:'demo'},state:{directory:'old'},render(){},
    chrome:{runtime:{sendMessage:()=>new Promise(r=>{resolve=r;})}}
  });
  vm.runInContext(fn('refresh'),c);
  const pending=c.refresh();
  c.directoryChangePending=true;c.collectionViewRevision++;
  c.state={directory:'new'};c.directoryChangePending=false;
  resolve({state:{directory:'old'}});await pending;
  assert.equal(c.state.directory,'new');
});
test('out-of-order polling responses cannot restore older state',async()=>{
  const pending=[];
  const c=vm.createContext({directoryChangePending:false,collectionViewRevision:0,refreshRequestId:0,
    target:{platform:'x',handle:'demo'},state:null,render(){},
    chrome:{runtime:{sendMessage:()=>new Promise(r=>pending.push(r))}}
  });
  vm.runInContext(fn('refresh'),c);
  const a=c.refresh(),b=c.refresh();
  pending[1]({state:{directory:'new'}});await b;
  pending[0]({state:{directory:'old'}});await a;
  assert.equal(c.state.directory,'new');
});
test('ZIP start is single-flight and sends the expected committed destination',async()=>{
  let resolveDestination;
  const messages=[];
  const c=vm.createContext({directoryChangePending:false,archiveStartPending:false,collectionViewRevision:0,
    archiveStopPending:false,archiveIsRunning:()=>false,
    document:{querySelector:()=>({value:'5'})},els:{includeImages:{checked:true},includeVideos:{checked:false}},
    state:{status:'complete',counts:{images:10}},target:{platform:'x',handle:'demo'},
    SMZFileSystem:{},window:{showDirectoryPicker(){}},
    currentSaveDirectoryInfo:()=>({key:'committed-B'}),
    prepareSaveDestination:()=>new Promise(r=>{resolveDestination=r;}),
    chrome:{runtime:{sendMessage:async m=>{messages.push(m);return {ok:true};}}},
    refresh:async()=>{},render(){},setStatusFeedback(){},setNotice(){}
  });
  vm.runInContext(fn('startArchive')+'\n'+fn('canChangeSaveDirectory'),c);
  const first=c.startArchive();
  assert.equal(c.archiveStartPending,true);
  assert.equal(c.canChangeSaveDirectory(),false,'cannot change destination while ZIP start is preparing');
  await c.startArchive();
  resolveDestination({saveMode:'directory',saveDirectoryKey:'committed-B',saveDirectoryName:'B'});
  await first;
  assert.equal(messages.length,1);
  assert.equal(messages[0].expectedSaveDirectoryKey,'committed-B');
  assert.equal(c.archiveStartPending,false);
});

class Element {
  constructor(tag='span'){this.tagName=tag;this.children=[];this.value='';this.className='';this.disabled=false;
    this.classList={add:n=>{this.className+=' '+n;},remove:n=>{this.className=this.className.split(' ').filter(x=>x!==n).join(' ');},toggle:(n,v)=>v?this.classList.add(n):this.classList.remove(n)};}
  set textContent(v){this.value=v;this.children=[];}
  get textContent(){return this.value+this.children.map(c=>c.textContent).join('');}
  append(...children){this.children.push(...children);}
  addEventListener(){}
  querySelector(selector){return this.children.find(c=>selector.startsWith('.')?c.className.split(' ').includes(selector.slice(1)):c.tagName===selector)||this.children.map(c=>c.querySelector?.(selector)).find(Boolean)||null;}
}
for(const error of [false,true])test(`feedback preserves destination and change control (error=${error})`,()=>{
  const detail=new Element('div');detail.textContent='15 / 500件まで処理済み。';
  const c=vm.createContext({els:{statusDetail:detail},directoryChangePending:false,archiveStartPending:false,
    currentSaveDirectoryInfo:()=>({key:'new',name:'B'}),canChangeSaveDirectory:()=>true,
    document:{createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})},
    currentStatusFeedback:()=>({message:'操作結果',error}),changeSaveDirectory(){}
  });
  vm.runInContext(fn('renderSaveDirectoryChangeControl')+'\n'+fn('applyStatusFeedback'),c);
  c.renderSaveDirectoryChangeControl();c.applyStatusFeedback();
  assert.match(detail.textContent,/保存先: B/);
  assert.equal(detail.querySelector('button')?.textContent,'[変更]');
  assert.match(detail.textContent,/操作結果/);
});
