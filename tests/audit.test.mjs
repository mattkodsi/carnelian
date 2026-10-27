import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import * as ical from '../supabase/functions/carnelian-canvas/ical.ts';
import * as reconcile from '../supabase/functions/carnelian-canvas/reconcile.ts';
import * as acal from '../supabase/functions/_shared/acal.ts';
import * as courses from '../supabase/functions/_shared/courses.ts';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function run(code,ctx={}) { const c=vm.createContext({console,Date,Intl,TextEncoder,Response,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,crypto,...ctx});vm.runInContext(code,c);return c; }
function backend(name,sql,ctx={}) {let s=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\n/gm,'');return run(stripTypeScriptTypes(s),{postgres:()=>sql,Deno:{env:{get:()=>''},serve:()=>{}},...ical,...reconcile,...acal,...courses,...ctx});}
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
for(const status of [429,500,403])test(`Google ${status} rejects PATCH`,async()=>{const c=backend('carnelian',()=>[],{fetch:async()=>new Response('{}',{status})});await assert.rejects(c.gapi('x','PATCH','/events/a'));});
for(const layer of ['syncAll','syncAcademic','syncDeadlines'])test(`${layer} retains failed DELETE tracking`,async()=>{
 let removed=false;const sql=async(strings)=>{const q=strings.join('?');if(q.startsWith('delete from carnelian.gcal'))removed=true;if(q.includes('event_id, sig from'))return [{enrollment_id:1,mkey:'0',akey:'a',dkey:'1',event_id:'e',sig:'old'}];return [];};
 const c=backend('carnelian',sql,{fetch:async()=>new Response('{}',{status:500})}); c.fetchAcademic=async()=>[];
 try{await c[layer]('x','cal');}catch{} assert.equal(removed,false);
});
test("a course's cancelled class comes off its Google series and gets an all-day notice",async()=>{
 const en={id:86,code:'REAL 6101',title:'Urban Economics',term_id:'by1fa',starts_on:'2026-08-24',ends_on:'2026-12-18',
  meetings:[{days:['T','R'],start:'08:40',end:'09:55',part:'full'}],no_class:[{date:'2026-11-05',reason:'CREC conference'},{date:'2026-11-04',reason:'not a class day'}]};
 const posted=[];const sql=async(strings)=>{const q=strings.join('?');return q.includes('from carnelian.enrollments e')?[en]:[];};
 const c=backend('carnelian',sql,{fetch:async(url,o)=>{if(o&&o.method==='POST')posted.push(JSON.parse(o.body));return new Response(JSON.stringify({id:'ev'+posted.length}),{status:200});}});
 c.fetchAcademic=async()=>[];
 await c.syncAll('x','cal');
 const series=posted.find(b=>b.recurrence);
 assert.match(series.recurrence.join('\n'),/EXDATE;TZID=America\/New_York:20261105T084000$/m);
 const notices=posted.filter(b=>b.start.date);
 assert.deepEqual(notices.map(b=>[b.summary,b.start.date,b.end.date,b.transparency]),[['No REAL 6101 class (CREC conference)','2026-11-05','2026-11-06','transparent']]);
});
test('Google deadlines give Matt his extra time on exams and quizzes, but not on a TA course or his own slot',async()=>{
 const rows=[
  {id:1,enrollment_id:86,name:'Quiz 3',kind:'quiz',due_on:'2026-10-27',due_time:'09:25:00',duration_min:30,extra_time:null,code:'REAL 6101',role:null},
  {id:2,enrollment_id:110,name:'Practical 2',kind:'exam',due_on:'2026-10-28',due_time:'10:10:00',duration_min:75,extra_time:null,code:'HADM 6205',role:'ta_paid'},
  {id:3,enrollment_id:86,name:'Midterm Exam',kind:'exam',due_on:'2026-10-08',due_time:'08:00:00',duration_min:115,extra_time:false,code:'REAL 6101',role:null},
  {id:5,enrollment_id:86,name:'Final Exam',kind:'exam',due_on:'2026-12-17',due_time:'09:00:00',duration_min:75,extra_time:null,code:'REAL 6101',role:null},
  {id:4,enrollment_id:86,name:'Poster Session',kind:'presentation',due_on:'2026-12-03',due_time:'08:40:00',duration_min:65,extra_time:null,code:'REAL 6101',role:null}];
 const sql=async(strings)=>{const q=strings.join('?');return q.includes('from carnelian.assignments a')?rows:q.includes('carnelian.app_config')?[{settings:{extra_time:1.5}}]:[];};
 const posted=[];const c=backend('carnelian',sql,{fetch:async(url,o)=>{if(o&&o.method==='POST')posted.push(JSON.parse(o.body));return new Response(JSON.stringify({id:'ev'+posted.length}),{status:200});}});
 await c.syncDeadlines('x','cal');
 assert.deepEqual(posted.map(b=>[b.summary,b.start.dateTime,b.end.dateTime]),[
  ['Quiz 3 (REAL 6101)','2026-10-27T09:25:00','2026-10-27T10:10:00'],
  ['Practical 2 (HADM 6205)','2026-10-28T10:10:00','2026-10-28T11:25:00'],
  ['Midterm Exam (REAL 6101)','2026-10-08T08:00:00','2026-10-08T09:55:00'],
  ['Final Exam (REAL 6101)','2026-12-17T09:00:00','2026-12-17T10:52:00'],
  ['Poster Session (REAL 6101)','2026-12-03T08:40:00','2026-12-03T09:45:00']]);
});
test('Google absent PATCH and DELETE remain recoverable',async()=>{for(const status of [404,410]){const c=backend('carnelian',()=>[],{fetch:async()=>new Response('{}',{status})});assert.equal((await c.gapi('x','PATCH','/events/a')).status,status);assert.equal((await c.gapi('x','DELETE','/events/a')).status,status);}});
const settle=()=>new Promise(r=>setImmediate(r));
test('edits arriving during sync coalesce into one subsequent sync',async()=>{let calls=0,release;const c=run(slice('let GSYNC=false;','/* ---- Canvas deadline sync'),{GCAL:{connected:true},api:()=>{calls++;return new Promise(r=>release=r)},gcalRefresh:()=>{},CUR:'',toast:()=>{}});c.gcalAutoSync();c.gcalAutoSync();c.gcalAutoSync();await settle();assert.equal(calls,1);release({ok:true});await settle();assert.equal(calls,2);release({ok:true});await settle();assert.equal(calls,2);});
test('assignment save and deletion request calendar reconciliation after persistence',async()=>{let count=0;const c=run(slice('async function saveAsg(row)','function openCourseAssignments'),{DB:{assignments:[]},api:async(action,p)=>({row:{...p.row,id:1}}),CUR:'',gcalAutoSync:()=>count++,renderAsgList:()=>{},toast:()=>{},asgCanvasDone:()=>false});await c.saveAsg({name:'A'});assert.equal(count,1);await c.approveAsg({id:1});assert.equal(count,2);await c.toggleAsgDone({id:1,done:false});assert.equal(count,3);await c.deleteAsg(1);assert.equal(count,4);});
test('today uses Eastern calendar date across winter and summer midnight',()=>{for(const stamp of ['2026-09-06T02:00:00Z','2026-01-06T03:00:00Z']){class FixedDate extends Date{constructor(...a){super(...(a.length?a:[stamp]));}}const c=run(slice('const today=','const termById'),{Date:FixedDate});assert.equal(vm.runInContext('today()',c),stamp.startsWith('2026-09')?'2026-09-05':'2026-01-05');}});
test('F contributes no earned or planned credit, requirement coverage, or course count; GPA retains F',()=>{
 const failed={id:1,code:'TEST 6000',credits:3,grade:'F',status:'completed',counts_gpa:true,in_as:true,term_id:1};const req={id:'r',program_id:'baker-mps',spec:{need:{type:'credits',n:3},match:{codes:['TEST 6000']}}};
 const c=run(slice('const today=','// progress is CREDIT-WEIGHTED'),{DB:{terms:[{id:1,career:'undergrad'}],enrollments:[failed],requirements:[req],satisfactions:[{requirement_id:'r',enrollment_id:1}]},num:Number,GRADE_POINTS:{F:0},BAKER_VIEW:'standard'});
 assert.equal(c.creditsScope('as'),0);assert.equal(c.reqProgress(req).done,0);assert.equal(c.reqProgress(req).planned,0);assert.equal(c.bakerCredits().earned,0);assert.equal(c.bakerCredits().planned,0);assert.equal(c.reqProgress({...req,spec:{need:{type:'credits',n:3},match:{scope:'as'}}}).done,0);assert.equal(c.reqProgress({...req,spec:{need:{type:'courses',n:1}}}).planned,0);assert.equal(c.gpa('undergrad').credits,3);assert.equal(c.gpa('undergrad').gpa,0);
});
for(const rejected of [false,true])test(rejected?'rejected Canvas UID cannot reimport':'Canvas same-day time changes update existing deadline',async()=>{let updates=0,inserts=0;const sql=(strings)=>{if(!Array.isArray(strings)||!strings.raw)return strings;const q=strings.join('?');if(q.includes('from carnelian.canvas_config'))return [{feed_url:'https://example.test/feed'}];if(q.includes('from carnelian.enrollments'))return [{id:1,code:'REAL 6640'}];if(q.includes('from carnelian.canvas_rejections'))return rejected?[{ext_uid:'assignment-1'}]:[];if(q.includes('from carnelian.assignments'))return rejected?[]:[{id:2,enrollment_id:1,ext_uid:'assignment-1',due_on:'2099-09-08',due_time:'10:00:00',source:'canvas'}];if(q.startsWith('update carnelian.assignments'))updates++;if(q.startsWith('insert into carnelian.assignments'))inserts++;return [];};sql.json=x=>x;
 const feed='BEGIN:VEVENT\nUID:assignment-1\nDTSTART;TZID=America/New_York:20990908T113000\nSUMMARY:Homework [FA99-REAL-6640-001]\nEND:VEVENT';const c=backend('carnelian-canvas',sql,{fetch:async()=>new Response(feed)});await c.canvasSync();if(rejected)assert.equal(inserts,0);else assert.equal(updates,1);
});
// A Canvas item matching an item added by hand (same course, date, and title) links to it instead of adding a copy.
for(const [label,hand,links] of [
 ['links to the hand-added item',{due_on:'2099-10-27',name:'Tarea 1'},true],
 ['matches the custom title too',{due_on:'2099-10-27',name:'Homework',override_title:'tarea 1'},true],
 ['leaves a hand-added item on another date alone',{due_on:'2099-10-28',name:'Tarea 1'},false],
 ['leaves a hand-added item with another title alone',{due_on:'2099-10-27',name:'Tarea 2'},false],
])test(`Canvas import ${label}`,async()=>{
 const updates=[],inserts=[];
 const sql=(strings,...vals)=>{if(!Array.isArray(strings)||!strings.raw)return strings;const q=strings.join('?');
  if(q.includes('from carnelian.canvas_config'))return [{feed_url:'https://example.test/feed'}];
  if(q.includes('from carnelian.enrollments'))return [{id:1,code:'SPAN 1502'}];
  if(q.includes('from carnelian.canvas_rejections')||q.includes('from carnelian.canvas_unassigned'))return [];
  if(q.includes('from carnelian.assignments'))return [{id:152,enrollment_id:1,override_title:null,due_time:'10:10:00',source:'manual',ext_uid:null,...hand}];
  if(q.startsWith('update carnelian.assignments'))updates.push({q,vals});
  if(q.startsWith('insert into carnelian.assignments'))inserts.push({q,vals});
  return [];};sql.json=x=>x;
 const feed='BEGIN:VEVENT\nUID:event-assignment-1030283\nDTSTART;TZID=America/New_York:20991027T100000\nSUMMARY:Tarea 1 [FA99-SPAN-1502-101]\nEND:VEVENT';
 const c=backend('carnelian-canvas',sql,{fetch:async()=>new Response(feed)});
 const r=await c.canvasSync();
 if(links){
  assert.equal(inserts.length,0);assert.equal(r.adopted,1);
  const u=updates.find(x=>x.q.includes("source = 'canvas', ext_uid"));
  assert.ok(u,'the hand-added row is linked');
  assert.equal(u.vals[0],'event-assignment-1030283');assert.equal(u.vals[1],'10:00');assert.equal(u.vals.at(-1),152);
 }else{assert.equal(inserts.length,1);assert.equal(r.adopted,0);assert.equal(updates.length,0);}
});
test('one hand-added item links to only one Canvas item',async()=>{
 const linked=[],inserts=[];
 const sql=(strings,...vals)=>{if(!Array.isArray(strings)||!strings.raw)return strings;const q=strings.join('?');
  if(q.includes('from carnelian.canvas_config'))return [{feed_url:'https://example.test/feed'}];
  if(q.includes('from carnelian.enrollments'))return [{id:1,code:'SPAN 1502'}];
  if(q.includes('from carnelian.canvas_rejections')||q.includes('from carnelian.canvas_unassigned'))return [];
  if(q.includes('from carnelian.assignments'))return [{id:152,enrollment_id:1,name:'Tarea 1',override_title:null,due_on:'2099-10-27',due_time:'10:10:00',source:'manual',ext_uid:null}];
  if(q.startsWith('update carnelian.assignments')&&q.includes("source = 'canvas', ext_uid"))linked.push(vals[0]);
  if(q.startsWith('insert into carnelian.assignments'))inserts.push(vals);
  return [];};sql.json=x=>x;
 const ev=n=>`BEGIN:VEVENT\nUID:event-assignment-${n}\nDTSTART;TZID=America/New_York:20991027T100000\nSUMMARY:Tarea 1 [FA99-SPAN-1502-101]\nEND:VEVENT`;
 const c=backend('carnelian-canvas',sql,{fetch:async()=>new Response(ev(1)+'\n'+ev(2))});
 await c.canvasSync();
 assert.deepEqual(linked,['event-assignment-1']);assert.equal(inserts.length,1);
});
for(const action of ['gcal_academic_toggle','gcal_deadlines_toggle','gcal_disconnect'])test(`${action} preserves calendar identifiers when Google deletion fails`,async()=>{
  let handler,forgot=false;
  const sql=async(strings)=>{const q=strings.join('?');if(q.startsWith('delete from carnelian.gcal_')||q.includes('calendar_academic = null')||q.includes('calendar_deadlines = null'))forgot=true;if(q.includes('from carnelian.gcal_config'))return [{refresh_token:'token',calendar_id:'classes',calendar_academic:'academic',calendar_deadlines:'deadlines'}];return [];};
  const c=backend('carnelian',sql,{Deno:{env:{get:()=>''},serve:h=>handler=h},fetch:async()=>new Response('{}',{status:500})});
  c.authed=async()=>true;c.accessToken=async()=>'access';
  const response=await handler(new Request('https://example.test',{method:'POST',body:JSON.stringify({action,enabled:false,token:'session'})}));
  assert.equal(forgot,false);assert.equal(response.status,500);
});
test('a failed undergrad course mapped to Baker still lowers graduate GPA',()=>{
  const failed={id:1,code:'TEST 6000',credits:3,grade:'F',status:'completed',counts_gpa:true,term_id:1};
  const req={id:'r',program_id:'baker-mps',spec:{need:{type:'courses',n:1},match:{codes:['TEST 6000']}}};
  const c=run(slice('const today=','// progress is CREDIT-WEIGHTED'),{DB:{terms:[{id:1,career:'undergrad'}],enrollments:[failed],requirements:[req],satisfactions:[]},num:Number,GRADE_POINTS:{F:0},BAKER_VIEW:'standard'});
  assert.equal(c.gpa('grad').credits,3);assert.equal(c.gpa('grad').gpa,0);assert.equal(c.reqProgress(req).done,0);assert.equal(c.reqProgress(req).fut,0);
});
test('queued edits still sync after the current request fails',async()=>{
  let calls=0,reject,resolve;
  const c=run(slice('let GSYNC=false;','/* ---- Canvas deadline sync'),{GCAL:{connected:true},api:()=>{calls++;return new Promise((r,j)=>{resolve=r;reject=j})},gcalRefresh:()=>{},CUR:'',toast:()=>{}});
  c.gcalAutoSync();c.gcalAutoSync();await settle();reject(new Error('offline'));await settle();assert.equal(calls,2);resolve({ok:true});await settle();assert.equal(calls,2);
});
test('frontend script parses as a whole',()=>{new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);});
function calendarUi(api){
  const nodes=new Map(); const messages=[];
  const $=key=>{if(!nodes.has(key))nodes.set(key,{classList:{toggle(){}},textContent:'',disabled:false});return nodes.get(key);};
  const c=run(slice('let GSYNC=false;','/* ---- Canvas deadline sync')+slice('function renderGcalModal(){','$("#gcalClose")'),{
    GCAL:{connected:true,email:'student@example.test',count:2,syncAcademic:true,academicCount:1,syncDeadlines:true,deadlineCount:3},
    api,$,gcalRefresh:async()=>{},CUR:'',esc:x=>x,toast:x=>messages.push(x),armDel:(_,fn)=>fn(),renderSchedule(){},closeModal(){},gcalConnect(){}
  });
  c.renderGcalModal();return {c,nodes,messages};
}
test('disconnect reconnect response keeps local connection data and reports reconnect',async()=>{
  const {c,nodes,messages}=calendarUi(async()=>({ok:false,reconnect:true,error:'reauth'}));
  await nodes.get('#gcDisc').onclick();
  assert.equal(c.GCAL.connected,true);assert.equal(c.GCAL.email,'student@example.test');
  assert.equal(messages.includes('Disconnected'),false);assert.match(messages.at(-1),/Reconnect/i);
  assert.match(nodes.get('#gcalBody').innerHTML,/Reconnect Google Calendar/);
});
for(const button of ['#gcSync','#gcAcad','#gcDead','#gcDisc'])test(`${button} cannot overlap an automatic sync`,async()=>{
  const pending=[];const calls=[];
  const {c,nodes}=calendarUi(action=>{calls.push(action);return new Promise(resolve=>pending.push(resolve));});
  c.gcalAutoSync();await settle();const manual=nodes.get(button).onclick();await settle();
  assert.equal(calls.length,1);
  pending.shift()({ok:true});await settle();assert.equal(calls.length,2);
  pending.shift()({ok:true});await manual;await settle();assert.equal(calls.length,2);
});
test('OAuth return sync shares the automatic/manual mutation queue',async()=>{
  const calls=[],pending=[];
  const c=run(slice('let GSYNC=false;','/* ---- Canvas deadline sync')+slice('function handleGcalReturn(){','async function gcalConnect(){'),{
    GCAL:{connected:true},api:action=>{calls.push(action);return new Promise(resolve=>pending.push(resolve));},
    gcalRefresh:async()=>{},toast(){},location:{search:'?gcal=connected',pathname:'/'},history:{replaceState(){}}
  });
  c.gcalAutoSync();await settle();c.handleGcalReturn();await settle();assert.equal(calls.length,1);
  pending.shift()({ok:true});await settle();assert.equal(calls.length,2);
  pending.shift()({ok:true});await settle();assert.equal(calls.length,2);
});
