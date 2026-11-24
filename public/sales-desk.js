(() => {
'use strict';
const baseControls=controls;
let chats=[], follow=new Map(), followChecked=false, lastChat=null, pinScope=null;
const make=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
let synchronized=null, syncing=false;
function stored(type,scope=window.salesDeskScope?.()){
  if(!scope)return [];
  try{
    const value=JSON.parse(localStorage.getItem('line-sales-'+type+':'+scope)||'[]');
    return Array.isArray(value)?value:[];
  }catch{return [];}
}
function pins(){
  return synchronized ? synchronized.filter(row=>row.kind==='pin').map(row=>row.chat_id) : stored('pins');
}
function hiddenChats(){
  return synchronized ? synchronized.filter(row=>row.kind==='hide').map(row=>({id:row.chat_id,title:row.title})) : stored('hidden');
}
async function syncPreferences(change){
  const scope=window.salesDeskScope?.();
  if(!scope)return;
  if(scope!==pinScope){pinScope=scope;synchronized=null;}
  let result=await window.syncSalesDeskPreferences();
  if(scope!==window.salesDeskScope?.())throw new Error('接続が変わりました。');
  if(!result.sync){
    if(change){
      const key=change.kind==='pin'?'pins':'hidden';
      const existing=stored(key,scope);
      const isPin=change.kind==='pin';
      const kept=existing.filter(row=>(isPin?row:row.id)!==change.chat_id);
      if(change.active)kept.push(isPin?change.chat_id:{id:change.chat_id,title:change.title});
      localStorage.setItem('line-sales-'+key+':'+scope,JSON.stringify(kept));
    }
    return;
  }
  const oldPins=stored('pins',scope).filter(id=>typeof id==='string'&&id.length>0&&id.length<=256).slice(0,12);
  const oldHidden=stored('hidden',scope).filter(row=>typeof row?.id==='string'&&row.id.length>0&&row.id.length<=256).slice(0,50);
  const imported=[
    ...oldPins.map(chat_id=>({chat_id,kind:'pin',active:true,title:''})),
    ...oldHidden.map(({id,title})=>({chat_id:id,kind:'hide',active:true,title:String(title||'トーク').slice(0,200)}))
  ];
  const unique=[...new Map(imported.map(row=>[row.kind+':'+row.chat_id,row])).values()];
  for(let i=0;i<unique.length;i+=8){
    if(scope!==window.salesDeskScope?.())throw new Error('接続が変わりました。');
    result=await window.syncSalesDeskPreferences(unique.slice(i,i+8),true);
  }
  if(unique.length){
    localStorage.removeItem('line-sales-pins:'+scope);
    localStorage.removeItem('line-sales-hidden:'+scope);
  }
  if(scope!==window.salesDeskScope?.())throw new Error('接続が変わりました。');
  if(change)result=await window.syncSalesDeskPreferences([change]);
  if(scope===window.salesDeskScope?.())synchronized=result.rows;
}
async function updatePreference(kind, record, active){
  if(busy||syncing)return false;
  syncing=true;controls();
  try{
    await syncPreferences({kind,chat_id:record.id,active,title:kind==='hide'?record.title.slice(0,200):''});
    return true;
  }catch(error){
    $('chatFilterStatus').textContent='設定を同期できませんでした。 '+error.message;
    return false;
  }finally{syncing=false;controls();}
}
function renderHidden(){
  const records=hiddenChats();
  const area=$('hiddenChatItems');
  area.replaceChildren();
  $('hiddenChatSettings').hidden=!records.length;
  for(const record of records){
    const restore=make('button',record.title+' を戻す');
    restore.type='button';
    restore.disabled=busy||syncing;
    restore.onclick=async()=>{
      if(await updatePreference('hide',record,false))await load($('chatQuery').value.trim());
    };
    area.append(restore);
  }
}
function isVisible(chat,marked){
  const filter=$('chatFilter').value;
  const reasons=follow.get(chat.id)||[];
  return filter==='all'||(filter==='pins'&&marked.includes(chat.id))||
    (filter==='reply'&&reasons.includes('こちらの返信待ち'))||
    (filter==='due'&&reasons.some(reason=>reason==='今日が期限'||reason==='期限超過'));
}
function choose(chat){
  if(busy||!chats.includes(chat))return;
  selected=chat;messageId=null;conversationVersion=null;
  $('name').textContent=chat.title;
  $('history').replaceChildren();$('candidates').replaceChildren();
  render();controls();
  $('chatOverview').scrollIntoView({block:'nearest'});
}
function render(){
  const marked=pins();
  function priority(chat){
    const reasons=follow.get(chat.id)||[];
    return reasons.includes('期限超過')?3:reasons.includes('今日が期限')?2:reasons.includes('こちらの返信待ち')?1:0;
  }
  const visible=chats.filter(chat=>isVisible(chat,marked)).sort((a,b)=>
    Number(marked.includes(b.id))-Number(marked.includes(a.id))||priority(b)-priority(a));
  const fragment=document.createDocumentFragment();
  for(const chat of visible){
    const item=make('button',(marked.includes(chat.id)?'★ ':'')+chat.title);
    item.type='button';item.className='chat-button';
    item.classList.toggle('selected',selected?.id===chat.id);
    item.dataset.chatId=chat.id;
    const reasons=follow.get(chat.id)||[];
    item.append(make('span',reasons.length?reasons.join(' ／ '):chat.updated?date(chat.updated):marked.includes(chat.id)?'ピン留め':'更新日時を取得できません'));
    item.disabled=busy;item.onclick=()=>choose(chat);
    fragment.append(item);
  }
  $('chats').replaceChildren(fragment);
  if(!visible.length)$('chats').textContent=chats.length?'該当するトークはありません。':'トークがありません。';
  $('chatFilterStatus').textContent=['reply','due'].includes($('chatFilter').value)&&!followChecked?'「最近のトークを確認」で対応状況を取得してください。':'';
}
async function load(query=''){
  if(busy||syncing)return false;
  syncing=true;controls();
  selected=null;messageId=null;conversationVersion=null;
  chats=[];follow.clear();followChecked=false;
  $('followResults').replaceChildren();$('history').replaceChildren();$('candidates').replaceChildren();
  $('name').textContent='相手を選んでください';$('chats').textContent='取得中…';
  try{
    await syncPreferences();
    const ids=pins().slice(0,12);
    const excluded=hiddenChats().slice(0,50).map(row=>row.id);
    const response=await request('chats',{count:10,...(excluded.length?{excluded}:{}),...(query?{query}:{}),...(ids.length?{pins:ids}:{} )});
    chats=response.chats;
    render();
    return true;
  }catch(error){$('chats').textContent=error.message;return false;}
  finally{syncing=false;controls();}
}
$('loadChats').onclick=()=>{$('chatQuery').value='';return load();};
$('chatSearchForm').onsubmit=event=>{event.preventDefault();load($('chatQuery').value.trim());};
$('chatFilter').onchange=render;
$('hideChat').onclick=async()=>{
  if(busy||syncing||!selected)return;
  const records=hiddenChats();
  if(records.length>=50||selected.id.length>256){$('chatFilterStatus').textContent='このトークを非表示にできません。';return;}
  if(!confirm('「'+selected.title+'」を一覧から隠しますか？'))return;
  if(await updatePreference('hide',selected,true))await load($('chatQuery').value.trim());
};
$('pinChat').onclick=async()=>{
  if(busy||syncing||!selected)return;
  const ids=pins(),exists=ids.includes(selected.id);
  if(selected.id.length>256||(!exists&&ids.length>=12)){$('chatFilterStatus').textContent='このトークをピン留めできません。上限は12件です。';return;}
  if(await updatePreference('pin',selected,!exists)){render();controls();}
};
window.salesDesk={
  hasChats:()=>chats.length>0,
  showFollow(items){
    follow=new Map(items.map(row=>[row.chat_id,row.reasons]));
    followChecked=true;render();
  },
  open(id){const chat=chats.find(row=>row.id===id);if(chat)choose(chat);},
  label(id){return chats.find(row=>row.id===id)?.title;},
  showOverview(data){
    const task=data.tasks?.slice().sort((a,b)=>(a.deadline||'9999').localeCompare(b.deadline||'9999'))[0];
    $('chatOverviewStatus').textContent=data.deal
      ? [data.deal.name,data.deal.stage,task?.content||'次のアクション未設定',task?.deadline?date(task.deadline):''].filter(Boolean).join(' · ')
      : data.crm_available?'Attio案件の紐付けなし':'Attioの案件を確認できませんでした。';
    const notes=$('overviewNoteItems');
    notes.replaceChildren();
    for(const entry of data.notes||[]){
      const note=document.createElement('details');
      note.append(make('summary',entry.title||'ノート'),make('p',entry.body));
      notes.append(note);
    }
    $('overviewNotes').classList.toggle('hidden',!notes.children.length);
  }
};
controls=function(){
  baseControls();
  const scope=window.salesDeskScope?.();
  if(pinScope!==scope){synchronized=null;if(chats.length){chats=[];follow.clear();followChecked=false;render();}}
  pinScope=scope;
  if(lastChat!==selected?.id){
    lastChat=selected?.id;
    $('chatOverviewStatus').textContent='案件を確認中…';
    $('overviewNotes').open=false;
    $('overviewNotes').classList.add('hidden');
    $('overviewNoteItems').replaceChildren();
  }
  $('chatOverview').classList.toggle('hidden',!selected);
  $('loadChats').disabled||=syncing;
  $('pinChat').disabled=busy||syncing||!selected;
  $('hideChat').disabled=busy||syncing||!selected;
  renderHidden();
  $('pinChat').textContent=pins().includes(selected?.id)?'ピン留め解除':'ピン留め';
  $('chatQuery').disabled=busy;
  $('chatFilter').disabled=busy;
  $('chatSearchForm').querySelector('button').disabled=busy||syncing;
};
controls();
})();
