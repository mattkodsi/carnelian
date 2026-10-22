// The TV feed must state the same facts the app shows: same class sessions, same
// titles, kinds, assessment flags, and course colors, for the same data.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootApp,appSessions,appDeadline} from './app-harness.mjs';
import {buildFeed} from '../supabase/functions/wall/feed.ts';
import {ACAL,TERMS,ENR,asg} from '../supabase/functions/wall/fixtures.ts';
import {addDays} from '../supabase/functions/_shared/acal.ts';

const ASG=[
 asg({id:1,name:'Quiz 3',kind:'quiz',due_on:'2026-10-27',due_time:'08:40',enrollment_id:86}),
 asg({id:2,name:'Final Case Project: Topic',kind:'project',due_on:'2026-10-26',due_time:'10:10',enrollment_id:87}),
 asg({id:3,name:'',series:'Tarea',number:1,kind:'homework',due_on:'2026-10-27',enrollment_id:115}),
 asg({id:4,name:'Practical 2 (Section 1)',kind:'exam',due_on:'2026-10-28',due_time:'10:10',duration_min:75,enrollment_id:110}),
 asg({id:5,name:'Unknown kind',kind:'mystery',due_on:'2026-10-29',enrollment_id:86}),
];
// Weeks that cover a break, both 7-week halves, and the end of instruction.
const STARTS=['2026-10-05T16:00:00Z','2026-10-12T16:00:00Z','2026-10-26T16:00:00Z','2026-11-23T16:00:00Z','2026-11-30T16:00:00Z','2026-12-07T16:00:00Z'];
const key=s=>`${s.code}|${s.day}|${s.start}|${s.end}|${s.color}`;
const feedSessions=f=>f.events.map(ev=>({code:ev.code,day:ev.startISO&&new Date(ev.startISO).toLocaleDateString('en-CA',{timeZone:'America/New_York'}),
 start:new Date(ev.startISO).toLocaleTimeString('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'}),
 end:new Date(ev.endISO).toLocaleTimeString('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'}),color:ev.color,role:ev.role}));

test('feed sessions match the app schedule (TA sessions may only be fewer)',async()=>{
 const app=await bootApp({terms:TERMS,enrollments:ENR,assignments:ASG,acal:ACAL});
 try{
  assert.deepEqual(app.errors,[]);
  for(const now of STARTS){
   const f=buildFeed({now:new Date(now),assignments:[],enrollments:ENR,terms:TERMS,academic:{events:ACAL,ok:true,fetchedAt:null}});
   const day0=now.slice(0,10),days=Array.from({length:8},(_,i)=>addDays(day0,i));
   const isWeekday=d=>{const g=new Date(d+'T12:00:00Z').getUTCDay();return g>0&&g<6;};
   const a=appSessions(app,TERMS[0],days),b=feedSessions(f).filter(s=>isWeekday(s.day));
   const nonTA=x=>x.role==='course';
   assert.deepEqual(b.filter(nonTA).map(key).sort(),a.filter(nonTA).map(key).sort(),`class sessions differ for the week of ${day0}`);
   const appTA=new Set(a.filter(s=>!nonTA(s)).map(key));
   for(const s of b.filter(s=>!nonTA(s)))assert.ok(appTA.has(key(s)),`feed shows a TA session the app doesn't: ${key(s)}`);
  }
 }finally{app.close();}
});

test('feed deadlines match the app: title, kind label, assessment flag, color, date',async()=>{
 const app=await bootApp({terms:TERMS,enrollments:ENR,assignments:ASG,acal:ACAL});
 try{
  const f=buildFeed({now:new Date('2026-10-22T16:00:00Z'),assignments:ASG,enrollments:ENR,terms:TERMS,academic:{events:ACAL,ok:true,fetchedAt:null}});
  for(const a of ASG){
   const d=f.deadlines.find(x=>x.id===a.id),want=appDeadline(app,a);
   assert.deepEqual({title:d.title,kindLabel:d.kindLabel,assessment:d.assessment,color:d.color,dueDate:d.dueDate},want,`item ${a.id}`);
  }
 }finally{app.close();}
});
