// Live parity check: does the TV feed state the same facts as the app, for real data?
// Read-only. Run before every deploy of wall, carnelian, or carnelian-canvas:
//
//   node scripts/wall-parity.mjs snapshot.json [days=14] [now=ISO]
//
// snapshot.json is { terms, enrollments, assignments, academic } from this query
// (Supabase SQL editor or the Supabase MCP), saved as-is:
//
//   select json_build_object(
//     'terms', (select json_agg(t) from (select id, starts_on::text, ends_on::text from carnelian.terms) t),
//     'enrollments', (select json_agg(e) from (select id, code, title, meetings, term_id, status, role from carnelian.enrollments) e),
//     'assignments', (select json_agg(a) from (select id, name, override_title, series, number, descriptor, kind,
//        due_on::text, due_time::text, duration_min::float8, target_on::text, target_time::text, status, source,
//        canvas_url, enrollment_id from carnelian.assignments where done = false and canvas_removed_at is null
//        and due_on >= (now() at time zone 'America/New_York')::date) a),
//     'academic', (select events from carnelian.academic_cache where id = 1));
//
// It prints every difference in class sessions (code, day, time, color) and in
// deadlines (title, kind, assessment flag, course color, date, placement, time,
// TBA), and
// exits 1 when there is any.
import {readFileSync} from 'node:fs';
import {bootApp,appSessions,appDeadline} from '../tests/app-harness.mjs';
import {buildFeed} from '../supabase/functions/wall/feed.ts';
import {addDays} from '../supabase/functions/_shared/acal.ts';

const [file,daysArg='14',nowArg]=process.argv.slice(2);
if(!file){console.error('usage: node scripts/wall-parity.mjs snapshot.json [days] [now]');process.exit(2);}
const snap=JSON.parse(readFileSync(file,'utf8'));
const now=nowArg?new Date(nowArg):new Date(),N=+daysArg;
const acal=snap.academic||[];
const etDay=iso=>new Date(iso).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const etTime=iso=>new Date(iso).toLocaleTimeString('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});
const isWeekday=d=>{const g=new Date(d+'T12:00:00Z').getUTCDay();return g>0&&g<6;};

const diffs=[];
const app=await bootApp({terms:snap.terms,enrollments:snap.enrollments,assignments:snap.assignments,acal});
try{
 if(app.errors.length)diffs.push(`app reported ${app.errors.length} script error(s): ${app.errors[0]}`);
 // Sessions, one 8-day feed window at a time, against the app's grid (weekdays only).
 const today=now.toLocaleDateString('en-CA',{timeZone:'America/New_York'});
 for(let off=0;off<N;off+=8){
  const day0=addDays(today,off),days=Array.from({length:Math.min(8,N-off)},(_,i)=>addDays(day0,i));
  const f=buildFeed({now:new Date(day0+'T16:00:00Z'),assignments:[],enrollments:snap.enrollments,terms:snap.terms,academic:{events:acal,ok:true,fetchedAt:null}});
  const fs=f.events.filter(ev=>days.includes(etDay(ev.startISO))&&isWeekday(etDay(ev.startISO)))
   .map(ev=>({code:ev.code,day:etDay(ev.startISO),start:etTime(ev.startISO),end:etTime(ev.endISO),color:ev.color,role:ev.role}));
  const terms=[...new Set(snap.enrollments.map(e=>e.term_id))].map(id=>snap.terms.find(t=>t.id===id)).filter(t=>t&&t.starts_on);
  const as=terms.flatMap(t=>appSessions(app,t,days));
  const key=s=>`${s.day} ${s.start}-${s.end} ${s.code} ${s.color}`;
  const A=new Set(as.map(key)),F=new Set(fs.map(key));
  for(const s of as)if(!F.has(key(s))&&s.role==='course')diffs.push(`session in the app only: ${key(s)}`);
  for(const s of fs)if(!A.has(key(s)))diffs.push(`session in the feed only: ${key(s)}`);
 }
 // Deadlines.
 const f=buildFeed({now,assignments:snap.assignments,enrollments:snap.enrollments,terms:snap.terms,academic:{events:acal,ok:true,fetchedAt:null}});
 for(const a of snap.assignments){
  const d=f.deadlines.find(x=>x.id===a.id),want=appDeadline(app,a);
  if(!d){diffs.push(`deadline ${a.id} missing from the feed`);continue;}
  const got={title:d.title,kindLabel:d.kindLabel,assessment:d.assessment,color:d.color,dueDate:d.dueDate,
   placedOn:!d.assessment&&d.workByISO?etDay(d.workByISO):d.dueDate,time:d.timeTBA?null:etTime(d.dueISO),tba:d.timeTBA};
  for(const k of Object.keys(want))if(JSON.stringify(got[k])!==JSON.stringify(want[k]))
   diffs.push(`deadline ${a.id} "${want.title}": ${k} app=${JSON.stringify(want[k])} feed=${JSON.stringify(got[k])}`);
 }
 console.log(`Checked ${snap.assignments.length} deadlines and ${N} days of sessions from ${today}.`);
}finally{app.close();}
if(diffs.length){console.log(`${diffs.length} difference(s):`);for(const d of diffs)console.log('  '+d);process.exit(1);}
console.log('No differences.');
