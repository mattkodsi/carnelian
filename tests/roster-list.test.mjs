// A term Cornell publishes later must reach a device that already saved the list of rosters.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootApp} from './app-harness.mjs';

const DAY=24*3600*1000,LIVE=['FA26','SP26','SP27'];
async function boot({saved,online=true,storage={},subjects=['REAL','PHIL'],failing=[]}){
 const calls=[],times=[];
 const app=await bootApp({terms:[{id:'sp27',name:'Spring 2027',starts_on:'2027-01-25',ends_on:'2027-05-20'}],enrollments:[],prepare:w=>{
  if(saved)w.localStorage.setItem('carn_rosters',JSON.stringify(saved));
  for(const [k,v] of Object.entries(storage))w.localStorage.setItem(k,JSON.stringify(v));
  const base=w.fetch;
  w.fetch=async(url,options={})=>{url=String(url);if(!url.includes('classes.cornell.edu'))return base(url,options);
   calls.push(url);times.push({url,at:Date.now()});if(!online)throw new Error('offline');
   const sub=/subject=(\w+)/.exec(url)?.[1];
   if(failing.includes(sub))throw new Error('this department failed');
   const data=url.includes('rosters.json')?{rosters:LIVE.map(slug=>({slug}))}
    :url.includes('subjects.json')?{subjects:subjects.map(value=>({value}))}
    :{classes:[{catalogNbr:'6100',titleLong:sub+' class added later',enrollGroups:[{unitsMaximum:3}]}]};
   return {ok:true,json:async()=>({status:'success',data})};};
 }});
 return {...app,calls,times,cornell:()=>calls.filter(u=>!u.includes('rosters.json'))};
}

test('a list saved without a date is replaced, so the new term is searched live',async()=>{
 const app=await boot({saved:{items:['FA26','SP26']}});
 try{
  const r=await app.get('resolveRoster')('SP27');
  assert.equal(r.roster,'SP27');assert.equal(r.recycled,false);
  assert.equal(app.calls.length,1);
  const kept=JSON.parse(app.w.localStorage.getItem('carn_rosters'));
  assert.deepEqual(kept.items,LIVE);assert.ok(Date.now()-kept.at<DAY);
 }finally{app.close();}
});

test('a list saved more than a day ago is replaced',async()=>{
 const app=await boot({saved:{at:Date.now()-DAY-1000,items:['FA26','SP26']}});
 try{
  const r=await app.get('resolveRoster')('SP27');
  assert.equal(r.roster,'SP27');assert.equal(r.recycled,false);
 }finally{app.close();}
});

test('a list saved within the day is used without asking Cornell',async()=>{
 const app=await boot({saved:{at:Date.now()-1000,items:['FA26','SP26']}});
 try{
  const r=await app.get('resolveRoster')('SP27');
  assert.equal(r.roster,'SP26');assert.equal(r.recycled,true);
  assert.equal(app.calls.length,0);
 }finally{app.close();}
});

test('offline, an old saved list still beats the built-in one',async()=>{
 const app=await boot({saved:{items:['SP27','FA26']},online:false});
 try{
  const r=await app.get('resolveRoster')('SP27');
  assert.equal(r.roster,'SP27');assert.equal(r.recycled,false);
 }finally{app.close();}
});

test('offline with nothing saved, the built-in list is used',async()=>{
 const app=await boot({online:false});
 try{
  const r=await app.get('resolveRoster')('FA26');
  assert.equal(r.roster,'FA26');assert.equal(r.recycled,false);
 }finally{app.close();}
});

// The name searches: a class Cornell adds later must reach a device that already saved the classes.
const OLD_CLASS={s:'REAL',n:'5000',t:'Saved class'},FRESH=()=>Date.now()-1000,EXPIRED=()=>Date.now()-DAY-1000;
const titles=list=>Array.from(list,x=>x.t),KEY='carn_catalog_SP27';
const settled=app=>app.get('CATALOG_BUILDING').SP27;

test('names: yesterday\'s list answers at once while a fresh one builds at one department a second',async()=>{
 const app=await boot({storage:{[KEY]:{at:EXPIRED(),index:[OLD_CLASS]}}});
 try{
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['Saved class']);
  await settled(app);
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['REAL class added later','PHIL class added later']);
  const kept=JSON.parse(app.w.localStorage.getItem(KEY));
  assert.equal(kept.index.length,2);assert.ok(Date.now()-kept.at<DAY);
  const pulls=app.times.filter(x=>x.url.includes('search/classes')).map(x=>x.at);
  assert.equal(pulls.length,2);assert.ok(pulls[1]-pulls[0]>=990,`pulls ${pulls[1]-pulls[0]}ms apart`);
 }finally{app.close();}
});

