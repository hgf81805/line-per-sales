/* Attio writes happen only after the user confirms a concrete change. */
(() => {
'use strict';
let snapshot=null,linked=null,offset=0,lineId=null;
const operations=new Map(), baseControls=controls;
const note=text=>{$('attioNotice').textContent=text;};
function selectedDeal(){return snapshot?.deals.find(d=>d.id===$('attioDeal').value)||linked?.deal;}
function manageControls(){
  const connected=!$('connected').classList.contains('hidden');
  $('attioSales').classList.toggle('hidden',!connected);
  $('attioSelectedLine').textContent=selected?'選択中のLINE：'+selected.title:'LINEの相手を選択してください。';
  if(lineId!==selected?.id){lineId=selected?.id;linked=null;$('attioDealInfo').textContent='案件一覧を更新して紐付けを確認してください。';$('attioTasks').replaceChildren();$('attioOpen').classList.add('hidden');}
  for(const id of ['attioRefresh','attioConnect','attioDisconnect'])$(id).disabled=busy;
  $('attioLink').disabled=busy||!selected||!$('attioDeal').value;
  $('attioUnlink').disabled=busy||!selected||!linked?.deal;
  $('attioCreate').disabled=busy||!snapshot||!$('attioNewName').value.trim();
  $('attioStageSave').disabled=busy||!linked?.deal||$('attioDeal').value!==linked.deal.id;
  $('attioTaskCreate').disabled=busy||!linked?.deal||$('attioDeal').value!==linked.deal.id||!$('attioTaskText').value.trim();
  $('attioPrevious').disabled=busy||offset===0;$('attioNext').disabled=busy||!snapshot?.has_more;
  for(const id of ['attioDeal','attioStage','attioOwner','attioNewName','attioTaskText','attioDeadline'])$(id).disabled=busy||!snapshot;
  document.querySelectorAll('[data-attio-task]').forEach(button=>button.disabled=busy);
}
controls=function(){baseControls();manageControls();};
function options(id,values,label){const select=$(id),value=select.value;select.replaceChildren();for(const item of values){const option=document.createElement('option');option.value=item.id;option.textContent=label(item);select.appendChild(option);}if(values.some(v=>v.id===value))select.value=value;}
function safeAttioURL(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='app.attio.com'?url.href:null;}catch(e){return null;}}
function showLinked(){
  const deal=linked?.deal;
  $('attioTasks').replaceChildren();
  if(!deal){$('attioDealInfo').textContent='このLINEはまだ案件に紐付いていません。';$('attioOpen').classList.add('hidden');manageControls();return;}
  if(![...$('attioDeal').options].some(o=>o.value===deal.id)){const option=document.createElement('option');option.value=deal.id;option.textContent=deal.name;$('attioDeal').appendChild(option);}
  $('attioDeal').value=deal.id;$('attioStage').value=deal.stage_id;
  if(deal.owner_id)$('attioOwner').value=deal.owner_id;
  $('attioDealInfo').textContent=deal.name+' · '+deal.stage+(deal.stage_since?' · 工程に入った日：'+new Date(deal.stage_since).toLocaleDateString('ja-JP'):'');
  const href=safeAttioURL(deal.url);$('attioOpen').classList.toggle('hidden',!href);if(href)$('attioOpen').href=href;
  for(const task of linked.tasks||[]){
    const row=document.createElement('div');row.className='message';const text=document.createElement('span');text.textContent=task.content+(task.deadline?'（期限：'+new Date(task.deadline).toLocaleString('ja-JP')+'）':'');row.appendChild(text);
    const button=document.createElement('button');button.textContent='完了にする';button.dataset.attioTask=task.id;button.onclick=()=>completeTask(task);row.appendChild(button);$('attioTasks').appendChild(row);
  }
  if(!linked.tasks?.length)$('attioTasks').textContent='未完了の次アクションはありません。';manageControls();
}
async function refresh(){
  snapshot=await request('attio-list',{offset});
  options('attioDeal',snapshot.deals,d=>d.name+' · '+d.stage);options('attioStage',snapshot.stages,s=>s.title);options('attioOwner',snapshot.members,m=>m.name);
  const counts=new Map();for(const deal of snapshot.deals)counts.set(deal.stage,(counts.get(deal.stage)||0)+1);
  $('attioSummary').textContent=(snapshot.profile.workspace_name||'Attio')+' · 表示中'+snapshot.deals.length+'件（'+(offset+1)+'件目から）'+([...counts].map(([name,count])=>name+': '+count+'件').join(' / '));
  $('attioSummary').textContent+=snapshot.storage?.saved?' · Supabaseに保存済み':' · '+(snapshot.storage?.message||'自動保存にはMacアプリv1.7が必要です。');
  if(selected){linked=await request('attio-linked',{chat_id:selected.id});showLinked();}
  else{linked=null;manageControls();}
}
async function write(kind,payload){
  const key=kind+JSON.stringify(payload);if(!operations.has(key))operations.set(key,crypto.randomUUID());
  const result=await request('attio-'+kind,{...payload,operation_id:operations.get(key),confirmed:true});
  operations.delete(key);return result;
}
function handler(id,action){$(id).onclick=async()=>{if(busy)return;try{note('');await action();}catch(e){note(e.message);}finally{manageControls();}};}
handler('attioRefresh',refresh);
handler('attioPrevious',async()=>{offset=Math.max(0,offset-50);await refresh();});
handler('attioNext',async()=>{offset+=50;await refresh();});
handler('attioLink',async()=>{
  const deal=selectedDeal();if(!selected||!deal)return;
  if(!confirm('LINE「'+selected.title+'」をAttioの案件「'+deal.name+'」に紐付けますか？'))return;
  linked=await request('attio-link',{chat_id:selected.id,deal_id:deal.id});showLinked();note('紐付けをMac内に保存しました。');
});
handler('attioUnlink',async()=>{if(!confirm('このLINEと案件の紐付けだけを解除しますか？Attioの案件は削除しません。'))return;linked=await request('attio-unlink',{chat_id:selected.id});showLinked();});
handler('attioCreate',async()=>{
  const name=$('attioNewName').value.trim(),stage_id=$('attioStage').value,owner_id=$('attioOwner').value;
  if(!confirm('Attioに案件「'+name+'」を作成しますか？\n工程：'+$('attioStage').selectedOptions[0].textContent+'\n担当者：'+$('attioOwner').selectedOptions[0].textContent))return;
  const result=await write('create',{name,stage_id,owner_id});
  if(selected)await request('attio-link',{chat_id:selected.id,deal_id:result.id});
  $('attioNewName').value='';await refresh();note('案件を作成しました。');
});
handler('attioStageSave',async()=>{
  const deal=linked?.deal,stage_id=$('attioStage').value;if(!deal)return;
  if(!confirm('Attioの「'+deal.name+'」の工程を「'+deal.stage+'」から「'+$('attioStage').selectedOptions[0].textContent+'」へ更新しますか？'))return;
  await write('stage',{deal_id:deal.id,stage_id,expected_stage_id:deal.stage_id});await refresh();note('工程を更新しました。');
});
handler('attioTaskCreate',async()=>{
  const deal=linked?.deal,content=$('attioTaskText').value.trim(),owner_id=$('attioOwner').value;
  const date=$('attioDeadline').value,deadline=date?new Date(date).toISOString():null;
  if(!deal||!confirm('Attioの「'+deal.name+'」に次アクションを登録しますか？\n'+content+'\n担当者：'+$('attioOwner').selectedOptions[0].textContent+'\n期限：'+(date||'未設定')))return;
  await write('task',{deal_id:deal.id,owner_id,content,deadline});$('attioTaskText').value='';await refresh();note('次アクションを登録しました。');
});
async function completeTask(task){if(busy||!confirm('「'+task.content+'」を完了にしますか？'))return;try{await write('complete',{deal_id:linked.deal.id,task_id:task.id});await refresh();note('次アクションを完了にしました。');}catch(e){note(e.message);}finally{manageControls();}}
function setupFeedback(message, state='info') {
  const status=$('attioSetupStatus');
  status.textContent=message;
  status.dataset.state=state;
}
function setupConnection(state, saved=false) {
  if (!state.connected) {
    setupFeedback(state.error||'Attioは未接続です。',state.error?'error':'info');
    return;
  }
  const message=(saved?'新しいトークンを確認して保存しました。 ':'接続済み：')+
    (state.workspace_name||state.workspace_slug||'Attio')+'。 ';
  if(state.notes_write===false){
    setupFeedback(message+'ノート編集には Notes を「Read & write」にしたトークンが必要です。','warning');
  } else {
    setupFeedback(message+(state.notes_write?'ノートの読み書き権限あり。':'ノート権限は確認できませんでした。'),state.notes_write?'success':'warning');
  }
}
$('attioConnect').onclick=async()=>{
  if(!local||busy)return;
  const input=$('attioToken'),token=input.value.trim();
  if(!token){
    setupFeedback('AttioのAPIトークンを入力してください。','error');
    input.focus();
    return;
  }
  setupFeedback('Attioの接続と権限を確認しています…');
  try{
    const result=await request('attio/configure',{token});
    input.value='';
    setupConnection(result,true);
  }catch(error){
    const message=error instanceof TypeError||error instanceof SyntaxError
      ? 'Macの接続アプリに到達できません。アプリを起動して画面を開き直してください。'
      : error.message;
    setupFeedback('保存できませんでした。 '+message,'error');
    input.focus();
  }
};
handler('attioDisconnect',async()=>{if(!local||!confirm('このMacのAttio接続を解除しますか？'))return;await request('attio/disconnect',{});snapshot=null;linked=null;setupFeedback('接続を解除しました。');$('attioDeal').replaceChildren();$('attioTasks').replaceChildren();});
$('attioDeal').onchange=()=>{const deal=selectedDeal();if(deal)$('attioDealInfo').textContent=deal.name+' · '+deal.stage+(linked?.deal?.id===deal.id?'（このLINEに紐付け済み）':'（未選択の紐付け先）');manageControls();};
for(const id of ['attioNewName','attioTaskText'])$(id).addEventListener('input',manageControls);
if(local){
  $('attioSetup').classList.remove('hidden');
  request('attio/status',{}).then(state=>setupConnection(state)).catch(()=>setupFeedback('Attioの接続状態を取得できませんでした。','error'));
}
controls();
})();

