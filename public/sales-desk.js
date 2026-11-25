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
const groupPrefix='group:';
function pins(includeGroups=false){
  const rows=synchronized ? synchronized.filter(row=>row.kind==='pin').map(row=>row.chat_id) : stored('pins');
  return rows.filter(id=>id.startsWith(groupPrefix)===includeGroups);
}
function hiddenChats(includeGroups=false){
  const rows=synchronized ? synchronized.filter(row=>row.kind==='hide').map(row=>({id:row.chat_id,title:row.title})) : stored('hidden');
  return rows.filter(row=>row.id.startsWith(groupPrefix)===includeGroups);
}
function laterChats(includeGroups=false){
  const rows=synchronized ? synchronized.filter(row=>row.kind==='later') : stored('later');
  return rows.filter(row=>row.chat_id.startsWith(groupPrefix)===includeGroups);
}
function leadChats(includeGroups=false){
  const rows=synchronized ? synchronized.filter(row=>row.kind==='lead').map(row=>({id:row.chat_id,title:row.title})) : stored('lead');
  return rows.filter(row=>row.id.startsWith(groupPrefix)===includeGroups);
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
  const oldPins=stored('pins',scope).filter(id=>typeof id==='string'&&id.length>0&&id.length<=256);
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
    if(selection===groupSelection||groupShelves.some(shelf=>shelf.selection===selection))updateGroupControls();
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
const mobileTalk=matchMedia('(max-width: 760px)');
const listPosition=new Map();
const listFocus=new Map();
function openMobileTalk(kind){
  if(!mobileTalk.matches)return;
  const panel=$(kind+'Panel');
  if(!panel.classList.contains('mobile-detail')){
    listPosition.set(kind,window.scrollY);
    const focused=document.activeElement;
    if(panel.contains(focused))listFocus.set(kind,focused.dataset.mobileChatId||focused.dataset.chatId);
  }
  panel.classList.add('mobile-detail');
  $(kind+'Back').focus({preventScroll:true});
  window.scrollTo(0,0);
}
for(const kind of ['direct','group']){
  $(kind+'Back').onclick=()=>{
    const panel=$(kind+'Panel');
    panel.classList.remove('mobile-detail');
    const previous=[...panel.querySelectorAll('.chat-button')].find(button=>(button.dataset.mobileChatId||button.dataset.chatId)===listFocus.get(kind));
    (previous||$(kind==='direct'?'loadChats':'loadGroups')).focus({preventScroll:true});
    window.scrollTo(0,listPosition.get(kind)||0);
  };
}
function withQuickActions(button,record,isGroup){
  const row=make('div','');
  row.className='mobile-chat-row';
  const actions=document.createElement('details');
  actions.className='mobile-chat-actions';
  const toggle=make('summary','⋯');
  toggle.setAttribute('aria-label',record.title+'を整理');
  const menu=make('div','');
  menu.className='mobile-chat-menu';
  for(const [kind,label] of [['lead','優先リードに移す'],['later','あとで見る'],['hide','一覧から隠す']]){
    const action=make('button',label);
    action.type='button';
    action.dataset.action=kind;
    action.onclick=async()=>{
      if(busy||syncing)return;
      if(kind==='hide'&&!confirm('このトークを一覧から隠しますか？'))return;
      actions.open=false;
      if(isGroup){await moveGroups(kind,true,new Set([record.id]));return;}
      if(kind==='lead'){await moveToLeads([record]);return;}
      if(record.id.length>256){$('chatFilterStatus').textContent='このトークの設定を保存できません。';return;}
      const saved=kind==='later'?await deferChats([record],null):await updatePreferences('hide',[record],true);
      if(saved)applyVisibility();
    };
    menu.append(action);
  }
  actions.ontoggle=()=>{
    if(!actions.open)return;
    for(const other of document.querySelectorAll('.mobile-chat-actions[open]'))if(other!==actions)other.open=false;
  };
  actions.append(toggle,menu);
  row.append(button,actions);
  return row;
}
function choose(chat,fromLead=false){
  if(busy||(!fromLead&&!chats.includes(chat)))return;
  if(chat.needsRefresh){
    $('chatFilterStatus').textContent='会話を開くには「LINE一覧を手動更新」を押してください。';
    return;
  }
  openMobileTalk('direct');
  if(selected?.id===chat.id)return;
  selected=chat;messageId=null;conversationVersion=null;
  $('name').textContent=chat.title;
  $('history').replaceChildren();$('candidates').replaceChildren();
  render();controls();
  if(!mobileTalk.matches)$('chatOverview').scrollIntoView({block:'nearest'});
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
    }else fragment.append(withQuickActions(item,chat,false));
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
$('chatBatchLead').onclick=()=>moveToLeads(chats.filter(record=>hideSelection.has(record.id)));
$('leadRestoreSelected').onclick=async()=>{
  const records=leadChats().filter(record=>leadSelection.has(record.id));
  if(records.length&&await updatePreferences('lead',records,false))applyRestoredChats(records);
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
let groupRows=[],groupBatch=false,groupVersion=null,groupTemplateKey=null,groupTemplateText='';
let groupTicket=null,groupLocked=false;
const groupSelection=new Set();
const groupKindButtons=document.querySelectorAll('[data-group-kind]');
const groupToneButtons=document.querySelectorAll('[data-group-tone]');
const groupShelves=[...document.querySelectorAll('[data-group-shelf]')].map(element=>({
  kind:element.dataset.groupShelf, element, summary:element.querySelector('summary'),
  label:element.querySelector('summary').textContent, items:element.querySelector('.group-shelf-items'),
  restore:element.querySelector('.group-shelf-restore'), selection:new Set()
}));
for(const shelf of groupShelves)shelf.restore.onclick=()=>moveGroups(shelf.kind,false,shelf.selection);

function renderGroupShelves(){
  for(const shelf of groupShelves){
    const records=groupPreferences(shelf.kind).map(row=>({...row,id:row.id.slice(groupPrefix.length)}));
    const available=new Set(records.map(row=>row.id));
    for(const id of shelf.selection)if(!available.has(id))shelf.selection.delete(id);
    shelf.element.hidden=!records.length;
    shelf.summary.textContent=shelf.label+'（'+records.length+'件）';
    shelf.items.replaceChildren();
    for(const group of records){
      const row=make('div','');
      row.className='desk-option';
      const open=make('button',group.title||'グループ');
      open.type='button';
      open.className='chat-button';
      if(group.returnOn)open.append(make('span','次に確認 '+group.returnOn));
      open.onclick=()=>selectGroup(group,open);
      row.append(checkbox({...group,title:group.title||'グループ'},shelf.selection),open);
      shelf.items.append(row);
    }
  }
}

function groupPreferences(kind){
  if(kind==='lead')return leadChats(true);
  if(kind==='hide')return hiddenChats(true);
  if(kind==='later')return laterChats(true).map(row=>({id:row.chat_id,title:row.title,returnOn:row.return_on}));
  return pins(true).map(id=>({id}));
}
function renderGroups(){
  const filter=$('groupFilter').value;
  const excluded=new Set(['lead','later','hide'].flatMap(kind=>groupPreferences(kind)).map(row=>row.id));
  const records=filter==='all'||filter==='pin'
    ? groupRows.filter(row=>!excluded.has(groupPrefix+row.id)&&(filter==='all'||pins(true).includes(groupPrefix+row.id)))
    : groupPreferences(filter).map(row=>({id:row.id.slice(groupPrefix.length),title:row.title||'グループ',returnOn:row.returnOn}));
  const pinned=new Set(pins(true));
  if(filter==='all')records.sort((a,b)=>Number(pinned.has(groupPrefix+b.id))-Number(pinned.has(groupPrefix+a.id)));
  $('groupList').replaceChildren();
  for(const group of (filter==='all'?records.slice(0,DISPLAY_LIMIT):records)){
    const title=(pinned.has(groupPrefix+group.id)?'★ ':'')+group.title;
    if(groupBatch){
      const row=make('label','');
      row.className='desk-option';
      row.append(checkbox(group,groupSelection),make('span',title));
      $('groupList').append(row);
    }else{
      const button=make('button',title);
      button.type='button';
      button.className='chat-button';
      button.classList.toggle('selected',group.id===activeGroup);
      button.setAttribute('aria-pressed',String(group.id===activeGroup));
      if(group.updated||group.returnOn)button.append(make('span',group.returnOn?'次に確認 '+group.returnOn:date(group.updated)));
      button.onclick=()=>selectGroup(group,button);
      button.dataset.mobileChatId=group.id;
      $('groupList').append(filter==='all'||filter==='pin'?withQuickActions(button,group,true):button);
    }
  }
  if(!records.length)$('groupList').append(make('p','該当するグループはありません。'));
  renderGroupShelves();
  updateGroupControls();
}
function updateGroupControls(){
  const canReply=Boolean(groupVersion)&&!busy&&!groupLocked;
  for(const shelf of groupShelves){
    shelf.restore.disabled=busy||syncing||!shelf.selection.size;
    for(const control of shelf.items.querySelectorAll('button,input'))control.disabled=busy||syncing;
  }
  $('groupBatch').classList.toggle('hidden',!groupBatch);
  $('groupMulti').setAttribute('aria-pressed',String(groupBatch));
  $('groupMulti').textContent=groupBatch?'選択を終了':'複数選択';
  $('groupCount').textContent=groupSelection.size+'件選択';
  const parked=['lead','later','hide'].includes($('groupFilter').value);
  for(const button of groupKindButtons){
    button.hidden=parked;
    button.disabled=busy||syncing||!groupSelection.size;
  }
  $('restoreGroups').hidden=!parked;
  $('restoreGroups').disabled=busy||syncing||!groupSelection.size;
  $('pinGroup').disabled=busy||syncing||!activeGroup;
  $('scheduleGroup').disabled=busy||syncing||!groupRows.some(row=>row.id===activeGroup)||groupPreferences('later').some(row=>row.id===groupPrefix+activeGroup);
  $('pinGroup').textContent=pins(true).includes(groupPrefix+activeGroup)?'ピン留めを解除':'ピン留め';
  for(const id of ['groupReplyText','groupTemplate','insertGroupTemplate','groupPurpose'])$(id).disabled=!canReply;
  for(const button of groupToneButtons)button.disabled=!canReply||!groupTemplateKey;
  $('prepareGroupSend').disabled=!canReply||!$('groupReplyText').value.trim();
  $('groupDraft').disabled=!canReply||!groupLoaded;
}
$('groupMulti').onclick=()=>{groupBatch=!groupBatch;groupSelection.clear();renderGroups();};
$('groupFilter').onchange=()=>{groupSelection.clear();renderGroups();};
async function moveGroups(kind,active,selectedIds=groupSelection,returnOn=null){
  const source=active?groupRows:groupPreferences(kind).map(row=>({id:row.id.slice(groupPrefix.length),title:row.title}));
  const records=source.filter(row=>selectedIds.has(row.id)).map(row=>({id:groupPrefix+row.id,title:row.title}));
  if(!records.length||busy||syncing)return;
  if(records.some(row=>row.id.length>256)){
    $('groupStatus').textContent='選択したグループの設定を保存できません。';
    return;
  }
  if(kind==='later'&&active){
    syncing=true;controls();
    try{
      const deferredAt=new Date().toISOString();
      await syncPreferences(records.map(row=>({chat_id:row.id,title:row.title.slice(0,200),kind,active,deferred_at:deferredAt,return_on:returnOn})));
    }catch(error){$('groupStatus').textContent=error.message;return;}
    finally{syncing=false;controls();}
  }else if(kind==='later'){
    syncing=true;controls();
    try{await restoreLater(laterChats(true).filter(row=>selectedIds.has(row.chat_id.slice(groupPrefix.length))));}
    catch(error){$('groupStatus').textContent=error.message;return;}
    finally{syncing=false;controls();}
  }else if(!await updatePreferences(kind,records,active))return;
  if(active&&selectedIds.has(activeGroup))clearGroupConversation();
  if(!active){
    const existing=new Set(groupRows.map(row=>row.id));
    groupRows.unshift(...records.map(row=>({id:row.id.slice(groupPrefix.length),title:row.title})).filter(row=>!existing.has(row.id)));
    $('groupFilter').value='all';
  }
  selectedIds.clear();
  groupSelection.clear();
  groupBatch=false;
  renderGroups();
}
for(const button of groupKindButtons)button.onclick=()=>moveGroups(button.dataset.groupKind,true);
$('restoreGroups').onclick=()=>moveGroups($('groupFilter').value,false);
$('scheduleGroup').onclick=()=>{
  $('groupFollowDate').min=jstToday();
  $('groupFollowForm').classList.toggle('hidden');
};
$('groupFollowForm').onsubmit=event=>{
  event.preventDefault();
  const day=$('groupFollowDate').value;
  if(activeGroup&&day>=jstToday())moveGroups('later',true,new Set([activeGroup]),day);
};
$('pinGroup').onclick=async()=>{
  if(!activeGroup)return;
  const id=groupPrefix+activeGroup;
  if(id.length<=256&&await updatePreferences('pin',[{id,title:''}],!pins(true).includes(id)))renderGroups();
};
function putGroupDraft(value){
  const field=$('groupReplyText');
  if(field.disabled||(field.value.trim()&&field.value!==groupTemplateText&&!confirm('下書きを置き換えますか？')))return false;
  field.value=value.slice(0,1000);
  field.focus();
  updateGroupControls();
  return true;
}
$('groupReplyText').oninput=updateGroupControls;
function applyGroupTemplate(key,tone){
  const value=window.lineReplyTemplate(key,tone);
  if(value&&putGroupDraft(value)){
    groupTemplateKey=key;
    groupTemplateText=$('groupReplyText').value;
    updateGroupControls();
  }
}
$('insertGroupTemplate').onclick=()=>applyGroupTemplate($('groupTemplate').value,'standard');
for(const button of groupToneButtons)button.onclick=()=>applyGroupTemplate(groupTemplateKey,button.dataset.groupTone);
$('groupDraft').onclick=async()=>{
  if(busy||!groupLoaded)return;
  const scope=window.salesDeskScope?.();
  const candidates=$('groupCandidates');
  candidates.replaceChildren();
  $('groupSendNotice').textContent='Macで返信案を作成中…';
  try{
    const result=await request('conversation',{chat_id:activeGroup,group:true,reply_purpose:$('groupPurpose').value});
    if(scope!==window.salesDeskScope?.())return;
    for(const text of result.candidates){
      const card=make('div','');
      card.className='candidate';
      const button=make('button','この案を下書きに入れる');
      button.type='button';
      button.onclick=()=>putGroupDraft(text);
      card.append(make('p',text),button);
      candidates.append(card);
    }
    $('groupSendNotice').textContent='';
  }catch(error){if(scope===window.salesDeskScope?.())$('groupSendNotice').textContent=error.message;}
};
$('prepareGroupSend').onclick=async()=>{
  if(busy||groupLocked||!groupVersion)return;
  const scope=window.salesDeskScope?.();
  try{
    const review=await request('prepare-send',{chat_id:activeGroup,group:true,text:$('groupReplyText').value,conversation_version:groupVersion});
    if(scope!==window.salesDeskScope?.()||review.chat_id!==activeGroup)return;
    groupTicket=review.ticket_id;
    $('groupConfirmTarget').textContent=review.title+' · '+review.account_id;
    $('groupConfirmText').textContent=review.text;
    $('groupSendDialog').showModal();
  }catch(error){if(scope===window.salesDeskScope?.())$('groupSendNotice').textContent=error.message;}
};
$('cancelGroupSend').onclick=()=>$('groupSendDialog').close();
function groupSendResult(result){
  const accepted=result.status==='accepted';
  $('checkGroupSend').hidden=accepted;
  $('groupSendNotice').textContent=accepted?'Beeperが送信を受け付けました。':'送信結果が不明です。再送前にLINEで確認してください。';
  if(accepted){$('groupReplyText').value='';groupVersion=null;groupTicket=null;}
  controls();
}
$('finalGroupSend').onclick=async()=>{
  if(busy||!groupTicket||groupLocked)return;
  const scope=window.salesDeskScope?.();
  groupLocked=true;
  $('groupSendDialog').close();
  try{
    const result=await request('send',{ticket_id:groupTicket});
    if(scope===window.salesDeskScope?.())groupSendResult(result);
  }catch{
    if(scope===window.salesDeskScope?.())groupSendResult({status:'unknown'});
  }
};
$('checkGroupSend').onclick=async()=>{
  if(busy||!groupTicket)return;
  const scope=window.salesDeskScope?.();
  try{
    const result=await request('send-status',{ticket_id:groupTicket});
    if(scope===window.salesDeskScope?.())groupSendResult(result);
  }catch(error){if(scope===window.salesDeskScope?.())$('groupSendNotice').textContent=error.message;}
};
let activeGroup=null, groupLoaded=false;
function clearGroupConversation(){
  activeGroup=null;
  groupLoaded=false;
  groupVersion=null;groupTicket=null;groupLocked=false;groupTemplateKey=null;groupTemplateText='';
  $('groupReplyText').value='';
  $('groupFollowForm').classList.add('hidden');
  $('groupFollowDate').value='';
  $('groupCandidates').replaceChildren();
  $('groupSendNotice').textContent='';
  $('checkGroupSend').hidden=true;
  if($('groupSendDialog').open)$('groupSendDialog').close();
  $('groupName').textContent='グループを選んでください';
  $('groupHistoryStatus').textContent='';
  $('groupHistory').replaceChildren();
  $('groupSummary').replaceChildren();
}
function selectGroup(group,button){
  if(busy)return;
  openMobileTalk('group');
  if(activeGroup===group.id)return;
  clearGroupConversation();
  activeGroup=group.id;
  $('groupName').textContent=group.title;
  for(const item of $('groupPanel').querySelectorAll('.chat-button')){
    const current=item===button;
    item.classList.toggle('selected',current);
    item.setAttribute('aria-pressed',String(current));
  }
  controls();
}
$('loadGroupHistory').onclick=async()=>{
  if(busy||!activeGroup)return;
  if(groupLocked&&!$('checkGroupSend').hidden&&!confirm('送信結果をLINEで確認してから、会話を読み込み直しますか？'))return;
  groupLocked=false;groupTicket=null;groupVersion=null;
  $('checkGroupSend').hidden=true;
  $('groupSendNotice').textContent='';
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
    groupVersion=result.conversation_version||null;
    $('groupHistoryStatus').textContent=groupLoaded?'':'表示できるテキストはありません。';
  }catch(error){
    if(scope===window.salesDeskScope?.())$('groupHistoryStatus').textContent=error.message;
  }finally{controls();}
};
async function loadGroupList(query=''){
  if(busy||syncing)return;
  const scope=window.salesDeskScope?.();
  $('groupStatus').textContent='一覧を取得中…';
  syncing=true;controls();
  try{
    await syncPreferences();
    const due=laterChats(true).filter(row=>row.return_on&&row.return_on<=jstToday());
    if(due.length)await restoreLater(due);
    const result=await request('chats',{groups:true,...(query?{query}:{})});
    if(scope!==window.salesDeskScope?.())return;
    groupRows=result.chats;
    groupSelection.clear();
    $('groupFilter').value='all';
    renderGroups();
    $('groupStatus').textContent='';
  }catch(error){
    if(scope===window.salesDeskScope?.())$('groupStatus').textContent=error.message;
  }finally{syncing=false;controls();}
}
$('loadGroups').onclick=()=>{$('groupQuery').value='';loadGroupList();};
$('groupSearchForm').onsubmit=event=>{event.preventDefault();loadGroupList($('groupQuery').value.trim());};
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
for(const [kind,history,field,ai] of [
  ['direct','loadHistory','replyText','purposeDraft'],
  ['group','loadGroupHistory','groupReplyText','groupDraft']
]){
  async function openReply(useAI){
    if(busy)return;
    if($(field).disabled&&$(history).disabled===false)await $(history).onclick();
    if($(field).disabled)return;
    if(useAI&&!$(ai).disabled)$(ai).click();
    $(field).scrollIntoView({block:'center'});
    if(!useAI)$(field).focus({preventScroll:true});
  }
  $(kind+'Write').onclick=()=>openReply(false);
  $(kind+'AI').onclick=()=>openReply(true);
}
controls=function(){
  baseControls();
  const scope=window.salesDeskScope?.();
  if(pinScope!==scope){$('directPanel').classList.remove('mobile-detail');$('groupPanel').classList.remove('mobile-detail');listPosition.clear();listFocus.clear();groupRows=[];groupSelection.clear();for(const shelf of groupShelves)shelf.selection.clear();groupBatch=false;clearGroupConversation();$('groupList').replaceChildren();$('groupStatus').textContent='';$('chatLoadStatus').textContent='';synchronized=null;batch=false;hideSelection.clear();restoreSelection.clear();laterSelection.clear();leadSelection.clear();if(chats.length){chats=[];follow.clear();followChecked=false;render();}}
  pinScope=scope;
  if(lastChat!==selected?.id){
    lastChat=selected?.id;
    $('chatOverviewStatus').textContent='案件を確認中…';
    $('overviewNotes').open=false;
    $('overviewNotes').classList.add('hidden');
    $('overviewNoteItems').replaceChildren();
  }
  $('chatOverview').classList.toggle('hidden',!selected);
  if(!selected)$('directPanel').classList.remove('mobile-detail');
  if(!activeGroup)$('groupPanel').classList.remove('mobile-detail');
  for(const id of ['directWrite','directAI','groupWrite','groupAI'])$(id).disabled=busy;
  $('loadChats').disabled||=syncing;
  if(groupShelves.some(shelf=>shelf.summary.textContent!==shelf.label+'（'+groupPreferences(shelf.kind).length+'件）'))renderGroupShelves();
  $('loadGroups').disabled=busy||syncing;
  $('groupMulti').disabled=busy||syncing;
  $('groupFilter').disabled=busy||syncing;
  $('groupSearchForm').querySelector('button').disabled=busy||syncing;
  updateGroupControls();
  $('loadGroupHistory').disabled=busy||!activeGroup;
  $('groupSummaryButton').disabled=busy||!groupLoaded;
  for(const input of $('groupList').querySelectorAll('button,input'))input.disabled=busy||syncing;
  $('pinChat').disabled=busy||syncing||!selected;
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
