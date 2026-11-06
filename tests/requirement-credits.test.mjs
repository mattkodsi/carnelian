// A requirement grouped by term shows each course's real credits: the full amount, or
// "1 of 3 credits" only when a course really is split across requirements.
import {test} from 'node:test';import assert from 'node:assert/strict';import {bootApp} from './app-harness.mjs';

const terms=[{id:'t1',name:'Term One',starts_on:'2025-08-25',ends_on:'2025-12-19',sort:1},{id:'t2',name:'Term Two',starts_on:'2026-08-24',ends_on:'2026-12-18',sort:2}];
const enrollments=[
 {id:1,code:'TEST 1000',title:'First in its term',credits:3,term_id:'t1',status:'completed',grade:'A'},
 {id:2,code:'TEST 2000',title:'Second in its term',credits:1.5,term_id:'t2',status:'completed',grade:'A'},
 {id:3,code:'TEST 2001',title:'Third in its term',credits:3,term_id:'t2',status:'completed',grade:'A'},
];
const rowsFor=async need=>{
 const app=await bootApp({terms,enrollments});
 try{
  const DB=app.get('DB');
  DB.requirements.push({id:'r',program_id:'p',name:'Grouped',sort:1,spec:{need:{type:'credits',n:need},match:{codes:['TEST 1000','TEST 2000','TEST 2001']},overflowTo:'free',groupByTerm:true}});
  const div=app.w.document.createElement('div');div.innerHTML=app.get('reqBlocks')({id:'p'});
  return Object.fromEntries([...div.querySelectorAll('.crow')].filter(r=>r.querySelector('.code')).map(r=>[r.querySelector('.code').textContent,r.querySelector('.cc').textContent]));
 }finally{app.close();}
};

test('courses that fully count show their full credits, whatever their place in the term',async()=>{
 assert.deepEqual(await rowsFor(12),{'TEST 1000':'3 credits','TEST 2000':'1.5 credits','TEST 2001':'3 credits'});
});

test('a course over-filling the requirement shows how much of it counted',async()=>{
 assert.deepEqual(await rowsFor(5.5),{'TEST 1000':'3 credits','TEST 2000':'1.5 credits','TEST 2001':'1 of 3 credits'});
});

// Free Electives: its own courses and credits spilled in from other requirements read as one list, by term.
const freeRows=async()=>{
 const app=await bootApp({terms:[{id:'past',name:'Past Term',starts_on:'2025-08-25',ends_on:'2025-12-19',sort:1},{id:'now',name:'Current Term',starts_on:'2020-01-01',ends_on:'2099-12-31',sort:2},{id:'later',name:'Later Term',starts_on:'2098-01-20',ends_on:'2098-05-13',sort:3}],
  enrollments:[
   {id:1,code:'TEST 9000',title:'Planned seminar',credits:0.5,term_id:'later',status:'planned'},
   {id:2,code:'TEST 5950',title:'Big course',credits:3,term_id:'now',status:'in_progress'},
   {id:3,code:'TEST 6000',title:'Own elective',credits:3,term_id:'now',status:'in_progress'},
   {id:4,code:'TEST 1000',title:'Finished elective',credits:3,term_id:'past',status:'completed',grade:'A'},
   {id:5,code:'TEST 9000',title:'Seminar one',credits:0.5,term_id:'past',status:'completed',grade:'S'},
  ]});
 try{
  const DB=app.get('DB');
  DB.requirements.push({id:'free',program_id:'p',name:'Free',sort:3,spec:{need:{type:'credits',n:16.5},match:{manual:true},groupByTerm:true}},
   {id:'cst',program_id:'p',name:'Construction',sort:1,spec:{short:'CST',need:{type:'credits',n:1.5},match:{codes:['TEST 5950']},overflowTo:'free'}},
   {id:'core',program_id:'p',name:'Core',sort:2,spec:{short:'Core',caps:{'TEST 9000':0.5},need:{type:'credits',n:27.5},match:{codes:['TEST 9000']},overflowTo:'free'}});
  DB.satisfactions.push({enrollment_id:3,requirement_id:'free'},{enrollment_id:4,requirement_id:'free'});
  const pr=app.get('reqProgress')(DB.requirements[0]);
  const div=app.w.document.createElement('div');div.innerHTML=app.get('reqBlocks')({id:'p'});
  const free=[...div.querySelectorAll('.req')].find(b=>b.querySelector('.nm').textContent==='Free');
  return {pr,rows:[...free.querySelectorAll('.crow')].filter(r=>r.classList.contains('termhdr')||r.querySelector('.code')).map(r=>r.classList.contains('termhdr')?r.textContent:`${r.querySelector('.code').textContent} | ${r.querySelector('.cc').textContent}${/over /.test(r.textContent)?' | '+r.querySelector('.ti').textContent:''}`)};
 }finally{app.close();}
};

