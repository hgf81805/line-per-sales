/* Render Markdown through an inert template and copy only safe elements. */
window.renderContactMarkdown = function (target, markdown) {
  const template = document.createElement('template');
  template.innerHTML = marked.parse(markdown || '');
  const allowed = new Set('P BR H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE STRONG EM DEL A HR TABLE THEAD TBODY TR TH TD'.split(' '));
  function copy(source, destination) {
    for (const child of source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        destination.append(document.createTextNode(child.textContent));
      } else if (allowed.has(child.tagName)) {
        const element = document.createElement(child.tagName.toLowerCase());
        if (child.tagName === 'A') {
          try {
            const url = new URL(child.getAttribute('href'));
            if (['https:', 'http:', 'mailto:'].includes(url.protocol)) {
              element.href = url.href;
              element.target = '_blank';
              element.rel = 'noopener noreferrer';
            }
          } catch {}
        }
        copy(child, element);
        destination.append(element);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        destination.append(document.createTextNode(child.textContent));
      }
    }
  }
  const fragment = document.createDocumentFragment();
  copy(template.content, fragment);
  target.replaceChildren(fragment);
};

window.attachContactNoteEditor = function (container, record, entry, heading, preview) {
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = '編集';
  container.append(edit);
  edit.onclick = async () => {
    if (busy) return;
    if (!local && $('connected').classList.contains('hidden')) {
      status.textContent = 'ページ上部で接続するMacを選択してください。';
      return;
    }
    edit.disabled = true;
    status.textContent = 'Attioから読み込み中…';
    const ids = {person_id:record.id,note_id:entry.id};
    try {
      const live = await request('attio-note', ids);
      if (!container.isConnected) return;
      const form = document.createElement('form');
      form.className = 'note-form';
      const title = document.createElement('input');
      title.maxLength = 200;
      title.required = true;
      title.value = live.title;
      const body = document.createElement('textarea');
      body.rows = 12;
      body.required = true;
      body.value = live.body;
      const titleLabel = document.createElement('label');
      titleLabel.append('タイトル',title);
      const bodyLabel = document.createElement('label');
      bodyLabel.append('本文（Markdown）',body);
      const actions = document.createElement('div');
      actions.className = 'note-actions';
      const microphone = document.createElement('button');
      microphone.type = 'button';
      microphone.textContent = '🎙 マイク入力';
      microphone.title = 'ブラウザの音声認識を使います';
      const save = document.createElement('button');
      save.type = 'submit';
      save.className = 'primary';
      save.textContent = '保存';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '閉じる';
      actions.append(microphone,save,cancel);
      form.append(titleLabel,bodyLabel,actions);
      status.before(form);
      status.textContent = '';
      edit.hidden = true;
      preview.hidden = true;
      let recognition = null;
      let saving = false;
      const stop = () => {
        if (recognition) recognition.abort();
        recognition = null;
      };
      const observer = new MutationObserver(() => {
        if (!form.isConnected) { stop(); observer.disconnect(); }
      });
      observer.observe(document.body,{childList:true,subtree:true});
      const close = () => {
        stop();
        observer.disconnect();
        form.remove();
        preview.hidden = false;
        edit.hidden = false;
        edit.disabled = false;
      };
      cancel.onclick = () => { if (!saving) { close(); status.textContent = ''; } };
      microphone.onclick = () => {
        if (recognition) { recognition.stop(); return; }
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
          status.textContent = 'このブラウザではマイク入力を利用できません。';
          return;
        }
        const input = new Recognition();
        recognition = input;
        input.lang = 'ja-JP';
        input.onresult = event => {
          if (recognition !== input || !form.isConnected) return;
          const spoken = event.results[event.resultIndex][0].transcript;
          body.setRangeText(spoken,body.selectionStart,body.selectionEnd,'end');
        };
        input.onerror = () => { status.textContent = '音声を認識できませんでした。マイクの許可を確認してください。'; };
        input.onend = () => {
          recognition = null;
          microphone.textContent = '🎙 マイク入力';
          if (status.textContent === '音声入力中…') status.textContent = '';
        };
        try {
          input.start();
          microphone.textContent = 'マイクを停止';
          status.textContent = '音声入力中…';
        } catch {
          recognition = null;
          status.textContent = 'マイクを開始できませんでした。';
        }
      };
      form.onsubmit = async event => {
        event.preventDefault();
        if (saving || busy) return;
        const update = {...ids,title:title.value.trim(),body:body.value,revision:live.revision};
        const encoder = new TextEncoder();
        if (encoder.encode(body.value).length > 6000 || encoder.encode(JSON.stringify(update)).length > 7800) {
          status.textContent = '本文はUTF-8で6,000バイト以内にしてください。';
          return;
        }
        stop();
        saving = true;
        for (const control of [title,body,microphone,save,cancel]) control.disabled = true;
        status.textContent = 'Attioに保存中…';
        try {
          const next = await request('attio-note',update);
          Object.assign(entry,next);
          heading.textContent = next.title;
          renderContactMarkdown(preview,next.body);
          close();
          edit.focus();
          status.textContent = next.cached ? 'Attioに保存しました。' : 'Attioに保存しました。Supabaseの表示は更新できませんでした。';
        } catch (error) {
          status.textContent = error.message;
        } finally {
          saving = false;
          for (const control of [title,body,microphone,save,cancel]) control.disabled = false;
        }
      };
      title.focus();
    } catch (error) {
      status.textContent = error.message;
      edit.disabled = false;
    }
  };
  const status = document.createElement('p');
  status.setAttribute('role','status');
  container.append(status);
};
