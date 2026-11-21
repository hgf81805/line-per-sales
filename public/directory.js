/* Existing companies and contacts, read through the owner's authenticated Mac. */
(() => {
'use strict';
let records=[],offset=0,hasMore=false,loaded=false,attempted=false,loading=false,epoch=0,storageText='';
const baseControls=controls;
const connected=()=>local||!$('connected').classList.contains('hidden');
controls=function(){baseControls();for(const id of ['directoryRefresh','directoryMore','directorySource'])$(id).disabled=busy||loading||!connected();};
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
function render(){
  const search=$('directorySearch').value.trim().toLocaleLowerCase();
  const filtered=records.filter(r=>[r.name,r.detail,r.job_title].filter(Boolean).join(' ').toLocaleLowerCase().includes(search));
  $('directoryCards').replaceChildren();
  for(const record of filtered){
    const card=node('article');card.className='deal-card';card.append(node('h3',record.name));
    if(record.detail)card.append(node('p',record.detail));if(record.job_title)card.append(node('p',record.job_title));
    try{const url=new URL(record.url);if(url.protocol==='https:'&&url.hostname==='app.attio.com'){const link=node('a','Attioで開く ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}}catch(e){}
    $('directoryCards').append(card);
  }
  if(loaded&&!filtered.length)$('directoryCards').append(node('p',records.length?'条件に一致するデータはありません。':'登録済みのデータはありません。'));
  $('directoryMore').classList.toggle('hidden',!hasMore);
  if(loaded)$('directoryNotice').textContent=($('directorySource').value==='people'?'連絡先':'会社')+'：'+records.length+'件取得済み・表示'+filtered.length+'件。'+(hasMore?'続きがあります。':'全件取得済み。')+storageText;
}
function clear(){epoch++;storageText='';records=[];offset=0;hasMore=false;loaded=false;attempted=false;$('directorySearch').value='';$('directoryError').textContent='';$('directoryNotice').textContent='接続後、選択した種類の既存データを取得します。';render();controls();}
async function load(append=false){
  if(loading||busy||!connected())return;
  const current=epoch,source=$('directorySource').value;loading=true;attempted=true;controls();$('directoryError').textContent='';$('directoryNotice').textContent='Attioの既存データを取得しています…';
  try{
    const start=append?offset:0,data=await request('attio-list',{source,offset:start});if(current!==epoch)return;
    if(data.source!==source||!Array.isArray(data.records))throw new Error('会社・連絡先の取得にはMacアプリv1.6が必要です。最新版で起動し直してください。');
    const merged=new Map((append?records:[]).map(r=>[r.id,r]));for(const record of data.records)merged.set(record.id,record);
    storageText=data.storage?.saved?' Supabaseに保存済み。':' '+(data.storage?.message||'Supabaseへの自動保存にはMacアプリv1.7が必要です。');
    records=[...merged.values()];offset=start+data.records.length;hasMore=data.has_more;loaded=true;render();
  }catch(e){if(current===epoch){$('directoryError').textContent=e.message;$('directoryNotice').textContent=loaded?'更新できませんでした。前回取得したデータを表示しています。':'取得できませんでした。Macの接続とAttioトークンの権限を確認してください。';}}
  finally{loading=false;controls();}
}
$('directoryRefresh').onclick=()=>load();$('directoryMore').onclick=()=>load(true);
$('directorySource').onchange=()=>{clear();load();};$('directorySearch').oninput=render;
window.addEventListener('connectionchange',clear);
window.addEventListener('pipelineupdated',()=>{if(!attempted&&connected())load();});
controls();
})();
