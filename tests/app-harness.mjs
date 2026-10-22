// Boots Carnelian's real index.html in JSDOM with given data, so tests and the
// parity check can ask the app's own functions what it would show.
import {readFileSync} from 'node:fs';import {JSDOM,VirtualConsole} from 'jsdom';

export async function bootApp({terms,enrollments,assignments=[],acal=[]}){
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://carnelian.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});const w=dom.window;
 w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.localStorage.setItem('carn_token','harness');
 w.localStorage.setItem('carn_acal',JSON.stringify({v:1,events:acal}));
 const data={terms:terms.map(t=>({name:t.id,career:'grad',sort:1,...t})),programs:[],requirements:[],requirement_options:[],
  enrollments:enrollments.map(e=>({credits:1,tags:[],...e})),adjustments:[],assignments,satisfactions:[],settings:{}};
 w.fetch=async(url,options={})=>{if(!options.body)return {ok:true,json:async()=>({status:'success',data:{rosters:[],subjects:[],classes:[]}})};
  const b=JSON.parse(options.body);
  const r=b.action==='status'?{initialized:true}:b.action==='load'?{data}:b.action==='gcal_status'?{connected:false}:b.action==='canvas_status'?{configured:false,pending_canvas:0,unassigned_canvas:[]}:b.action==='academic_calendar'?{ok:true,events:acal}:{ok:true};
  return {ok:true,status:200,json:async()=>r};};
 // Top-level const/let bindings live in each script's own scope, so each script also leaves a
 // getter that resolves a name from inside that scope.
 const getters=[];w.__carnGetters=getters;
 for(const script of [...w.document.querySelectorAll('script')])if(!script.src&&script.textContent.trim())w.eval(script.textContent+'\n;window.__carnGetters.push(n=>eval(n));');
 await new Promise(r=>setTimeout(r,120));
 const get=n=>{for(const g of [...getters].reverse()){try{return g(n);}catch(e){if(!(e instanceof w.ReferenceError))throw e;}}throw new Error('Carnelian has no '+n);};
 return {w,get,errors,close:()=>w.close()};
}

const DOWS={U:0,M:1,T:2,W:3,R:4,F:5,S:6};
// Class sessions exactly as the Schedule grid derives them (weekdays only, as the grid has no weekend).
export function appSessions({get},term,days){
 const ac=get('termAcademics')(term),pdate=get('pdate'),isNoClassDay=get('isNoClassDay'),meetingActiveOn=get('meetingActiveOn'),partOf=get('partOf');
 const DB=get('DB'),SC=get('SCHED_COLORS'),idx=get('agColorMap')(term.id),displayStatus=get('displayStatus');
 const es=DB.enrollments.filter(e=>e.term_id===term.id&&displayStatus(e)!=='wishlist');
 const out=[];
 for(const day of days){const D=pdate(day),dow=D.getDay();if(dow===0||dow===6)continue;
  for(const e of es)for(const m of (e.meetings||[])){
   if(!(m.days||[]).some(d=>DOWS[d]===dow))continue;
   if(isNoClassDay(D,ac)||!meetingActiveOn(partOf(m),D,ac))continue;
   out.push({code:e.code,day,start:m.start,end:m.end,color:SC[idx[e.code||('#'+e.id)]],role:e.role||'course'});}}
 return out;
}

// What the app shows for one assignment: title, kind label, whether it is a timed
// assessment, the course color, and the date it is placed on.
export function appDeadline({get},a){
 const DB=get('DB'),SC=get('SCHED_COLORS');
 const e=DB.enrollments.find(x=>x.id===a.enrollment_id);
 const idx=e?get('agColorMap')(e.term_id):{};
 return {title:get('asgTitle')(a),kindLabel:get('KIND_LABEL')(a.kind),assessment:get('KIND_TIMED')(a.kind),
  color:e?SC[idx[e.code||('#'+e.id)]]:null,dueDate:String(a.due_on).slice(0,10)};
}
