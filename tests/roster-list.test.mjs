// A term Cornell publishes later must reach a device that already saved the list of rosters.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootApp} from './app-harness.mjs';

const DAY=24*3600*1000,LIVE=['FA26','SP26','SP27'];
async function boot({saved,online=true}){
 const calls=[];
 const app=await bootApp({terms:[{id:'sp27',name:'Spring 2027',starts_on:'2027-01-25',ends_on:'2027-05-20'}],enrollments:[],prepare:w=>{
  if(saved)w.localStorage.setItem('carn_rosters',JSON.stringify(saved));
  const base=w.fetch;
  w.fetch=async(url,options={})=>{if(!String(url).includes('rosters.json'))return base(url,options);
   calls.push(url);if(!online)throw new Error('offline');
   return {ok:true,json:async()=>({status:'success',data:{rosters:LIVE.map(slug=>({slug}))}})};};
 }});
 return {...app,calls};
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
