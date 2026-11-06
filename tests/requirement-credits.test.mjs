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
