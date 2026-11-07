// A term's last day of classes comes from the registrar's calendar: Spring 2027 words it on one line with the
// second 7-week session, and winter session's last day can fall inside a spring term's dates.
import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootApp} from './app-harness.mjs';
import {termAcademics} from '../supabase/functions/_shared/acal.ts';

const ev=(date,month,title)=>({date,month,time:'All Day',title});
const EVENTS=[
 ev('Aug 24','August 2026','Fall 2026: Fall term begins: First-year writing seminar, project session full, regular, and 7 week 1 session instruction begins'),
 ev('Oct 9','October 2026','Fall 2026: Last day of instruction for classes in 7 week 1 session'),
 ev('Oct 14','October 2026','Fall 2026: 7 week 2 session instruction begins'),
 ev('Dec 4','December 2026','Fall 2026: Last day of instruction for classes in 7 week 2 session'),
 ev('Dec 7','December 2026','Fall 2026: Last day of instruction for classes in first-year writing seminar, project session full, and regular session'),
 ev('Jan 4','January 2027','Winter 2027: Winter session instruction begins'),
 ev('Jan 23','January 2027','Winter 2027: Last day of instruction for classes in winter session'),
 ev('Jan 25','January 2027','Spring 2027: Spring term begins: First-year writing seminar, project session full, regular, and 7 week 1 session instruction begins'),
 ev('Mar 16','March 2027','Spring 2027: Last day of instruction for classes in 7 week 1 session'),
 ev('Mar 17','March 2027','Spring 2027: 7 week 2 session instruction begins'),
 ev('May 11','May 2027','Spring 2027: Last day of instruction for classes in first year writing, project session full, regular and 7 week 2 session'),
];
const CASES=[
 ['spring, one line for regular and the second half',{starts_on:'2027-01-25',ends_on:'2027-05-15'},{classEnd:'2027-05-11',half1End:'2027-03-16',half2Start:'2027-03-17',half2End:'2027-05-11'}],
 ['spring dates that overlap the end of winter session',{starts_on:'2027-01-21',ends_on:'2027-05-15'},{classEnd:'2027-05-11',half1End:'2027-03-16',half2Start:'2027-03-17',half2End:'2027-05-11'}],
 ['fall, separate lines',{starts_on:'2026-08-24',ends_on:'2026-12-18'},{classEnd:'2026-12-07',half1End:'2026-10-09',half2Start:'2026-10-14',half2End:'2026-12-04'}],
 ['winter keeps its own last day',{starts_on:'2026-12-28',ends_on:'2027-01-23'},{classEnd:'2027-01-23',half1End:null,half2Start:null,half2End:null}],
];
const iso=d=>d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:null;

for(const [name,dates,want] of CASES){
 test(`server: ${name}`,()=>{
  const a=termAcademics(EVENTS,dates.starts_on,dates.ends_on);
  assert.deepEqual({classEnd:a.classEnd,half1End:a.half1End,half2Start:a.half2Start,half2End:a.half2End},want);
 });
 test(`app: ${name}`,async()=>{
  const term={id:'t',name:'Term',...dates,sort:1};
  const app=await bootApp({terms:[term],enrollments:[]});
  try{
   app.w.localStorage.setItem('carn_acal',JSON.stringify({v:1,at:Date.now(),events:EVENTS}));
   const a=app.get('termAcademics')(term);
   assert.deepEqual({classEnd:iso(a.classEnd),half1End:iso(a.half1End),half2Start:iso(a.half2Start),half2End:iso(a.half2End)},want);
  }finally{app.close();}
 });
}
