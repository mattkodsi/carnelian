import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM,VirtualConsole} from 'jsdom';
test('authenticated Carnelian boots and shows its schedule with a synthetic course',async()=>{
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://carnelian.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});const w=dom.window;
 try {
 w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.localStorage.setItem('carn_token','synthetic-token');
 const data={terms:[{id:'fa26',name:'Fall 2026',career:'undergrad',starts_on:'2026-08-24',ends_on:'2099-12-20',sort:1}],programs:[],requirements:[],requirement_options:[],enrollments:[{id:1,code:'TEST 1000',title:'Test Course',credits:3,term_id:'fa26',status:'in_progress',tags:[],meetings:[{days:['M'],start:'09:00',end:'10:00',location:'Test Room'}]}],adjustments:[],assignments:[
  {id:11,enrollment_id:1,name:'My Memo',due_on:'2099-09-15',due_time:'08:00',target_on:'2099-09-14',target_time:'23:59',status:'active',source:'canvas',done:false,canvas_title:'Memo — revised',canvas_changed_at:'2099-09-01T12:00:00Z',canvas_changes:{title:{from:'Memo',to:'Memo — revised'},due_on:{from:'2099-09-14',to:'2099-09-15'}}},
  {id:12,enrollment_id:1,name:'Old Quiz',due_on:'2099-09-18',due_time:'10:00',status:'active',source:'canvas',done:false,canvas_title:'Old Quiz',canvas_removed_at:'2099-09-02T12:00:00Z',canvas_changed_at:'2099-09-02T12:00:00Z',canvas_changes:{removed:{from:false,to:true}}}
 ],satisfactions:[],settings:{}};
 const calls=[];w.fetch=async(url,options={})=>{if(!options.body)return {ok:true,json:async()=>({status:'success',data:{rosters:[],subjects:[],classes:[]}})};const b=JSON.parse(options.body);calls.push(b.action);const result=b.action==='status'?{initialized:true}:b.action==='load'?{data}:b.action==='gcal_status'?{connected:false}:b.action==='canvas_status'?{configured:true,pending_canvas:0,unassigned_canvas:[{ext_uid:'assignment-u1',canvas_title:'Program survey',canvas_due_on:'2099-09-16',canvas_due_time:'12:00',canvas_course_keys:['CUSUSTAIN26']}]}:{ok:true};return {ok:true,status:200,json:async()=>result};};
 for(const script of [...w.document.querySelectorAll('script')])if(!script.src&&script.textContent.trim())w.eval(script.textContent);
 await new Promise(r=>setTimeout(r,120));
 assert.ok(calls.includes('load'));assert.equal(w.document.getElementById('app').style.display,'grid');assert.match(w.document.getElementById('schedule').textContent,/TEST 1000|Test Course/);
 w.eval('showPage("academic")');
 const agenda=w.document.getElementById('academic').textContent;
 assert.match(agenda,/Canvas changed/);assert.match(agenda,/Removed from Canvas/);assert.match(agenda,/Unassigned from Canvas/);assert.match(agenda,/Program survey/);assert.deepEqual(errors,[]);
 w.eval('openCanvasFile("assignment-u1")');
 assert.match(w.document.getElementById('canvasFileSource').textContent,/Program survey/);
 assert.match(w.document.getElementById('canvasFileCourse').textContent,/TEST 1000/);
 }finally{w.close();}
});