test('Free Electives shows term headings and one list in term order, spillover included',async()=>{
 const {pr,rows}=await freeRows();
 assert.deepEqual(rows,['Past Term','TEST 1000 | 3 credits','Current Term','TEST 5950 | 1.5 credits | over CST minimum','TEST 6000 | 3 credits','Later Term','TEST 9000 | 0.5 credits']);
 assert.deepEqual([pr.done,pr.cur,pr.fut],[3,4.5,0.5]);
});

test('within a term, courses go done, then underway, then planned',async()=>{
 const app=await bootApp({terms:[{id:'now',name:'Now',starts_on:'2020-01-01',ends_on:'2099-12-31',sort:1}],enrollments:[
  {id:1,code:'TEST 1000',title:'Planned',credits:1,term_id:'now',status:'planned'},
  {id:2,code:'TEST 2000',title:'Underway',credits:1,term_id:'now',status:'in_progress'},
  {id:3,code:'TEST 3000',title:'Done',credits:1,term_id:'now',status:'completed',grade:'A'}]});
 try{
  // The app treats a planned course in the current term as underway, so a finished course must lead the two underway ones.
  const ds=app.get('displayStatus'),all=app.get('DB').enrollments;
  const div=app.w.document.createElement('div');div.innerHTML=app.get('coursesByTermHTML')(all);
  const shown=[...div.querySelectorAll('.code')].map(c=>c.textContent);
  assert.deepEqual(shown,['TEST 3000','TEST 1000','TEST 2000']);
  assert.deepEqual(shown.map(code=>ds(all.find(e=>e.code===code))),['completed','in_progress','in_progress']);
 }finally{app.close();}
});

// A&S "Additional credits": the real number past the target, measured so non-A&S credits never fill the A&S floor.
const additional=async(asCr,otherCr,extra=[])=>{
 const app=await bootApp({terms:[{id:'ug',name:'Undergrad',career:'undergrad',starts_on:'2023-08-21',ends_on:'2024-05-18',sort:1},{id:'now',name:'Now',career:'grad',starts_on:'2020-01-01',ends_on:'2099-12-31',sort:2}],enrollments:[
  {id:1,code:'ASX 1000',credits:asCr,term_id:'ug',status:'completed',grade:'A',in_as:true},
  {id:2,code:'OTH 1000',credits:otherCr,term_id:'ug',status:'completed',grade:'A',in_as:false},...extra]});
 try{
  const DB=app.get('DB');
  const req={id:'as-total',program_id:'as',name:'Additional credits',sort:2,spec:{need:{type:'credits',n:20},match:{scope:'all'},creditFloor:100}};
  DB.requirements.push(req);
  const pr=app.get('reqProgress')(req);
  const div=app.w.document.createElement('div');div.innerHTML=app.get('reqBlocks')({id:'as'});
  return {done:pr.done,cur:pr.cur,met:pr.met,shown:div.querySelector('.cr').textContent};
 }finally{app.close();}
};

test('Additional credits shows the real total, not 20 of 20',async()=>{
 assert.deepEqual(await additional(100,24.5),{done:24.5,cur:0,met:true,shown:'24.5/20'});
});

test('non-A&S credits are not used up filling the A&S floor',async()=>{
 const r=await additional(98,24.5,[{id:3,code:'ASX 2000',credits:2,term_id:'now',status:'in_progress',in_as:true,counts_toward:'undergrad'}]);
 assert.deepEqual([r.done,r.cur,r.shown],[24.5,0,'24.5/20']);
});

test('A&S credits past 100 count as additional, and a short row is still short',async()=>{
 const r=await additional(105,10);
 assert.deepEqual([r.done,r.met,r.shown],[15,false,'15/20']);
});
