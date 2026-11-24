(() => {
'use strict';
const previous=controls;
let current=null, running=false, version=null, autoPending=false, briefing=false;
const element=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const button=(label,action)=>{const node=element('button',label);node.type='button';node.onclick=action;return node;};
controls=function(){
  previous();
  if(current!==selected?.id){
    current=selected?.id;
    autoPending=Boolean(selected);
    $('assistResult').replaceChildren();
    $('briefResult').replaceChildren();
    $('briefStatus').textContent='';
    $('assistStatus').textContent='';
    version=null;
  }
  $('salesAssist').classList.toggle('hidden',!selected);
  $('assistGenerate').disabled=busy||running||!selected;
  $('meetingBrief').classList.toggle('hidden',!selected);
  $('briefGenerate').disabled=busy||running||briefing||!selected;
  $('purposeDraft').disabled=busy||running||!selected;
  $('quickFollow').disabled=busy||running||!selected;
  $('followRefresh').disabled=busy||running;
  $('assistResult').querySelectorAll('button').forEach(node=>node.disabled=busy||running);
  if(autoPending&&!busy&&!running){
    autoPending=false;
    const chat=selected;
    setTimeout(()=>{
      if(chat!==selected)return;
      if(busy){autoPending=true;return;}
      generate();
    },0);
  }
};
function evidence(container,data,key){
  const source=data.evidence?.[data[key]];
  if(!source)return;
  const details=document.createElement('details');
  details.append(element('summary',source.title?'根拠のAttioノート':'根拠のLINE発言'),
                 element('p',(source.title||source.speaker)+'：'+source.text));
  container.append(details);
}
function fillReply(text){
  if(!version||version!==conversationVersion||$('replyText').disabled){
    $('assistStatus').textContent='会話を読み込み直してから返信案を再作成してください。';
    $('salesAssist').open=true;
    return;
  }
  $('replyText').value=text;
  $('replyText').dispatchEvent(new Event('input'));
  $('replyText').focus();
}
async function generate(style='',draft='',fill=false){
  if(busy||running||!selected)return;
  const chat=selected.id;
  running=true;controls();
  $('assistStatus').textContent='営業アシストを作成中…';
  try{
    if(!conversationVersion){
      await $('loadHistory').onclick();
      try{window.salesDesk.showOverview(await request('sales-assist',{chat_id:chat,mode:'overview'}));}
      catch{window.salesDesk.showOverview({});}
    }
    const data=await request('sales-assist',{chat_id:chat,style,draft});
    if(selected?.id!==chat)return;
    version=data.version;
    const panel=$('assistResult');
    panel.replaceChildren();
    for(const [field,label] of [['request','相手の要望'],['promise','前回の約束'],['question','未回答の質問']]){
      if(!data[field]||data[field]==='要確認')continue;
      panel.append(element('h3',label),element('p',data[field]));
      evidence(panel,data,field+'_source');
    }
    if(data.reply){
      panel.append(element('h3','返信案'),element('p',data.reply));
      for(const [key,label] of [['short','短く'],['warm','やわらかく'],['schedule','日程調整に進める']]){
        panel.append(button(label,()=>generate(key,data.reply)));
      }
      panel.append(button('返信欄に入れる',()=>fillReply(data.reply)));
    }
    const stageNames={lead:'見込み',in_progress:'商談中',won:'成約',lost:'失注'};
    const stage=data.deal ? stageNames[data.stage] : data.crm_available?'見込み':'';
    panel.append(element('h3','次のアクション候補'),element('p',data.next_action||'要確認'));
    evidence(panel,data,'action_source');
    if(data.deadline)panel.append(element('p','期限候補：'+data.deadline));
    if(stage)panel.append(element('p',(data.deal?'更新候補：':'新規案件候補：')+stage));
    if(data.reason)panel.append(element('p',data.reason));
    evidence(panel,data,'stage_source');
    if(data.crm_available)panel.append(button('Attio入力欄に反映',async()=>{
      if(busy||running)return;
      try{
        const currentDeal=await window.refreshAttioSales();
        if(selected?.id!==chat)return;
        if((currentDeal?.id||null)!==(data.deal?.id||null)||(currentDeal&&currentDeal.stage_id!==data.deal.stage_id)){
          $('assistStatus').textContent='案件情報が変わりました。営業アシストを再作成してください。';
          return;
        }
        const stageSelect=$('attioStage');
        const slug=data.deal?data.stage:'lead';
        const titles={lead:/^lead$/i,in_progress:/^in progress$/i,won:/^won\b/i,lost:/^lost$/i};
        const option=titles[slug]&&[...stageSelect.options].find(row=>titles[slug].test(row.textContent.trim()));
        if(option)stageSelect.value=option.value;
        const create=$('attioNewName');
        if(!data.deal){
          create.value=selected.title;
          const section=create.closest('details');
          if(section)section.open=true;
        }
        $('attioTaskText').value=data.next_action||'';
        $('attioDeadline').value='';
        const deadline=/^\d{4}-\d{2}-\d{2}$/.test(data.deadline||'')?data.deadline:'';
        if(deadline)$('assistStatus').textContent='期限候補 '+deadline+' の時刻と担当者を確認して入力してください。';
        $('attioSales').scrollIntoView({block:'start'});
        controls();
      }catch(error){$('assistStatus').textContent=error.message;}
    }));
    if(fill&&data.reply){$('assistStatus').textContent='';running=false;controls();fillReply(data.reply);}
    else if(fill){$('assistStatus').textContent='返信案を作成できませんでした。';$('salesAssist').open=true;}
    if(!fill)$('assistStatus').textContent=data.crm_available?'':'Attioの案件を確認できませんでした。LINEの情報から作成しました。';
  }catch(error){$('assistStatus').textContent=error.message;if(fill)$('salesAssist').open=true;}
  finally{running=false;controls();}
}
$('briefGenerate').onclick=async()=>{
  if(busy||running||briefing||!selected)return;
  const target=selected;
  const root=$('briefResult'),status=$('briefStatus');
  briefing=true;controls();
  status.textContent='会話とAttioノートを確認しています…';
  root.replaceChildren();
  try{
    const data=await request('sales-assist',{mode:'meeting-brief',chat_id:target.id});
    if(selected!==target)return;
    if(data.deal)root.append(element('p',data.deal.name+' · '+data.deal.stage));
    for(const [key,label] of [['request','相手の要望'],['promise','前回の約束']]){
      const fact=data[key];
      root.append(element('h3',label),element('p',fact?.text||'確認できる記録がありません。'));
      if(fact)evidence(root,{evidence:data.evidence,source:fact.source},'source');
    }
    const questions=document.createElement('ol');
    for(const question of data.questions)questions.append(element('li',question));
    root.append(element('h3','今回聞く3つ'),questions);
    status.textContent=data.has_material ? (data.has_notes?'直近のLINE・保存済みAttioノートを参照':'直近のLINEを参照') : '確認できる資料がないため、基本の質問を表示しています。';
  }catch(error){if(selected===target)status.textContent=error.message;}
  finally{briefing=false;controls();}
};
$('assistGenerate').onclick=()=>generate();
$('purposeDraft').onclick=()=>generate($('replyPurpose').value,'',true);
$('quickFollow').onclick=async()=>{
  if(busy||running||!selected)return;
  try{
    const deal=await window.refreshAttioSales();
    $('attioSales').scrollIntoView({block:'start'});
    if(deal){
      if(!$('attioTaskText').value)$('attioTaskText').value='フォローする';
      $('attioDeadline').focus();
    }else{
      const input=$('attioNewName');
      input.value=selected.title;
      const details=input.closest('details');
      if(details)details.open=true;
      input.focus();
    }
    controls();
  }catch(error){$('assistStatus').textContent=error.message;$('salesAssist').open=true;}
};
$('followRefresh').onclick=async()=>{
  if(busy||running)return;
  const list=$('followResults');
  list.replaceChildren(element('p','確認中…'));
  try{
    if(!window.salesDesk.hasChats()&&!(await $('loadChats').onclick()))throw new Error('先にLINE一覧を取得してください。');
    const ids=window.salesDesk.chatIds(),items=[];
    for(let offset=0;offset<ids.length;offset+=12){
      const page=await request('sales-assist',{mode:'today',chat_ids:ids.slice(offset,offset+12)});
      items.push(...page.items);
    }
    const data={items};
    window.salesDesk.showFollow(data.items);
    list.replaceChildren();
    for(const row of data.items){
      const title=window.salesDesk.label(row.chat_id);
      if(!title)continue;
      const open=button(title+' · '+row.reasons.join('／'),()=>window.salesDesk.open(row.chat_id));
      list.append(open);
    }
    if(!list.children.length)list.append(element('p','確認できたトークにフォロー項目はありません。'));
  }catch(error){list.replaceChildren(element('p',error.message));}
};
window.addEventListener('connectionchange',()=>$('followResults').replaceChildren());
controls();
})();
