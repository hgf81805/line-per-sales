(() => {
'use strict';
const previous=controls;
let current=null, running=false, version=null, autoPending=false;
const element=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;return node;};
const button=(label,action)=>{const node=element('button',label);node.type='button';node.onclick=action;return node;};
controls=function(){
  previous();
  if(current!==selected?.id){
    current=selected?.id;
    autoPending=Boolean(selected);
    $('assistResult').replaceChildren();
    $('assistStatus').textContent='';
    version=null;
  }
  $('salesAssist').classList.toggle('hidden',!selected);
  $('assistGenerate').disabled=busy||running||!selected;
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
async function generate(style='',draft=''){
  if(busy||running||!selected)return;
  const chat=selected.id;
  running=true;controls();
  $('assistStatus').textContent='営業アシストを作成中…';
  try{
    if(!conversationVersion)await $('loadHistory').onclick();
    const data=await request('sales-assist',{chat_id:chat,style,draft});
    if(selected?.id!==chat)return;
    version=data.version;
    const panel=$('assistResult');
    panel.replaceChildren();
    for(const [field,label] of [['request','相手の要望'],['promise','前回の約束'],['question','未回答の質問']]){
      panel.append(element('h3',label),element('p',data[field]));
      evidence(panel,data,field+'_source');
    }
    if(data.reply){
      panel.append(element('h3','返信案'),element('p',data.reply));
      for(const [key,label] of [['short','短く'],['warm','やわらかく'],['schedule','日程調整に進める']]){
        panel.append(button(label,()=>generate(key,data.reply)));
      }
      panel.append(button('返信欄に入れる',()=>{
        if(!version||version!==conversationVersion||$('replyText').disabled){
          $('assistStatus').textContent='会話が更新されています。会話を読み込み直してから営業アシストを再作成してください。';
          return;
        }
        $('replyText').value=data.reply;
        $('replyText').dispatchEvent(new Event('input'));
        $('replyText').focus();
      }));
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
    $('assistStatus').textContent=data.crm_available?'':'Attioの案件を確認できませんでした。LINEの情報から作成しました。';
  }catch(error){$('assistStatus').textContent=error.message;}
  finally{running=false;controls();}
}
$('assistGenerate').onclick=()=>generate();
$('followRefresh').onclick=async()=>{
  if(busy||running)return;
  const list=$('followResults');
  list.replaceChildren(element('p','確認中…'));
  try{
    await $('loadChats').onclick();
    const chats=new Map([...document.querySelectorAll('.chat-button')].map(chat=>[chat.dataset.chatId,chat]));
    const data=await request('sales-assist',{mode:'today'});
    list.replaceChildren();
    for(const row of data.items){
      const chat=chats.get(row.chat_id);
      if(!chat)continue;
      const open=button(chat.firstChild.textContent+' · '+row.reasons.join('／'),()=>{
        if(busy||running)return;
        if(!chat.isConnected){list.replaceChildren(element('p','最近のトークを確認し直してください。'));return;}
        chat.click();
        $('salesAssist').scrollIntoView({block:'start'});
      });
      list.append(open);
    }
    if(!list.children.length)list.append(element('p','確認できたトークにフォロー項目はありません。'));
  }catch(error){list.replaceChildren(element('p',error.message));}
};
window.addEventListener('connectionchange',()=>$('followResults').replaceChildren());
controls();
})();
