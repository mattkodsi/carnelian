// Reports Canvas submissions and check-offs to Carnelian. Runs on the Mac mini every
// 10 minutes (scripts/com.matt.carnelian-checkoffs.plist), because only the signed-in
// canvas-agent can read Canvas's planner; the calendar feed has no submission state.
//
//   node scripts/canvas-checkoffs.mjs            # report
//   node scripts/canvas-checkoffs.mjs --dry-run  # print what it would report
//
// The job's secret lives in ~/.config/carnelian/checkoffs.json ({"secret": "..."},
// mode 600) and matches carnelian.canvas_config.completion_secret.
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {promisify} from 'node:util';

const CANVAS_AGENT='/Users/matt/dev/Education/canvas-agent';
const FN='https://uhwdnmbxiopfysodydty.supabase.co/functions/v1/carnelian-canvas';
const BACK_DAYS=14, AHEAD_DAYS=120;
const dryRun=process.argv.includes('--dry-run');
const stamp=()=>new Date().toISOString();

const etDay=offset=>new Date(Date.now()+offset*86400000).toLocaleDateString('en-CA',{timeZone:'America/New_York'});

// Canvas's planner item → the assignment id Carnelian links by. Quizzes and graded
// discussions carry it on the plannable; plain assignments are the plannable.
function assignmentId(item){
  if(item.plannable_type==='assignment')return item.plannable_id;
  return item.plannable?.assignment_id ?? null;
}

async function post(body){
  const secret=JSON.parse(readFileSync(`${homedir()}/.config/carnelian/checkoffs.json`,'utf8')).secret;
  const res=await fetch(FN,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({action:'canvas_completion',completion_secret:secret,...body}),signal:AbortSignal.timeout(30000)});
  const out=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(`Carnelian returned ${res.status}: ${out.error||''}`);
  return out;
}

const start=etDay(-BACK_DAYS), end=etDay(AHEAD_DAYS);
let items;
try{
  // CANVAS_NO_PUSH: this job runs unattended, so it must never make Duo send a push.
  // When Duo is needed, canvas-agent fails with a plain message instead; its evening
  // sign-in (or a chat) handles Duo at a reasonable hour.
  const {stdout}=await promisify(execFile)(`${CANVAS_AGENT}/canvas`,['api',`/planner/items?start_date=${start}&end_date=${end}&per_page=100`],
    {cwd:CANVAS_AGENT,timeout:240000,maxBuffer:32*1024*1024,env:{...process.env,CANVAS_NO_PUSH:'1'}});
  items=JSON.parse(stdout);
  if(!Array.isArray(items))throw new Error('Canvas planner did not return a list');
}catch(e){
  // canvas-agent exits with a plain "needs a Duo sign-in" message when Cornell's
  // approval has lapsed; pass it on so Carnelian can show it.
  const message=String(e.stderr||e.message||e).trim().split('\n').pop();
  console.error(stamp(),'Canvas read failed:',message);
  if(!dryRun)await post({error:message}).catch(err=>console.error(stamp(),'Could not report the failure:',err.message));
  process.exit(1);
}

// The planner also lists announcements and calendar events; only assignments
// (including quizzes and graded discussions) carry an assignment id.
const report=items.filter(it=>assignmentId(it)!=null)
  .map(it=>({assignmentId:assignmentId(it),submitted:!!it.submissions?.submitted,markedComplete:!!it.planner_override?.marked_complete}));
if(dryRun){
  console.log(`${report.length} assignments of ${items.length} planner items from ${start} to ${end}; ${report.filter(r=>r.submitted).length} submitted, ${report.filter(r=>r.markedComplete).length} checked off.`);
  for(const it of items)if(assignmentId(it))console.log(' ',assignmentId(it),it.submissions?.submitted?'submitted':'          ',it.planner_override?.marked_complete?'checked off':'',it.plannable?.title);
  process.exit(0);
}
try{
  const r=await post({items:report,window:{start,end}});
  console.log(stamp(),`Reported ${report.length}; matched ${r.matched}, changed ${r.changed}.`);
}catch(e){console.error(stamp(),e.message);process.exit(1);}
