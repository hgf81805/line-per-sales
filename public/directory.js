/* Existing companies and contacts, read through the owner's authenticated Mac. */
(() => {
'use strict';
let records=[],offset=0,hasMore=false,loaded=false,attempted=false,loading=false,epoch=0,storageText='';
const baseControls=controls;
const savedMode=()=>!local&&$('directoryMode').value==='saved';
const available=()=>savedMode()?window.savedAttioDirectory.available():connected();
$('directoryModeField').classList.toggle('hidden',local);
const connected=()=>local||!$('connected').classList.contains('hidden');
controls=function(){baseControls();for(const id of ['directoryRefresh','directoryMore','directorySource'])$(id).disabled=(!savedMode()&&busy)||loading||!available();};
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
function render(){
  const search=$('directorySearch').value.trim().toLocaleLowerCase();
  const filtered=records.filter(r=>[r.name,r.detail,r.job_title].filter(Boolean).join(' ').toLocaleLowerCase().includes(search));
  $('directoryCards').replaceChildren();
  for(const record of filtered){
    const card=node('article');card.className='deal-card';card.append(node('h3',record.name));
    if(record.detail)card.append(node('p',record.detail));if(record.job_title)card.append(node('p',record.job_title));
    if(record.fetched_at){
      const timestamp=new Date(record.fetched_at);
      if(!Number.isNaN(timestamp.getTime()))card.append(node('p','Attioからの最終取得 '+timestamp.toLocaleString('ja-JP')));
    }
    try{const url=new URL(record.url);if(url.protocol==='https:'&&url.hostname==='app.attio.com'){const link=node('a','Attioで開く ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}}catch(e){}
    $('directoryCards').append(card);
  }
  if(loaded&&!filtered.length)$('directoryCards').append(node('p',records.length?'条件に一致するデータはありません。':'登録済みのデータはありません。'));
  $('directoryMore').classList.toggle('hidden',!hasMore);
  if(loaded)$('directoryNotice').textContent=($('directorySource').value==='people'?'連絡先':'会社')+'：'+records.length+'件取得済み・表示'+filtered.length+'件。'+(hasMore?'続きがあります。':'全件取得済み。')+storageText;
}
function clear(){epoch++;loading=false;storageText='';records=[];offset=0;hasMore=false;loaded=false;attempted=false;$('directorySearch').value='';$('directoryError').textContent='';$('directoryNotice').textContent=savedMode()?'ログインすると、Attio「if-hold」の保存済みデータを表示します。':'Macに接続すると、Attioから取得できます。';render();controls();}
async function load(append=false){
  if(loading||(!savedMode()&&busy)||!available())return;
  const saved=savedMode(),current=epoch,source=$('directorySource').value;loading=true;attempted=true;controls();$('directoryError').textContent='';$('directoryNotice').textContent=saved?'Supabaseの保存済みデータを読み込んでいます…':'Attioの既存データを取得しています…';
  try{
    const start=append?offset:0,data=await (saved?window.savedAttioDirectory.page(source,start):request('attio-list',{source,offset:start}));if(current!==epoch)return;
    if(data.source!==source||!Array.isArray(data.records))throw new Error('会社・連絡先の取得にはMacアプリv1.6が必要です。最新版で起動し直してください。');
    const merged=new Map((append?records:[]).map(r=>[r.id,r]));for(const record of data.records)merged.set(record.id,record);
    storageText=saved?' Attio「if-hold」のSupabase保存分。':data.storage?.saved?' Supabaseに保存済み。':' '+(data.storage?.message||'Supabaseへの自動保存にはMacアプリv1.7が必要です。');
    records=[...merged.values()];offset=start+data.records.length;hasMore=data.has_more;loaded=true;render();
  }catch(e){if(current===epoch){$('directoryError').textContent=e.message;$('directoryNotice').textContent=loaded?'更新できませんでした。前回取得したデータを表示しています。':saved?'Supabaseの保存済みデータを取得できませんでした。':'取得できませんでした。Macの接続とAttioトークンの権限を確認してください。';}}
  finally{if(current===epoch){loading=false;controls();}}
}
$('directoryRefresh').onclick=()=>load();$('directoryMore').onclick=()=>load(true);
$('directorySource').onchange=()=>{clear();load();};$('directorySearch').oninput=render;
$('directoryMode').onchange=()=>{clear();load();};
window.addEventListener('attiosessionready',()=>{if(savedMode()){clear();load();}});
window.addEventListener('connectionchange',()=>{
  if(savedMode()&&available())return;
  clear();
});
window.addEventListener('pipelineupdated',()=>{if(!savedMode()&&!attempted&&connected())load();});
controls();
if(savedMode()&&available())load();
})();
