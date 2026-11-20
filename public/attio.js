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
handler('attioConnect',async()=>{if(!local)return;const token=$('attioToken').value;$('attioToken').value='';const result=await request('attio/configure',{token});$('attioSetupStatus').textContent='接続先：'+result.workspace_name;await refresh();});
handler('attioDisconnect',async()=>{if(!local||!confirm('このMacのAttio接続を解除しますか？'))return;await request('attio/disconnect',{});snapshot=null;linked=null;$('attioSetupStatus').textContent='接続を解除しました。';$('attioDeal').replaceChildren();$('attioTasks').replaceChildren();});
$('attioDeal').onchange=()=>{const deal=selectedDeal();if(deal)$('attioDealInfo').textContent=deal.name+' · '+deal.stage+(linked?.deal?.id===deal.id?'（このLINEに紐付け済み）':'（未選択の紐付け先）');manageControls();};
for(const id of ['attioNewName','attioTaskText'])$(id).addEventListener('input',manageControls);
if(local){$('attioSetup').classList.remove('hidden');request('attio/status',{}).then(state=>{$('attioSetupStatus').textContent=state.connected?'接続先：'+state.workspace_name:'Attioは未接続です。';}).catch(e=>{$('attioSetupStatus').textContent=e.message;});}
controls();
})();
