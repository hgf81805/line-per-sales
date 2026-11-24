(() => {
'use strict';
const baseControls=controls;
let chats=[], follow=new Map(), followChecked=false, lastChat=null, pinScope=null;
const make=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
function pins(){
  const scope=window.salesDeskScope?.();
  if(!scope)return [];
  try{return JSON.parse(localStorage.getItem('line-sales-pins:'+scope)||'[]');}catch{return [];}
}
function hiddenChats(){
  const scope=window.salesDeskScope?.();
  if(!scope)return [];
  try{return JSON.parse(localStorage.getItem('line-sales-hidden:'+scope)||'[]');}catch{return [];}
}
function updateHidden(records){
  const scope=window.salesDeskScope?.();
  if(!scope)return false;
  try{localStorage.setItem('line-sales-hidden:'+scope,JSON.stringify(records));return true;}
  catch{$('chatFilterStatus').textContent='このブラウザに保存できませんでした。';return false;}
}
function renderHidden(){
  const records=hiddenChats();
  const area=$('hiddenChatItems');
  area.replaceChildren();
  $('hiddenChatSettings').hidden=!records.length;
  for(const record of records){
    const restore=make('button',record.title+' を戻す');
    restore.type='button';
    restore.disabled=busy;
    restore.onclick=()=>{
      if(!busy&&updateHidden(hiddenChats().filter(row=>row.id!==record.id)))load($('chatQuery').value.trim());
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
  if(busy)return false;
  selected=null;messageId=null;conversationVersion=null;
  chats=[];follow.clear();followChecked=false;
  $('followResults').replaceChildren();$('history').replaceChildren();$('candidates').replaceChildren();
  $('name').textContent='相手を選んでください';$('chats').textContent='取得中…';
  try{
    const ids=pins();
    const excluded=hiddenChats().map(row=>row.id);
    const response=await request('chats',{count:10,...(excluded.length?{excluded}:{}),...(query?{query}:{}),...(ids.length?{pins:ids}:{} )});
    chats=response.chats;
    render();
    return true;
  }catch(error){$('chats').textContent=error.message;return false;}
  finally{controls();}
}
$('loadChats').onclick=()=>{$('chatQuery').value='';return load();};
$('chatSearchForm').onsubmit=event=>{event.preventDefault();load($('chatQuery').value.trim());};
$('chatFilter').onchange=render;
$('hideChat').onclick=()=>{
  if(busy||!selected)return;
  const records=hiddenChats();
  if(records.length>=50||selected.id.length>256){$('chatFilterStatus').textContent='このトークを非表示にできません。';return;}
  if(!confirm('「'+selected.title+'」をこのブラウザの一覧から隠しますか？'))return;
  if(updateHidden([...records,{id:selected.id,title:selected.title}]))load($('chatQuery').value.trim());
};
$('pinChat').onclick=()=>{
  if(busy||!selected)return;
  const scope=window.salesDeskScope?.();
  if(!scope)return;
  const ids=pins(), exists=ids.includes(selected.id);
  if(!exists&&ids.length>=12){$('chatFilterStatus').textContent='ピン留めは12件までです。';return;}
  try{localStorage.setItem('line-sales-pins:'+scope,JSON.stringify(exists?ids.filter(id=>id!==selected.id):[...ids,selected.id]));}
  catch{$('chatFilterStatus').textContent='このブラウザにピン留めを保存できませんでした。';return;}
  render();controls();
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
  if(pinScope!==scope&&chats.length){chats=[];follow.clear();followChecked=false;render();}
  pinScope=scope;
  if(lastChat!==selected?.id){
    lastChat=selected?.id;
    $('chatOverviewStatus').textContent='案件を確認中…';
    $('overviewNotes').open=false;
    $('overviewNotes').classList.add('hidden');
    $('overviewNoteItems').replaceChildren();
  }
  $('chatOverview').classList.toggle('hidden',!selected);
  $('pinChat').disabled=busy||!selected;
  $('hideChat').disabled=busy||!selected;
  renderHidden();
  $('pinChat').textContent=pins().includes(selected?.id)?'ピン留め解除':'ピン留め';
  $('chatQuery').disabled=busy;
  $('chatFilter').disabled=busy;
  $('chatSearchForm').querySelector('button').disabled=busy;
};
controls();
})();
