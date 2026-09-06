import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import * as ical from '../supabase/functions/carnelian-canvas/ical.ts';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function run(code,ctx={}) { const c=vm.createContext({console,Date,Intl,TextEncoder,Response,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,crypto,...ctx});vm.runInContext(code,c);return c; }
function backend(name,sql,ctx={}) {let s=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\n/gm,'');return run(stripTypeScriptTypes(s),{postgres:()=>sql,Deno:{env:{get:()=>''},serve:()=>{}},...ical,...ctx});}
const slice=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
for(const status of [429,500,403])test(`Google ${status} rejects PATCH`,async()=>{const c=backend('carnelian',()=>[],{fetch:async()=>new Response('{}',{status})});await assert.rejects(c.gapi('x','PATCH','/events/a'));});
for(const layer of ['syncAll','syncAcademic','syncDeadlines'])test(`${layer} retains failed DELETE tracking`,async()=>{
 let removed=false;const sql=async(strings)=>{const q=strings.join('?');if(q.startsWith('delete from carnelian.gcal'))removed=true;if(q.includes('event_id, sig from'))return [{enrollment_id:1,mkey:'0',akey:'a',dkey:'1',event_id:'e',sig:'old'}];return [];};
 const c=backend('carnelian',sql,{fetch:async()=>new Response('{}',{status:500})}); c.fetchAcademic=async()=>[];
 try{await c[layer]('x','cal');}catch{} assert.equal(removed,false);
});
test('Google absent PATCH and DELETE remain recoverable',async()=>{for(const status of [404,410]){const c=backend('carnelian',()=>[],{fetch:async()=>new Response('{}',{status})});assert.equal((await c.gapi('x','PATCH','/events/a')).status,status);assert.equal((await c.gapi('x','DELETE','/events/a')).status,status);}});
const settle=()=>new Promise(r=>setImmediate(r));
test('edits arriving during sync coalesce into one subsequent sync',async()=>{let calls=0,release;const c=run(slice('let GSYNC=false;','/* ---- Canvas deadline sync'),{GCAL:{connected:true},api:()=>{calls++;return new Promise(r=>release=r)},gcalRefresh:()=>{},CUR:'',toast:()=>{}});c.gcalAutoSync();c.gcalAutoSync();c.gcalAutoSync();await settle();assert.equal(calls,1);release({ok:true});await settle();assert.equal(calls,2);release({ok:true});await settle();assert.equal(calls,2);});
test('assignment save and deletion request calendar reconciliation after persistence',async()=>{let count=0;const c=run(slice('async function saveAsg(row)','function openCourseAssignments'),{DB:{assignments:[]},api:async(action,p)=>({row:{...p.row,id:1}}),CUR:'',gcalAutoSync:()=>count++,renderAsgList:()=>{},toast:()=>{}});await c.saveAsg({name:'A'});assert.equal(count,1);await c.approveAsg({id:1});assert.equal(count,2);await c.toggleAsgDone({id:1,done:false});assert.equal(count,3);await c.deleteAsg(1);assert.equal(count,4);});
test('today uses Eastern calendar date across winter and summer midnight',()=>{for(const stamp of ['2026-09-06T02:00:00Z','2026-01-06T03:00:00Z']){class FixedDate extends Date{constructor(...a){super(...(a.length?a:[stamp]));}}const c=run(slice('const today=','const termById'),{Date:FixedDate});assert.equal(vm.runInContext('today()',c),stamp.startsWith('2026-09')?'2026-09-05':'2026-01-05');}});
test('F contributes no earned or planned credit, requirement coverage, or course count; GPA retains F',()=>{
 const failed={id:1,code:'TEST 6000',credits:3,grade:'F',status:'completed',counts_gpa:true,in_as:true,term_id:1};const req={id:'r',program_id:'baker-mps',spec:{need:{type:'credits',n:3},match:{codes:['TEST 6000']}}};
 const c=run(slice('const today=','// progress is CREDIT-WEIGHTED'),{DB:{terms:[{id:1,career:'undergrad'}],enrollments:[failed],requirements:[req],satisfactions:[{requirement_id:'r',enrollment_id:1}]},num:Number,GRADE_POINTS:{F:0},BAKER_VIEW:'standard'});
 assert.equal(c.creditsScope('as'),0);assert.equal(c.reqProgress(req).done,0);assert.equal(c.reqProgress(req).planned,0);assert.equal(c.bakerCredits().earned,0);assert.equal(c.bakerCredits().planned,0);assert.equal(c.reqProgress({...req,spec:{need:{type:'credits',n:3},match:{scope:'as'}}}).done,0);assert.equal(c.reqProgress({...req,spec:{need:{type:'courses',n:1}}}).planned,0);assert.equal(c.gpa('undergrad').credits,3);assert.equal(c.gpa('undergrad').gpa,0);
});
for(const rejected of [false,true])test(rejected?'rejected Canvas UID cannot reimport':'Canvas same-day time changes update existing deadline',async()=>{let updates=0,inserts=0;const sql=(strings)=>{if(!Array.isArray(strings)||!strings.raw)return strings;const q=strings.join('?');if(q.includes('from carnelian.canvas_config'))return [{feed_url:'https://example.test/feed'}];if(q.includes('from carnelian.enrollments'))return [{id:1,code:'REAL 6640'}];if(q.includes('from carnelian.canvas_rejections'))return rejected?[{ext_uid:'assignment-1'}]:[];if(q.includes('from carnelian.assignments'))return rejected?[]:[{id:2,enrollment_id:1,ext_uid:'assignment-1',due_on:'2099-09-08',due_time:'10:00:00',source:'canvas'}];if(q.startsWith('update carnelian.assignments'))updates++;if(q.startsWith('insert into carnelian.assignments'))inserts++;return [];};sql.json=x=>x;
 const feed='BEGIN:VEVENT\nUID:assignment-1\nDTSTART;TZID=America/New_York:20990908T113000\nSUMMARY:Homework [FA99-REAL-6640-001]\nEND:VEVENT';const c=backend('carnelian-canvas',sql,{fetch:async()=>new Response(feed)});await c.canvasSync();if(rejected)assert.equal(inserts,0);else assert.equal(updates,1);
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