test('names: a list saved today is used without asking Cornell',async()=>{
 const app=await boot({storage:{[KEY]:{at:FRESH(),index:[OLD_CLASS]}}});
 try{
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['Saved class']);
  assert.equal(app.cornell().length,0);
 }finally{app.close();}
});

test('names: one department failing keeps the complete saved list',async()=>{
 const saved={at:EXPIRED(),index:[OLD_CLASS]};
 const app=await boot({storage:{[KEY]:saved},failing:['PHIL']});
 try{
  await app.get('buildCatalog')('SP27');await settled(app);
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['Saved class']);
  assert.equal(JSON.parse(app.w.localStorage.getItem(KEY)).at,saved.at);
 }finally{app.close();}
});

test('names: with nothing saved, the first build shows what it got and saves only a complete list',async()=>{
 const app=await boot({failing:['PHIL']});
 try{
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['REAL class added later']);
  assert.equal(app.w.localStorage.getItem(KEY),null);
 }finally{app.close();}
});

test('names: with nothing saved and no failures, the first build is saved',async()=>{
 const app=await boot({});
 try{
  assert.equal((await app.get('buildCatalog')('SP27')).length,2);
  assert.equal(JSON.parse(app.w.localStorage.getItem(KEY)).index.length,2);
 }finally{app.close();}
});

test('names: offline, an old saved list is still searched and stays saved',async()=>{
 const saved={at:EXPIRED(),index:[OLD_CLASS]};
 const app=await boot({storage:{[KEY]:saved,carn_subjects_SP27:['REAL']},online:false});
 try{
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['Saved class']);
  await settled(app);
  assert.deepEqual(titles(await app.get('buildCatalog')('SP27')),['Saved class']);
  assert.equal(JSON.parse(app.w.localStorage.getItem(KEY)).at,saved.at);
 }finally{app.close();}
});

test('names: the title box searches the same list and clears out its old one',async()=>{
 const app=await boot({saved:{at:FRESH(),items:['SP27']},storage:{[KEY]:{at:FRESH(),index:[OLD_CLASS]},carn_tidx_SP27:{v:1,built:'2026-11-01',items:[{s:'X',n:'1',t:'Old title box class'}]}}});
 try{
  const $=app.get('$');$('#mTitleIn').value='saved cl';
  await app.get('runTitleSearch')();
  assert.match($('#mTitleResults').textContent,/Saved class/);
  assert.equal(app.w.localStorage.getItem('carn_tidx_SP27'),null);
 }finally{app.close();}
});

test('departments: an undated saved list is replaced, and a new department is recognized',async()=>{
 const app=await boot({storage:{carn_subjects_SP27:['REAL']},subjects:['REAL','NEWD']});
 try{
  assert.ok((await app.get('availSubjects')('SP27')).has('NEWD'));
  const kept=JSON.parse(app.w.localStorage.getItem('carn_subjects_SP27'));
  assert.deepEqual(kept.items,['REAL','NEWD']);assert.ok(Date.now()-kept.at<DAY);
 }finally{app.close();}
});

test('departments: a list saved today is used without asking Cornell',async()=>{
 const app=await boot({storage:{carn_subjects_SP27:{at:FRESH(),items:['REAL']}}});
 try{
  assert.ok((await app.get('availSubjects')('SP27')).has('REAL'));
  assert.equal(app.cornell().length,0);
 }finally{app.close();}
});

test('departments: offline, an old saved list is still used',async()=>{
 const app=await boot({storage:{carn_subjects_SP27:['REAL']},online:false});
 try{assert.ok((await app.get('availSubjects')('SP27')).has('REAL'));}finally{app.close();}
});

test('a tab left open past a day asks Cornell again',async()=>{
 const app=await boot({saved:{at:FRESH(),items:['FA26','SP26']}});
 try{
  assert.equal((await app.get('resolveRoster')('SP27')).roster,'SP26');
  const now=Date.now();app.w.Date.now=()=>now+DAY+1000;
  const r=await app.get('resolveRoster')('SP27');
  assert.equal(r.roster,'SP27');assert.equal(r.recycled,false);
 }finally{app.close();}
});
