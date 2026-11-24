(() => {
'use strict';
const baseControls=controls;
let chats=[], follow=new Map(), followChecked=false, lastChat=null, pinScope=null;
const make=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
let synchronized=null, syncing=false, batch=false;
const hideSelection=new Set(), restoreSelection=new Set();
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
async function syncPreferences(changes=[]){
  const scope=window.salesDeskScope?.();
  if(!scope)return;
  if(scope!==pinScope){pinScope=scope;synchronized=null;}
  let result=await window.syncSalesDeskPreferences();
  if(scope!==window.salesDeskScope?.())throw new Error('接続が変わりました。');
  if(!result.sync){
    if(changes.length){
      const isPin=changes[0].kind==='pin';
      const key=isPin?'pins':'hidden';
      const ids=new Set(changes.map(row=>row.chat_id));
      const kept=stored(key,scope).filter(row=>!ids.has(isPin?row:row.id));
      for(const change of changes)if(change.active)kept.push(isPin?change.chat_id:{id:change.chat_id,title:change.title});
      localStorage.setItem('line-sales-'+key+':'+scope,JSON.stringify(kept));
    }
    return;
  }
  const oldPins=stored('pins',scope).filter(id=>typeof id==='string'&&id.length>0&&id.length<=256).slice(0,12);
  const oldHidden=stored('hidden',scope).filter(row=>typeof row?.id==='string'&&row.id.length>0&&row.id.length<=256);
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
  for(let i=0;i<changes.length;i+=8){
    if(scope!==window.salesDeskScope?.())throw new Error('接続が変わりました。');
    result=await window.syncSalesDeskPreferences(changes.slice(i,i+8));
    synchronized=result.rows;
  }
  if(scope===window.salesDeskScope?.())synchronized=result.rows;
}
async function updatePreferences(kind, records, active){
  if(busy||syncing)return false;
  syncing=true;controls();
  try{
    await syncPreferences(records.map(record=>({kind,chat_id:record.id,active,title:kind==='hide'&&active?record.title.slice(0,200):''})));
    return true;
  }catch(error){
    $('chatFilterStatus').textContent='設定を同期できませんでした。 '+error.message;
    return false;
  }finally{syncing=false;controls();}
}
function updateBatchControls(){
  $('chatBatchBar').classList.toggle('hidden',!batch);
  $('chatBatchToggle').setAttribute('aria-pressed',String(batch));
  $('chatBatchToggle').textContent=batch?'選択を終了':'複数選択';
  $('chatBatchCount').textContent=hideSelection.size+'件選択';
  $('chatRestoreCount').textContent=restoreSelection.size+'件選択';
  $('chatBatchToggle').disabled=busy||syncing;
  $('chatBatchHide').disabled=busy||syncing||!hideSelection.size;
  $('chatBatchRestore').disabled=busy||syncing||!restoreSelection.size;
}
function checkbox(record,selection){
  const check=document.createElement('input');
  check.type='checkbox';
  check.checked=selection.has(record.id);
  check.disabled=busy||syncing;
  check.setAttribute('aria-label',record.title+'を選択');
  check.onchange=()=>{
    if(check.checked)selection.add(record.id);else selection.delete(record.id);
    updateBatchControls();
  };
  return check;
}
function renderHidden(){
  const records=hiddenChats();
  const area=$('hiddenChatItems');
  const available=new Set(records.map(row=>row.id));
  for(const id of restoreSelection)if(!available.has(id))restoreSelection.delete(id);
  area.replaceChildren();
  $('hiddenChatSettings').hidden=!records.length;
  $('hiddenChatSummary').textContent='非表示にしたトーク（'+records.length+'件）';
  for(const record of records){
    const label=make('label','');
    label.className='desk-option';
    label.append(checkbox(record,restoreSelection),make('span',record.title));
    area.append(label);
  }
  updateBatchControls();
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
    item.disabled=busy||syncing;
    item.onclick=()=>choose(chat);
    if(batch){
      const row=make('label','');
      row.className='desk-option';
      const name=make('span',(marked.includes(chat.id)?'★ ':'')+chat.title);
      row.append(checkbox(chat,hideSelection),name);
      if(reasons.length)name.append(make('small',reasons.join(' ／ ')));
      fragment.append(row);
    }else fragment.append(item);
  }
  $('chats').replaceChildren(fragment);
  updateBatchControls();
  if(!visible.length)$('chats').textContent=chats.length?'該当するトークはありません。':'トークがありません。';
  const statusFilter=['reply','due'].includes($('chatFilter').value);
  $('followRefresh').hidden=!statusFilter;
  $('chatFilterStatus').textContent=statusFilter&&!followChecked?'「対応状況を確認」を押してください。':'';
}
async function load(query=''){
  if(busy||syncing)return false;
  syncing=true;controls();
  selected=null;messageId=null;conversationVersion=null;
  chats=[];follow.clear();followChecked=false;hideSelection.clear();
  $('history').replaceChildren();$('candidates').replaceChildren();
  $('name').textContent='相手を選んでください';$('chats').textContent='取得中…';
  try{
    await syncPreferences();
    const ids=pins().slice(0,12);
    const excluded=new Set(hiddenChats().map(row=>row.id));
    const desired=15;
    const excludedPayload=excluded.size<=50?[...excluded]:[];
    const visible=new Map(), seenCursors=new Set();
    let cursor=null;
    do{
      const response=await request('chats',{
        count:desired, paged:true,
        ...(query?{query}:{}),
        ...(!cursor&&ids.length?{pins:ids}:{}),
        ...(cursor?{cursor}:{}),
        ...(excludedPayload.length?{excluded:excludedPayload}:{})
      });
      for(const chat of response.chats)if(!excluded.has(chat.id))visible.set(chat.id,chat);
      cursor=response.next_cursor;
      if(cursor&&seenCursors.has(cursor))break;
      if(cursor)seenCursors.add(cursor);
    }while(cursor&&visible.size<desired);
    chats=[...visible.values()].slice(0,desired);
    render();
    return true;
  }catch(error){$('chats').textContent=error.message;return false;}
  finally{syncing=false;controls();}
}
$('loadChats').onclick=()=>{$('chatQuery').value='';return load();};
$('chatSearchForm').onsubmit=event=>{event.preventDefault();load($('chatQuery').value.trim());};
$('chatFilter').onchange=()=>{hideSelection.clear();render();};
$('chatBatchToggle').onclick=()=>{
  if(busy||syncing)return;
  batch=!batch;hideSelection.clear();render();
};
$('chatBatchHide').onclick=async()=>{
  const records=chats.filter(row=>hideSelection.has(row.id));
  if(!records.length)return;
  if(records.some(row=>row.id.length>256)){
    $('chatFilterStatus').textContent='選択したトークを非表示にできません。選択内容を確認してください。';
    return;
  }
  if(!confirm(records.length+'件のトークを一覧から隠しますか？'))return;
  if(await updatePreferences('hide',records,true)){batch=false;await load($('chatQuery').value.trim());}
};
$('chatBatchRestore').onclick=async()=>{
  const records=hiddenChats().filter(row=>restoreSelection.has(row.id));
  if(records.length&&await updatePreferences('hide',records,false)){
    restoreSelection.clear();
    await load($('chatQuery').value.trim());
  }
};
$('hideChat').onclick=async()=>{
  if(busy||syncing||!selected)return;
  if(selected.id.length>256){$('chatFilterStatus').textContent='このトークを非表示にできません。';return;}
  if(!confirm('「'+selected.title+'」を一覧から隠しますか？'))return;
  if(await updatePreferences('hide',[selected],true))await load($('chatQuery').value.trim());
};
$('pinChat').onclick=async()=>{
  if(busy||syncing||!selected)return;
  const ids=pins(),exists=ids.includes(selected.id);
  if(selected.id.length>256||(!exists&&ids.length>=12)){$('chatFilterStatus').textContent='このトークをピン留めできません。上限は12件です。';return;}
  if(await updatePreferences('pin',[selected],!exists)){render();controls();}
};
window.salesDesk={
  hasChats:()=>chats.length>0,
  chatIds:()=>chats.map(chat=>chat.id),
  showFollow(items){
    follow=new Map(items.map(row=>[row.chat_id,row.reasons]));
    followChecked=true;render();
  },
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
  if(pinScope!==scope){synchronized=null;batch=false;hideSelection.clear();restoreSelection.clear();if(chats.length){chats=[];follow.clear();followChecked=false;render();}}
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
  $('chats').querySelectorAll('input[type=checkbox]').forEach(check=>check.disabled=busy||syncing);
  renderHidden();
  $('pinChat').textContent=pins().includes(selected?.id)?'ピン留め解除':'ピン留め';
  $('chatQuery').disabled=busy;
  $('chatFilter').disabled=busy;
  $('chatSearchForm').querySelector('button').disabled=busy||syncing;
};
controls();
})();
