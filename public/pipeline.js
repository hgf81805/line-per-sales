/* Read-only Attio board; uses the same authenticated Mac relay as the LINE page. */
(() => {
'use strict';
const definitions=[
  {key:'lead',title:'Lead',label:'見込み',description:'これから関係を深める案件'},
  {key:'in progress',title:'In Progress',label:'商談中',description:'商談・提案を進めている案件'},
  {key:'won',title:'Won',label:'成約',description:'成約した案件'},
  {key:'lost',title:'Lost',label:'失注',description:'失注となった案件'}
];
let deals=[],members=[],stages=[],loaded=false,nextOffset=0,more=false,epoch=0,loading=false;
const connected=()=>local||!$('connected').classList.contains('hidden');
const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
function stageKey(title){const normalized=(title||'').trim().toLowerCase();return definitions.find(d=>normalized===d.key||normalized.startsWith(d.key+' '))?.key;}
function render(){
  const query=$('boardSearch').value.trim().toLocaleLowerCase(),owner=$('boardOwner').value;
  const visible=deals.filter(d=>(!query||d.name.toLocaleLowerCase().includes(query))&&(!owner||d.owner_id===owner));
  const columns=definitions.map(d=>({...d,items:[]}));
  const extra=new Map();
  for(const deal of visible){
    const title=stages.find(s=>s.id===deal.stage_id)?.title||deal.stage;
    const key=stageKey(title),column=columns.find(c=>c.key===key);
    if(column)column.items.push(deal);
    else{const id=deal.stage_id||'unset';if(!extra.has(id))extra.set(id,{title:title||'未設定',label:'その他の工程',description:'Attioに登録されている工程',items:[]});extra.get(id).items.push(deal);}
  }
  $('board').replaceChildren();
  for(const column of [...columns,...extra.values()]){
    const lane=element('section',undefined,'lane'),heading=element('h2');
    heading.append(element('span',column.title+' · '+column.label),element('span',loaded?String(column.items.length):'—','count'));
    lane.append(heading,element('p',column.description,'muted'));
    for(const deal of column.items){
      const card=element('article',undefined,'deal-card');card.append(element('h3',deal.name));
      const member=members.find(m=>m.id===deal.owner_id);
      card.append(element('p','担当：'+(member?.name||'未設定'),'muted'));
      const date=new Date(deal.stage_since);
      if(deal.stage_since&&!Number.isNaN(date.getTime()))card.append(element('p','工程に入った日：'+date.toLocaleDateString('ja-JP'),'muted'));
      if(typeof deal.value==='number'){
        let value;try{value=new Intl.NumberFormat('ja-JP',{style:'currency',currency:deal.currency||'USD'}).format(deal.value);}catch(e){value=String(deal.value);}
        card.append(element('p',value));
      }
      try{const url=new URL(deal.url);if(url.protocol==='https:'&&url.hostname==='app.attio.com'){const link=element('a','Attioで開く ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}}catch(e){}
      lane.append(card);
    }
    if(!column.items.length)lane.append(element('p',loaded?'該当する案件はありません。':'接続すると案件を表示します。','empty'));
    $('board').append(lane);
  }
  $('boardMore').classList.toggle('hidden',!more);
  if(loaded)$('boardNotice').textContent=deals.length+'件取得済み・絞り込み後'+visible.length+'件。'+(more?'まだ続きがあります。「次の50件を追加」で読み込めます。':'全件取得済み。');
}
async function load(append=false){
  if(loading||busy||!connected())return;
  const current=epoch;loading=true;$('boardNotice').textContent='Attioの案件を取得しています…';$('error').textContent='';
  try{
    const offset=append?nextOffset:0,data=await request('attio-list',{offset});
    if(current!==epoch)return;
    const combined=new Map((append?deals:[]).map(d=>[d.id,d]));for(const deal of data.deals)combined.set(deal.id,deal);
    deals=[...combined.values()];members=data.members;stages=data.stages;loaded=true;more=data.has_more;nextOffset=offset+data.deals.length;
    const previous=$('boardOwner').value;$('boardOwner').replaceChildren();const all=element('option','すべての担当者');all.value='';$('boardOwner').append(all);
    for(const member of members){const option=element('option',member.name);option.value=member.id;$('boardOwner').append(option);}if(members.some(m=>m.id===previous))$('boardOwner').value=previous;
    $('boardSummary').textContent=(data.profile.workspace_name||'Attio')+' · 最終取得 '+new Date().toLocaleString('ja-JP');render();
  }catch(e){if(current===epoch){$('error').textContent=e.message;$('boardNotice').textContent=loaded?'更新できませんでした。前回取得した案件を表示しています。':'案件を取得できませんでした。Macの接続とAttio設定を確認してください。';}}
  finally{loading=false;controls();window.dispatchEvent(new Event('pipelineupdated'));}
}
$('boardRefresh').onclick=()=>load();$('boardMore').onclick=()=>load(true);
$('boardSearch').oninput=render;$('boardOwner').onchange=render;
window.addEventListener('connectionchange',()=>{
  epoch++;deals=[];members=[];stages=[];loaded=false;more=false;nextOffset=0;$('boardSearch').value='';$('boardOwner').replaceChildren();const option=element('option','すべての担当者');option.value='';$('boardOwner').append(option);
  $('boardSummary').textContent='接続後にAttioの案件を表示します。';$('boardNotice').textContent='接続前は工程の流れだけを表示しています。';$('error').textContent='';render();controls();
  if(connected()){ $('status').textContent='';load(); }
});
render();controls();if(local)load();
})();
