'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'backup/schema.js'), 'utf8');
const ctx = vm.createContext({URL, console});
vm.runInContext(schema, ctx);
const B = ctx.SMZBackup;
const item = (id, type='image', index=1) => ({
  postId:String(id), mediaIndex:index, type, url:`https://pbs.twimg.com/media/${id}.jpg`, fallbackUrls:[], extension:type==='image'?'jpg':'mp4'
});
const full = {
  platform:'x', handle:'demo', status:'complete', collectionId:'full', collectionMode:'auto',
  startedAt:1, updatedAt:2, completedAt:2, newestPostId:'100', oldestPostId:'98',
  items:[item('100'),item('99'),item('98','video')], counts:{images:2,videos:1,total:3},
  archive:{status:'archive_complete',selection:{images:true,videos:true},mediaKind:'media',splitMode:'auto',nextItemIndex:3,processedItems:3,totalSelected:3,savedZipCount:1,completedAt:3}
};
const deltaLegacy = {
  platform:'x', handle:'demo', status:'complete', collectionId:'delta1', collectionMode:'auto', deltaMode:true,
  deltaBaselinePostId:'100', deltaVerified:true, startedAt:4, updatedAt:5, completedAt:5,
  newestPostId:'102', oldestPostId:'101', items:[item('102'),item('101','video')], counts:{images:1,videos:1,total:2},
  deltaSavedKinds:{images:true,videos:true},
  archive:{status:'archive_complete',selection:{images:true,videos:true},mediaKind:'media',splitMode:'auto',nextItemIndex:2,processedItems:2,totalSelected:2,savedZipCount:1,completedAt:6}
};
const normalized = B.normalizeImport({format:B.ACCOUNT_FORMAT,version:B.VERSION,source:{zipNumber:1,mediaKind:'media'},account:deltaLegacy,previous:full});
assert.equal(JSON.stringify(normalized.accounts[0].current.deltaBaselineCounts),JSON.stringify({images:2,videos:1,total:3}));
assert.equal(JSON.stringify(B.cumulativeCounts(normalized.accounts[0].current)),JSON.stringify({images:3,videos:2,total:5}));
const envelope = B.accountEnvelope(deltaLegacy, full, {zipNumber:1,mediaKind:'media'});
assert.equal(JSON.stringify(envelope.account.deltaBaselineCounts),JSON.stringify({images:2,videos:1,total:3}));
assert.equal(JSON.stringify(B.cumulativeCounts(envelope.account)),JSON.stringify({images:3,videos:2,total:5}));
const delta2 = {...deltaLegacy, collectionId:'delta2', deltaBaselineCounts:B.cumulativeCounts(normalized.accounts[0].current), items:[item('103')], counts:{images:1,videos:0,total:1}, newestPostId:'103', oldestPostId:'103'};
assert.equal(JSON.stringify(B.cumulativeCounts(delta2)),JSON.stringify({images:4,videos:2,total:6}));
console.log('PASS cumulative snapshot: legacy delta + previous backfills baseline, latest delta alone carries cumulative history, next delta advances cumulatively');