// Suggest a contact for the selected LINE conversation and require confirmation before saving.
(() => {
  const previousControls = controls;
  let chat = null, result = null, pending = false, queued = false;
  function showPanel(open) {
    $('contactPanel').classList.toggle('hidden', !open);
    $('contactToggle').setAttribute('aria-expanded', String(open));
  }
  function render() {
    const matches = $('contactMatches');
    matches.replaceChildren();
    $('contactOptions').classList.toggle('hidden', Boolean(result?.linked));
    $('contactToggle').textContent = result?.linked ? 'Attioの連絡先を確認' :
      'Attioに登録・紐付け' + (result?.candidates?.length ? '（候補あり）' : '');
    if (!result) return;
    if (result.linked) {
      const status = $('contactStatus');
      status.textContent = '紐付け済み：' + result.linked.name;
      try {
        const url = new URL(result.linked.url);
        if (url.origin === 'https://app.attio.com') {
          const link = document.createElement('a');
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Attioで開く ↗';
          status.append(' ', link);
        }
      } catch {}
      if (result.storage && !result.storage.saved) status.append(' ', result.storage.message);
      return;
    }
    $('contactStatus').textContent = result.candidates.length
      ? '候補が見つかりました。名前やメールを確認して選んでください。' + (result.has_more ? ' 候補が多い場合は名前を絞って検索してください。' : '')
      : '一致する名前はありません。名前を変えて検索するか、新規登録できます。';
    for (const person of result.candidates) {
      const row = document.createElement('p');
      row.textContent = [person.name, person.detail, person.job_title].filter(Boolean).join(' · ') + ' ';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'この連絡先に紐付け';
      button.onclick = () => {
        if (!pending && !busy && confirm('LINE「' + chat.title + '」をAttio「' + [person.name, person.detail].filter(Boolean).join(' · ') + '」に紐付けますか？')) {
          run({mode:'link', person_id:person.id, confirmed:true});
        }
      };
      row.append(button);
      matches.append(row);
    }
  }
  async function run(payload) {
    if (!chat || pending || busy) return;
    const target = chat;
    pending = true;
    $('contactStatus').textContent = 'Attioに接続しています…';
    controls();
    try {
      const data = await request('attio-contact', {chat_id:target.id, ...payload});
      if (chat === target) {
        result = data;
        render();
      }
    } catch (error) {
      if (chat === target) $('contactStatus').textContent = error.message;
    } finally {
      pending = false;
      controls();
    }
  }
  controls = function () {
    previousControls();
    if (chat !== selected) {
      chat = selected;
      result = null;
      queued = Boolean(chat);
      showPanel(false);
      $('contactStatus').textContent = '';
      $('contactSearch').value = chat?.title || '';
      $('contactName').value = chat?.title || '';
      render();
    }
    $('contactActions').classList.toggle('hidden', !chat);
    for (const id of ['contactFind', 'contactCreate']) $(id).disabled = busy || pending;
    if (queued && !busy && !pending) {
      queued = false;
      const target = chat;
      setTimeout(() => {
        if (chat === target) run({mode:'lookup'});
      }, 0);
    }
  };
  $('contactToggle').onclick = () => {
    const open = $('contactPanel').classList.contains('hidden');
    showPanel(open);
    if (open && !result && !pending) run({mode:'lookup'});
  };
  $('contactFind').onclick = () => run({mode:'lookup', query:$('contactSearch').value.trim()});
  $('contactCreate').onclick = () => {
    const name = $('contactName').value.trim();
    if (!name) {
      $('contactStatus').textContent = '登録する名前を入力してください。';
      return;
    }
    if (confirm('Attioに「' + name + '」を新規登録し、LINE「' + chat.title + '」に紐付けますか？')) {
      run({mode:'create', name, confirmed:true});
    }
  };
  controls();
})();
