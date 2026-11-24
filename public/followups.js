(() => {
'use strict';
const el=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const jst=value=>new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'});
if($('postSendFollowup')){
  const panel=$('postSendFollowup'),form=$('postFollowForm'),status=$('postFollowStatus');
  let receipt=null, plan=null, saving=false;
  const reset=()=>{
    receipt=null;plan=null;form.hidden=true;panel.hidden=true;status.textContent='';
  };
  window.addEventListener('connectionchange',reset);
  const previous=controls;
  controls=function(){
    previous();
    if(receipt&&selected?.id!==receipt.chat_id)reset();
    $('openPostFollow').disabled=busy||saving;
    for(const field of form.elements)field.disabled=busy||saving;
  };
  window.addEventListener('line-send-accepted',event=>{
    if(receipt?.ticket_id===event.detail.ticket_id)return;
    reset();
    receipt=event.detail;
    panel.hidden=false;
    $('openPostFollow').hidden=false;
    form.reset();
    controls();
  });
  function showDate(){
    const when=plan?.dates[$('postFollowDays').value];
    $('postFollowDate').textContent=when?'期限 '+jst(when)+'（日本時間）':'';
  }
  $('openPostFollow').onclick=async()=>{
    if(busy||saving||!receipt)return;
    const ticket=receipt.ticket_id;
    status.textContent='案件と担当者を確認中…';
    try{
      const result=await request('sales-assist',{mode:'follow-plan',ticket_id:ticket});
      if(receipt?.ticket_id!==ticket)return;
      if(!result.deal){
        status.textContent='先にAttioの案件を紐付けてから、もう一度押してください。';
        $('attioSales').scrollIntoView({block:'start'});
        return;
      }
      plan=result;
      const owners=$('postFollowOwner');
      owners.replaceChildren(new Option('担当者を選択',''));
      for(const person of plan.members)owners.add(new Option(person.name,person.id));
      if(plan.members.some(person=>person.id===plan.deal.owner_id))owners.value=plan.deal.owner_id;
      $('postFollowDeal').textContent=plan.deal.name;
      form.hidden=false;
      status.textContent='';
      showDate();
    }catch(error){status.textContent=error.message;}
  };
  $('postFollowDays').onchange=showDate;
  form.onsubmit=async event=>{
    event.preventDefault();
    if(busy||saving||!receipt||!plan)return;
    const content=$('postFollowText').value.trim(),days=Number($('postFollowDays').value),owner=$('postFollowOwner');
    if(!content||!owner.value)return;
    if(!confirm(plan.deal.name+' に「'+content+'」を登録しますか？\n担当：'+owner.selectedOptions[0].text+'\n期限：'+jst(plan.dates[String(days)])))return;
    saving=true;controls();
    try{
      const result=await request('sales-assist',{mode:'follow-save',ticket_id:receipt.ticket_id,days,deal_id:plan.deal.id,owner_id:owner.value,content,confirmed:true});
      if(!result.saved)throw new Error('登録結果を確認できませんでした。');
      form.hidden=true;
      $('openPostFollow').hidden=true;
      status.textContent='Attioにフォローを登録しました。期限 '+jst(result.deadline)+'。';
    }catch(error){status.textContent=error.message;}
    finally{saving=false;controls();}
  };
}
if($('agendaRefresh')){
  const order=['overdue','today','reply','unscheduled'];
  const labels={overdue:'期限超過',today:'今日まで',reply:'返信あり',unscheduled:'次の予定なし'};
  const previous=controls;
  let generation=0,loading=false;
  controls=function(){
    previous();
    $('agendaRefresh').disabled=busy||loading||(!local&&$('connected').classList.contains('hidden'));
  };
  window.addEventListener('connectionchange',()=>{
    generation++;loading=false;$('agendaRows').replaceChildren();$('agendaStatus').textContent='';controls();
  });
  function render(items){
    const root=$('agendaRows');
    root.replaceChildren();
    for(const kind of order){
      const rows=items.filter(row=>row.kind===kind).sort((a,b)=>(a.task?.deadline||'').localeCompare(b.task?.deadline||''));
      if(!rows.length)continue;
      const section=el('section','');
      section.append(el('h3',labels[kind]+'（'+rows.length+'件）'));
      for(const {deal,task,reply} of rows){
        const row=el('div','');row.className='candidate';
        let name=el('strong',deal.name);
        try{
          const url=new URL(deal.url);
          if(url.origin==='https://app.attio.com'){
            name=el('a',deal.name);name.href=url.href;name.target='_blank';name.rel='noopener noreferrer';
          }
        }catch{}
        row.append(name,el('p',[task?.content,task?.deadline?jst(task.deadline):'',reply&&kind!=='reply'?'LINE返信あり':''].filter(Boolean).join(' · ')));
        section.append(row);
      }
      root.append(section);
    }
  }
  $('agendaRefresh').onclick=async()=>{
    if(busy||loading)return;
    loading=true;controls();
    const current=++generation,items=[];
    let offset=0;
    $('agendaRows').replaceChildren();
    try{
      while(offset!==null){
        $('agendaStatus').textContent='Attioの全案件を確認中… '+offset+'件確認済み';
        const page=await request('sales-assist',{mode:'agenda',offset});
        if(current!==generation)return;
        items.push(...page.items);
        if(page.next_offset!==null&&!(page.next_offset>offset))throw new Error('一覧の続きを取得できませんでした。');
        offset=page.next_offset;
        render(items);
      }
      $('agendaStatus').textContent=items.length?items.length+'件のフォロー項目':'対応が必要な案件はありません。';
    }catch(error){if(current===generation)$('agendaStatus').textContent='一覧の取得が途中で止まりました。 '+error.message;}
    finally{if(current===generation){loading=false;controls();}}
  };
  controls();
}
})();
