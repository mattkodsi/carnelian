import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM,VirtualConsole} from 'jsdom';
test('authenticated Carnelian boots and shows its schedule with a synthetic course',async()=>{
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://carnelian.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});const w=dom.window;
 try {
 w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};w.ResizeObserver=class{observe(){}disconnect(){}};w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.localStorage.setItem('carn_token','synthetic-token');
 const data={terms:[{id:'fa26',name:'Fall 2026',career:'undergrad',starts_on:'2026-08-24',ends_on:'2026-12-20',sort:1}],programs:[],requirements:[],requirement_options:[],enrollments:[{id:1,code:'TEST 1000',title:'Test Course',credits:3,term_id:'fa26',status:'in_progress',tags:[],meetings:[{days:['M'],start:'09:00',end:'10:00',location:'Test Room'}]}],adjustments:[],assignments:[],satisfactions:[],settings:{}};
 const calls=[];w.fetch=async(url,options={})=>{if(!options.body)return {ok:true,json:async()=>({status:'success',data:{rosters:[],subjects:[],classes:[]}})};const b=JSON.parse(options.body);calls.push(b.action);const result=b.action==='status'?{initialized:true}:b.action==='load'?{data}:b.action==='gcal_status'?{connected:false}:{ok:true};return {ok:true,status:200,json:async()=>result};};
 for(const script of [...w.document.querySelectorAll('script')])if(!script.src&&script.textContent.trim())w.eval(script.textContent);
 await new Promise(r=>setTimeout(r,120));
 assert.ok(calls.includes('load'));assert.equal(w.document.getElementById('app').style.display,'grid');assert.match(w.document.getElementById('schedule').textContent,/TEST 1000|Test Course/);assert.deepEqual(errors,[]);
 }finally{w.close();}
});
