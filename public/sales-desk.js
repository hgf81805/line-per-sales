(() => {
'use strict';
const baseControls=controls;
const DISPLAY_LIMIT=15, RESERVE_LIMIT=5;
const LIST_LIMIT=DISPLAY_LIMIT+RESERVE_LIMIT;
let chats=[], follow=new Map(), followChecked=false, lastChat=null, pinScope=null;
const make=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
let synchronized=null, syncing=false, batch=false;
const hideSelection=new Set(), restoreSelection=new Set(), laterSelection=new Set(), leadSelection=new Set();
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
function laterChats(){
  return synchronized ? synchronized.filter(row=>row.kind==='later') : stored('later');
}
function leadChats(){
  return synchronized ? synchronized.filter(row=>row.kind==='lead').map(row=>({id:row.chat_id,title:row.title})) : stored('lead');
}
function renderLeads(){
  const records=leadChats();
  const available=new Set(records.map(row=>row.id));
  for(const id of leadSelection)if(!available.has(id))leadSelection.delete(id);
  $('leadChatSettings').hidden=!records.length;
  $('leadChatSummary').textContent='優先リード（'+records.length+'件）';
  const items=$('leadChatItems');
  items.replaceChildren();
  for(const record of records){
    const row=make('div','');
    row.className='desk-option';
    const open=make('button',record.title||'トーク');
    const restore=make('button','一覧に戻す');
    open.type=restore.type='button';
    open.disabled=restore.disabled=busy||syncing;
    open.onclick=async()=>{
      if(busy||syncing)return;
      const scope=window.salesDeskScope?.();
      try{
        const result=await request('chats',{lead_chat:record.id});
        if(scope!==window.salesDeskScope?.()||!leadChats().some(row=>row.id===record.id))return;
        const chat=result.chats.find(item=>item.id===record.id);
        if(chat)choose(chat,true);
      }catch(error){$('chatFilterStatus').textContent=error.message;}
    };
    restore.onclick=async()=>{
      if(await updatePreferences('lead',[record],false))applyRestoredChats([record]);
    };
    row.append(checkbox(record,leadSelection),open,restore);
    items.append(row);
  }
}
function jstToday(){
  const fields=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts();
  const value=Object.fromEntries(fields.map(field=>[field.type,field.value]));
  return value.year+'-'+value.month+'-'+value.day;
}
async function restoreLater(records){
  const scope=window.salesDeskScope?.();
  if(!scope||!records.length)return;
  const released=records.map(({chat_id,deferred_at})=>({chat_id,deferred_at}));
  if(synchronized){
    for(let i=0;i<released.length;i+=12){
      if(window.salesDeskScope?.()!==scope)throw new Error('接続が変わりました。');
      const result=await window.syncSalesDeskPreferences(null,false,released.slice(i,i+12));
      if(window.salesDeskScope?.()!==scope||!result.sync)throw new Error('接続が変わりました。');
      synchronized=result.rows;
    }
  }else{
    const restored=new Map(released.map(row=>[row.chat_id,row.deferred_at]));
    const kept=stored('later',scope).filter(row=>restored.get(row.chat_id)!==row.deferred_at);
    localStorage.setItem('line-sales-later:'+scope,JSON.stringify(kept));
  }
}
async function checkLater(){
  const pending=laterChats();
  const today=jstToday();
  const due=pending.filter(row=>row.return_on&&row.return_on<=today);
  const waiting=pending.filter(row=>!row.return_on||row.return_on>today);
  let checkError='';
  for(let i=0;i<waiting.length;i+=12){
    const batch=waiting.slice(i,i+12);
    try{
      const result=await request('sales-assist',{mode:'later-check',later:batch.map(({chat_id,deferred_at})=>({chat_id,deferred_at}))});
      const replied=new Set(result.chat_ids);
      due.push(...batch.filter(row=>replied.has(row.chat_id)));
    }catch(error){checkError=error.message;break;}
  }
  await restoreLater(due);
  const stillDeferred=new Set(laterChats().map(row=>row.chat_id));
  return {ids:due.filter(row=>!stillDeferred.has(row.chat_id)).map(row=>row.chat_id),checkError};
}
function renderLater(){
  const records=laterChats();
  $('laterChatSettings').hidden=!records.length;
  $('laterChatSummary').textContent='あとで見る（'+records.length+'件）';
  const ids=new Set(records.map(row=>row.chat_id));
  for(const id of laterSelection)if(!ids.has(id))laterSelection.delete(id);
  const items=$('laterChatItems');
  items.replaceChildren();
  for(const record of records){
    const row=make('div','');
    row.className='desk-option';
    const label=make('span',record.title||'トーク');
    label.append(make('small',record.return_on?'戻す日 '+record.return_on:'新着が来たら戻す'));
    const open=make('button','一覧に戻す');
    open.type='button';
    open.disabled=busy||syncing;
    open.onclick=async()=>{
      if(busy||syncing)return;
      syncing=true;controls();
      try{await restoreLater([record]);}
      catch(error){$('chatFilterStatus').textContent=error.message;return;}
      finally{syncing=false;controls();}
      applyRestoredChats([record]);
    };
    row.append(checkbox({id:record.chat_id,title:record.title||'トーク'},laterSelection),label,open);
    items.append(row);
  }
}
function showLaterForm(open){
  $('laterChatForm').classList.toggle('hidden',!open);
  $('laterChat').setAttribute('aria-expanded',String(open));
}
async function syncPreferences(changes=[]){
  const scope=window.salesDeskScope?.();
  if(!scope)throw new Error('先にMacへ接続してください。');
  if(scope!==pinScope){pinScope=scope;synchronized=null;}
  let result=await window.syncSalesDeskPreferences();
  if(scope!==window.salesDeskScope?.())throw new Error('接続が変わりました。');
  if(!result.sync){
    if(changes.length){
      const isPin=changes[0].kind==='pin';
      const isLater=changes[0].kind==='later';
      const key=isPin?'pins':isLater?'later':changes[0].kind==='lead'?'lead':'hidden';
      const ids=new Set(changes.map(row=>row.chat_id));
      const kept=stored(key,scope).filter(row=>!ids.has(isPin?row:isLater?row.chat_id:row.id));
      for(const change of changes)if(change.active)kept.push(isPin?change.chat_id:isLater?change:{id:change.chat_id,title:change.title});
      localStorage.setItem('line-sales-'+key+':'+scope,JSON.stringify(kept));
    }
    return;
  }
  const oldPins=stored('pins',scope).filter(id=>typeof id==='string'&&id.length>0&&id.length<=256).slice(0,12);
  const oldHidden=stored('hidden',scope).filter(row=>typeof row?.id==='string'&&row.id.length>0&&row.id.length<=256);
  const imported=[
    ...stored('later',scope),
    ...stored('lead',scope).map(({id,title})=>({chat_id:id,title,kind:'lead',active:true})),
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
    localStorage.removeItem('line-sales-later:'+scope);
    localStorage.removeItem('line-sales-lead:'+scope);
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
    await syncPreferences(records.map(record=>({kind,chat_id:record.id,active,title:(kind==='hide'||kind==='lead')&&active?record.title.slice(0,200):''})));
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
  $('laterRestoreCount').textContent=laterSelection.size+'件選択';
  $('laterRestoreSelected').disabled=busy||syncing||!laterSelection.size;
  $('leadRestoreCount').textContent=leadSelection.size+'件選択';
  $('leadRestoreSelected').disabled=busy||syncing||!leadSelection.size;
  $('chatBatchLead').disabled=busy||syncing||!hideSelection.size;
  $('chatBatchLater').disabled=busy||syncing||!hideSelection.size;
  $('chatBatchLaterSave').disabled=busy||syncing||!hideSelection.size;
  if(!batch||!hideSelection.size)showBatchLater(false);
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
function choose(chat,fromLead=false){
  if(busy||(!fromLead&&!chats.includes(chat)))return;
  if(chat.needsRefresh){
    $('chatFilterStatus').textContent='会話を開くには「LINE一覧を手動更新」を押してください。';
    return;
  }
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
    Number(marked.includes(b.id))-Number(marked.includes(a.id))||priority(b)-priority(a)).slice(0,DISPLAY_LIMIT);
  const fragment=document.createDocumentFragment();
  for(const chat of visible){
    const item=make('button',(marked.includes(chat.id)?'★ ':'')+chat.title);
    item.type='button';item.className='chat-button';
    item.classList.toggle('selected',selected?.id===chat.id);
    item.dataset.chatId=chat.id;
    const reasons=follow.get(chat.id)||[];
    item.append(make('span',reasons.length?reasons.join(' ／ '):chat.needsRefresh?'手動更新後に開けます':chat.updated?date(chat.updated):marked.includes(chat.id)?'ピン留め':'更新日時を取得できません'));
    item.disabled=busy;
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
  $('followRefresh').classList.toggle('hidden',!statusFilter);
  $('chatFilterStatus').textContent=statusFilter&&!followChecked?'「対応状況を確認」を押してください。':'';
}
function applyVisibility(){
  const excluded=new Set([...hiddenChats().map(row=>row.id),...laterChats().map(row=>row.chat_id),...leadChats().map(row=>row.id)]);
  if(selected&&excluded.has(selected.id)){
    selected=null;messageId=null;conversationVersion=null;
    $('history').replaceChildren();$('candidates').replaceChildren();
    $('name').textContent='相手を選んでください';
  }
  chats=chats.filter(chat=>!excluded.has(chat.id)).slice(0,LIST_LIMIT);
  hideSelection.clear();
  render();controls();
  return excluded;
}
function applyRestoredChats(records){
  $('chatQuery').value='';
  $('chatFilter').value='all';
  const existing=new Map(chats.map(chat=>[chat.id,chat]));
  const restored=records.map(record=>{
    const id=record.chat_id||record.id;
    return existing.get(id)||{id,title:record.title||'トーク',needsRefresh:true};
  });
  const incoming=new Set(restored.map(chat=>chat.id));
  chats=[...restored,...chats.filter(chat=>!incoming.has(chat.id))];
  applyVisibility();
}
async function load(query='', openChat=null, releasedIds=null){
  if(busy||syncing)return false;
  syncing=true;controls();
  const scope=window.salesDeskScope?.();
  const status=$('chatLoadStatus');
  const hadList=chats.length>0;
  let primaryShown=false;
  status.textContent=hadList?'更新中…':'取得中…';
  hideSelection.clear();
  try{
    await syncPreferences();
    const ids=[...new Set([...(openChat?[openChat]:[]),...(releasedIds||[]),...pins(),...chats.filter(chat=>chat.needsRefresh).map(chat=>chat.id)])].slice(0,12);
    const excluded=applyVisibility();
    const excludedPayload=excluded.size<=50?[...excluded]:[];
    const visible=new Map(), seenCursors=new Set();
    let cursor=null;
    do{
      const response=await request('chats',{
        count:primaryShown?RESERVE_LIMIT:DISPLAY_LIMIT, paged:true,
        ...(synchronized?{saved_exclusions:true}:{}),
        ...(query?{query}:{}),
        ...(!cursor&&ids.length?{pins:ids}:{}),
        ...(cursor?{cursor}:{}),
        ...(excludedPayload.length?{excluded:excludedPayload}:{})
      },true);
      if(scope!==window.salesDeskScope?.())return false;
      for(const chat of response.chats)if(!excluded.has(chat.id))visible.set(chat.id,chat);
      cursor=response.next_cursor;
      if(cursor&&seenCursors.has(cursor))cursor=null;
      if(cursor)seenCursors.add(cursor);
      if(!primaryShown&&(!hadList||visible.size>=DISPLAY_LIMIT||!cursor)){
        chats=[...visible.values()].slice(0,DISPLAY_LIMIT);
        render();
      }
      if(!primaryShown&&(visible.size>=DISPLAY_LIMIT||!cursor)){
        primaryShown=true;
        status.textContent=cursor&&visible.size<LIST_LIMIT?'予備を取得中…':'';
      }
    }while(cursor&&visible.size<LIST_LIMIT);
    chats=[...visible.values()].slice(0,LIST_LIMIT);
    render();
    const found=openChat&&chats.find(row=>row.id===openChat);
    if(found&&found.id!==selected?.id)choose(found);
    status.textContent='';
    if(releasedIds===null&&laterChats().length)void refreshDeferred(query,scope);
    return true;
  }catch(error){
    if(scope===window.salesDeskScope?.())status.textContent=(primaryShown?'予備を取得できませんでした。':'一覧を更新できませんでした。')+' '+error.message;
    return false;
  }
  finally{syncing=false;controls();}
}
async function refreshDeferred(query,scope){
  // Let the browser paint the list before requesting deferred-chat updates.
  await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
  if(busy||syncing||window.salesDeskScope?.()!==scope)return;
  let released;
  syncing=true;controls();
  try{released=await checkLater();}
  catch(error){released={ids:[],checkError:error.message};}
  finally{syncing=false;controls();}
  if(window.salesDeskScope?.()!==scope)return;
  if(released.ids.length)await load(query,selected?.id,released.ids);
  if(released.checkError)$('chatFilterStatus').textContent='あとで見るの新着確認：'+released.checkError;
}
$('loadChats').onclick=()=>{$('chatQuery').value='';$('chatFilter').value='all';return load();};
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
  if(await updatePreferences('hide',records,true)){batch=false;applyVisibility();}
};
$('chatBatchRestore').onclick=async()=>{
  const records=hiddenChats().filter(row=>restoreSelection.has(row.id));
  if(records.length&&await updatePreferences('hide',records,false)){
    restoreSelection.clear();
    applyRestoredChats(records);
  }
};
$('laterChat').onclick=()=>{
  if(busy||syncing||!selected)return;
  const open=$('laterChatForm').classList.contains('hidden');
  showLaterForm(open);
  if(open){$('laterReturnOn').min=jstToday();$('laterReturnOn').focus();}
};
$('laterCancel').onclick=()=>showLaterForm(false);
function showBatchLater(open){
  $('chatBatchLaterForm').classList.toggle('hidden',!open);
  $('chatBatchLater').setAttribute('aria-expanded',String(open));
  if(!open)$('chatBatchReturnOn').value='';
}
$('chatBatchLater').onclick=()=>{
  if(busy||syncing||!hideSelection.size)return;
  showBatchLater(true);
  $('chatBatchReturnOn').min=jstToday();
  $('chatBatchReturnOn').focus();
};
$('chatBatchLaterCancel').onclick=()=>showBatchLater(false);
async function deferChats(records,returnOn){
  if(busy||syncing||!records.length)return false;
  if(records.some(record=>record.id.length>256)||(returnOn&&returnOn<jstToday())){
    $('chatFilterStatus').textContent='戻す日またはトークを確認してください。';
    return false;
  }
  syncing=true;controls();
  const deferredAt=new Date().toISOString();
  try{
    await syncPreferences(records.map(record=>({kind:'later',chat_id:record.id,title:record.title.slice(0,200),
      active:true,deferred_at:deferredAt,return_on:returnOn||null})));
    return true;
  }catch(error){$('chatFilterStatus').textContent=error.message;return false;}
  finally{syncing=false;controls();}
}
$('laterChatForm').onsubmit=async event=>{
  event.preventDefault();
  if(selected&&await deferChats([selected],$('laterReturnOn').value)){
    showLaterForm(false);
    applyVisibility();
  }
};
$('chatBatchLaterForm').onsubmit=async event=>{
  event.preventDefault();
  const records=chats.filter(record=>hideSelection.has(record.id));
  if(await deferChats(records,$('chatBatchReturnOn').value)){
    batch=false;
    showBatchLater(false);
    applyVisibility();
  }
};
$('laterRestoreSelected').onclick=async()=>{
  if(busy||syncing||!laterSelection.size)return;
  const records=laterChats().filter(record=>laterSelection.has(record.chat_id));
  syncing=true;controls();
  try{await restoreLater(records);}
  catch(error){$('chatFilterStatus').textContent=error.message;return;}
  finally{syncing=false;controls();}
  applyRestoredChats(records);
};
async function moveToLeads(records){
  if(!records.length)return;
  if(records.some(record=>record.id.length>256)){
    $('chatFilterStatus').textContent='選択したトークを優先リードに移せません。';
    return;
  }
  if(await updatePreferences('lead',records,true)){
    batch=false;
    applyVisibility();
    $('leadChatSettings').open=true;
  }
}
$('leadChat').onclick=()=>selected&&moveToLeads([selected]);
$('chatBatchLead').onclick=()=>moveToLeads(chats.filter(record=>hideSelection.has(record.id)));
$('leadRestoreSelected').onclick=async()=>{
  const records=leadChats().filter(record=>leadSelection.has(record.id));
  if(records.length&&await updatePreferences('lead',records,false))applyRestoredChats(records);
};
$('hideChat').onclick=async()=>{
  if(busy||syncing||!selected)return;
  if(selected.id.length>256){$('chatFilterStatus').textContent='このトークを非表示にできません。';return;}
  if(!confirm('「'+selected.title+'」を一覧から隠しますか？'))return;
  if(await updatePreferences('hide',[selected],true))applyVisibility();
};
$('pinChat').onclick=async()=>{
  if(busy||syncing||!selected)return;
  const ids=pins(),exists=ids.includes(selected.id);
  if(selected.id.length>256||(!exists&&ids.length>=12)){$('chatFilterStatus').textContent='このトークをピン留めできません。上限は12件です。';return;}
  if(await updatePreferences('pin',[selected],!exists)){render();controls();}
};
window.salesDesk={
  hasChats:()=>chats.length>0,
  chatIds:()=>chats.filter(chat=>!chat.needsRefresh).map(chat=>chat.id),
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
const lineTabs=[$('directTab'),$('groupTab')];
function activateLineTab(tab){
  for(const button of lineTabs){
    const active=button===tab;
    button.setAttribute('aria-selected',String(active));
    button.tabIndex=active?0:-1;
    $(button.getAttribute('aria-controls')).classList.toggle('hidden',!active);
  }
}
for(const tab of lineTabs){
  tab.onclick=()=>activateLineTab(tab);
  tab.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const next=event.key==='Home'?lineTabs[0]:event.key==='End'?lineTabs[1]:lineTabs.find(button=>button!==tab);
    activateLineTab(next);
    next.focus();
  };
}
let activeGroup=null, groupLoaded=false;
function clearGroupConversation(){
  activeGroup=null;
  groupLoaded=false;
  $('groupName').textContent='グループを選んでください';
  $('groupHistoryStatus').textContent='';
  $('groupHistory').replaceChildren();
  $('groupSummary').replaceChildren();
}
function selectGroup(group,button){
  if(busy)return;
  clearGroupConversation();
  activeGroup=group.id;
  $('groupName').textContent=group.title;
  for(const item of $('groupList').children){
    const current=item===button;
    item.classList.toggle('selected',current);
    item.setAttribute('aria-pressed',String(current));
  }
  controls();
}
$('loadGroupHistory').onclick=async()=>{
  if(busy||!activeGroup)return;
  const scope=window.salesDeskScope?.();
  groupLoaded=false;
  $('groupHistory').replaceChildren();
  $('groupSummary').replaceChildren();
  $('groupHistoryStatus').textContent='会話を取得中…';
  try{
    const result=await request('conversation',{chat_id:activeGroup,group:true});
    if(scope!==window.salesDeskScope?.())return;
    for(const message of result.messages){
      const row=make('div',message.text);
      row.className='message';
      row.prepend(make('small',[message.speaker,message.timestamp?date(message.timestamp):''].filter(Boolean).join(' · ')));
      $('groupHistory').append(row);
    }
    groupLoaded=result.messages.length>0;
    $('groupHistoryStatus').textContent=groupLoaded?'':'表示できるテキストはありません。';
  }catch(error){
    if(scope===window.salesDeskScope?.())$('groupHistoryStatus').textContent=error.message;
  }finally{controls();}
};
$('loadGroups').onclick=async()=>{
  if(busy)return;
  const scope=window.salesDeskScope?.();
  $('groupStatus').textContent='一覧を取得中…';
  try{
    const result=await request('chats',{groups:true});
    if(scope!==window.salesDeskScope?.())return;
    clearGroupConversation();
    const buttons=result.chats.map(group=>{
      const button=make('button',group.title);
      button.type='button';
      button.className='chat-button';
      button.append(make('span',date(group.updated)));
      button.setAttribute('aria-pressed','false');
      button.onclick=()=>selectGroup(group,button);
      return button;
    });
    $('groupList').replaceChildren(...buttons);
    $('groupStatus').textContent=buttons.length?'':'グループLINEが見つかりませんでした。';
  }catch(error){
    if(scope===window.salesDeskScope?.())$('groupStatus').textContent=error.message;
  }finally{controls();}
};
$('groupSummaryButton').onclick=async()=>{
  if(busy||!groupLoaded)return;
  const scope=window.salesDeskScope?.();
  $('groupHistoryStatus').textContent='Macで要点を整理中…';
  try{
    const {summary}=await request('conversation',{chat_id:activeGroup,group:true,summarize:true});
    if(scope!==window.salesDeskScope?.())return;
    const list=make('dl','');
    for(const [key,label] of Object.entries({decisions:'決まったこと',requests:'自分への依頼',schedule:'次の予定'})){
      list.append(make('dt',label),make('dd',summary[key]));
    }
    $('groupSummary').replaceChildren(list);
    $('groupHistoryStatus').textContent='';
  }catch(error){
    if(scope===window.salesDeskScope?.())$('groupHistoryStatus').textContent=error.message;
  }
};
controls=function(){
  baseControls();
  const scope=window.salesDeskScope?.();
  if(pinScope!==scope){clearGroupConversation();$('groupList').replaceChildren();$('groupStatus').textContent='';$('chatLoadStatus').textContent='';synchronized=null;batch=false;hideSelection.clear();restoreSelection.clear();laterSelection.clear();leadSelection.clear();if(chats.length){chats=[];follow.clear();followChecked=false;render();}}
  pinScope=scope;
  if(lastChat!==selected?.id){
    lastChat=selected?.id;
    showLaterForm(false);
    $('laterReturnOn').value='';
    $('chatOverviewStatus').textContent='案件を確認中…';
    $('overviewNotes').open=false;
    $('overviewNotes').classList.add('hidden');
    $('overviewNoteItems').replaceChildren();
  }
  $('chatOverview').classList.toggle('hidden',!selected);
  $('loadChats').disabled||=syncing;
  $('loadGroups').disabled=busy;
  $('loadGroupHistory').disabled=busy||!activeGroup;
  $('groupSummaryButton').disabled=busy||!groupLoaded;
  for(const button of $('groupList').children)button.disabled=busy;
  $('pinChat').disabled=busy||syncing||!selected;
  $('hideChat').disabled=busy||syncing||!selected;
  const isLead=leadChats().some(row=>row.id===selected?.id);
  $('leadChat').hidden=isLead;
  $('leadChat').disabled=busy||syncing||!selected;
  $('hideChat').hidden=isLead;
  $('laterChat').hidden=isLead;
  $('laterChat').disabled=busy||syncing||!selected;
  for(const field of $('laterChatForm').elements)field.disabled=busy||syncing;
  renderLeads();
  renderLater();
  $('chats').querySelectorAll('input[type=checkbox]').forEach(check=>check.disabled=busy||syncing);
  renderHidden();
  $('pinChat').textContent=pins().includes(selected?.id)?'ピン留め解除':'ピン留め';
  $('chatQuery').disabled=busy;
  $('chatFilter').disabled=busy;
  $('chatSearchForm').querySelector('button').disabled=busy||syncing;
};
controls();
})();
