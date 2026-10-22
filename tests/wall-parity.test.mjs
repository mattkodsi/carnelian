// The TV feed must state the same facts the app shows: same class sessions, same
// titles, kinds, assessment flags, and course colors, for the same data.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootApp,appSessions,appDeadline,appCourseNotices} from './app-harness.mjs';
import {buildFeed} from '../supabase/functions/wall/feed.ts';
import {ACAL,TERMS,ENR,asg} from '../supabase/functions/wall/fixtures.ts';
import {addDays} from '../supabase/functions/_shared/acal.ts';

const ASG=[
 asg({id:1,name:'Quiz 3',kind:'quiz',due_on:'2026-10-27',due_time:'08:40',enrollment_id:86}),
 asg({id:2,name:'Final Case Project: Topic',kind:'project',due_on:'2026-10-26',due_time:'10:10',enrollment_id:87}),
 asg({id:3,name:'',series:'Tarea',number:1,kind:'homework',due_on:'2026-10-27',enrollment_id:115}),
 asg({id:4,name:'Practical 2 (Section 1)',kind:'exam',due_on:'2026-10-28',due_time:'10:10',duration_min:75,enrollment_id:110}),
 asg({id:5,name:'Unknown kind',kind:'mystery',due_on:'2026-10-29',enrollment_id:86}),
 asg({id:6,name:'In-class quiz',kind:'quiz',due_on:'2026-10-27',enrollment_id:86}),
 asg({id:7,name:'Exam with no class that day',kind:'exam',due_on:'2026-10-26',enrollment_id:86}),
 asg({id:8,name:'Pitch after the second half ends',kind:'presentation',due_on:'2026-12-07',enrollment_id:87}),
 asg({id:9,name:'Untimed memo',kind:'assignment',due_on:'2026-10-30',enrollment_id:87}),
 asg({id:10,name:'Exam with a study target',kind:'exam',due_on:'2026-11-12',due_time:'08:40',target_on:'2026-11-09',enrollment_id:86}),
 asg({id:11,name:'Memo with a work-by day',kind:'assignment',due_on:'2026-11-12',target_on:'2026-11-10',target_time:'17:00',enrollment_id:86}),
 asg({id:12,name:'HW 5',kind:'homework',due_on:'2026-10-25',due_time:'23:30',enrollment_id:109}),
 asg({id:13,name:'Exam in my own slot',kind:'exam',due_on:'2026-10-29',due_time:'08:00',duration_min:115,extra_time:false,enrollment_id:86}),
 asg({id:14,name:'Quiz with a length',kind:'quiz',due_on:'2026-11-03',due_time:'09:25',duration_min:30,enrollment_id:86}),
];
const etDate=iso=>new Date(iso).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const etTime=iso=>new Date(iso).toLocaleTimeString('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
// Weeks that cover a break, both 7-week halves, and the end of instruction.
const STARTS=['2026-10-05T16:00:00Z','2026-10-12T16:00:00Z','2026-10-26T16:00:00Z','2026-11-02T16:00:00Z','2026-11-23T16:00:00Z','2026-11-30T16:00:00Z','2026-12-07T16:00:00Z'];
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
   const notices=f.academic.filter(n=>n.course).map(n=>({day:n.startDate,title:n.title}));
   assert.deepEqual(notices,appCourseNotices(app,TERMS[0],days),`cancelled-class notices differ for the week of ${day0}`);
  }
 }finally{app.close();}
});

test('feed deadlines match the app: title, kind, assessment flag, color, date, time, TBA, end with extra time',async()=>{
 for(const extraTime of [null,1.5]){
 const app=await bootApp({terms:TERMS,enrollments:ENR,assignments:ASG,acal:ACAL,settings:{extra_time:extraTime}});
 try{
  const f=buildFeed({now:new Date('2026-10-22T16:00:00Z'),assignments:ASG,enrollments:ENR,terms:TERMS,academic:{events:ACAL,ok:true,fetchedAt:null},extraTime});
  for(const a of ASG){
   const d=f.deadlines.find(x=>x.id===a.id),want=appDeadline(app,a);
   // A TA course's assessments are left off the TV on purpose; its other deadlines stay.
   if(['exam','quiz','presentation'].includes(a.kind)&&ENR.find(e=>e.id===a.enrollment_id).role?.startsWith('ta_')){assert.equal(d,undefined,`item ${a.id}`);continue;}
   assert.deepEqual({title:d.title,kindLabel:d.kindLabel,assessment:d.assessment,color:d.color,dueDate:d.dueDate,
    placedOn:!d.assessment&&d.workByISO?etDate(d.workByISO):d.dueDate,time:d.timeTBA?null:etTime(d.dueISO),tba:d.timeTBA,end:d.endISO?etTime(d.endISO):null},want,`item ${a.id}, extra time ${extraTime}`);
  }
 }finally{app.close();}
 }
});
