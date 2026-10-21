const documentList = document.querySelector('#document-list');
const docCount = document.querySelector('#doc-count');
const input = document.querySelector('#question-input');
const form = document.querySelector('#chat-form');
const sendButton = document.querySelector('#send-button');
const messages = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const selectionNote = document.querySelector('#selection-note');
const uploadStatus = document.querySelector('#upload-status');
const dropzone = document.querySelector('#dropzone');
const fileInput = document.querySelector('#file-input');
const toast = document.querySelector('#toast');
const appShell = document.querySelector('.app-shell');
const authScreen = document.querySelector('#auth-screen');
const authForm = document.querySelector('#auth-form');
const authToggle = document.querySelector('#auth-toggle');
const authError = document.querySelector('#auth-error');
const previewOverlay = document.querySelector('#preview-overlay');
let authMode = 'login';
let documents = [];
let conversation = [];
let toastTimer;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function selectedIds() {
  return [...documentList.querySelectorAll('.doc-select:checked')].map((checkbox) => checkbox.value);
}

function updateSelection() {
  const count = selectedIds().length;
  selectionNote.textContent = count ? `${count} document${count === 1 ? '' : 's'} selected for this conversation.` : 'Select one or more documents from your library to get started.';
  selectionNote.classList.toggle('ready', count > 0);
  documentList.querySelectorAll('.document-row').forEach((row) => row.classList.toggle('selected', row.querySelector('.doc-select').checked));
}

function renderDocuments() {
  docCount.textContent = documents.length;
  if (!documents.length) {
    documentList.innerHTML = '<div class="empty-library">Your library is quiet.<br>Add a document to get started.</div>';
    updateSelection();
    return;
  }
  documentList.innerHTML = documents.map((doc) => {
    const extension = doc.name.split('.').pop().toLowerCase();
    const size = doc.size < 1024 * 1024 ? `${Math.max(1, Math.round(doc.size / 1024))} KB` : `${(doc.size / 1024 / 1024).toFixed(1)} MB`;
    return `<div class="document-row"><input class="doc-select" type="checkbox" value="${escapeHtml(doc.id)}" checked aria-label="Include ${escapeHtml(doc.name)}"><span class="file-icon ${extension}">${escapeHtml(extension.slice(0, 3).toUpperCase())}</span><span class="doc-meta"><strong title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.type)} · ${size}</small></span><button class="preview-doc" data-id="${escapeHtml(doc.id)}" title="Preview document" aria-label="Preview ${escapeHtml(doc.name)}">◉</button><button class="delete-doc" data-id="${escapeHtml(doc.id)}" title="Remove document" aria-label="Remove ${escapeHtml(doc.name)}">×</button></div>`;
  }).join('');
  documentList.querySelectorAll('.doc-select').forEach((checkbox) => checkbox.addEventListener('change', updateSelection));
  documentList.querySelectorAll('.delete-doc').forEach((button) => button.addEventListener('click', () => removeDocument(button.dataset.id)));
  documentList.querySelectorAll('.preview-doc').forEach((button) => button.addEventListener('click', () => previewDocument(button.dataset.id)));
  updateSelection();
}

async function loadDocuments() {
  try {
    const response = await fetch('/api/documents');
    if (!response.ok) throw new Error('Could not load the document library.');
    documents = (await response.json()).documents || [];
    renderDocuments();
  } catch { showToast('Could not load the document library.'); }
}

async function uploadFiles(files) {
  for (const file of files) {
    uploadStatus.classList.remove('error');
    uploadStatus.textContent = `Uploading ${file.name}…`;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch('/api/documents', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed.');
      documents.unshift(data.document);
      renderDocuments();
      showToast(`${file.name} is ready to chat.`);
      uploadStatus.textContent = 'Document added to your library.';
    } catch (error) {
      uploadStatus.textContent = error.message;
      uploadStatus.classList.add('error');
    }
  }
  fileInput.value = '';
}

async function removeDocument(id) {
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not remove document.');
    documents = documents.filter((doc) => doc.id !== id);
    renderDocuments();
    showToast('Document removed from your library.');
  } catch (error) { showToast(error.message); }
}

async function previewDocument(id) {
  const document = documents.find((item) => item.id === id);
  if (!document) return;
  const pdf = document.mime_type === 'application/pdf' || document.type === 'PDF';
  const pdfFrame = documentList.ownerDocument.querySelector('#pdf-preview');
  const textPreview = documentList.ownerDocument.querySelector('#text-preview');
  documentList.ownerDocument.querySelector('#preview-title').textContent = document.name;
  previewOverlay.hidden = false;
  if (pdf) {
    textPreview.hidden = true;
    pdfFrame.hidden = false;
    pdfFrame.src = `/api/documents/${encodeURIComponent(id)}/file`;
  } else {
    pdfFrame.hidden = true;
    pdfFrame.removeAttribute('src');
    textPreview.hidden = false;
    textPreview.textContent = 'Loading preview…';
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}/file`);
      if (!response.ok) throw new Error('Could not load the preview.');
      textPreview.textContent = await response.text();
    } catch (error) { textPreview.textContent = error.message; }
  }
}

function formatMarkdown(text) {
  const blocks = escapeHtml(text).replace(/\r/g, '').split(/\n\s*\n/);
  return blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^```/.test(trimmed)) return `<pre><code>${trimmed.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</code></pre>`;
    const lines = trimmed.split('\n');
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return `<ul>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) return `<ol>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    return `<p>${lines.map(inlineMarkdown).join('<br>')}</p>`;
  }).join('');
}

function inlineMarkdown(text) {
  return text.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function addMessage(role, content = '') {
  welcome.hidden = true;
  messages.classList.add('active');
  const message = document.createElement('article');
  message.className = `message ${role}`;
  const avatar = role === 'assistant' ? 'D' : 'S';
  message.innerHTML = `<div class="message-avatar">${avatar}</div><div class="message-body">${role === 'assistant' ? '' : formatMarkdown(content)}</div>`;
  messages.append(message);
  return message;
}

async function sendQuestion(question) {
  const ids = selectedIds();
  if (!question.trim()) return;
  if (!ids.length) { showToast('Choose at least one document in your library first.'); return; }
  input.value = '';
  input.style.height = 'auto';
  addMessage('user', question);
  const answer = addMessage('assistant');
  const answerBody = answer.querySelector('.message-body');
  const cursor = document.createElement('span');
  cursor.className = 'typing-cursor';
  answerBody.append(cursor);
  sendButton.disabled = true;
  conversation.push({ role: 'user', content: question });
  let fullAnswer = '';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, documentIds: ids, history: conversation.slice(-8, -1) }) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Could not send your question.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let citations = [];
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = pending.split('\n\n');
      pending = events.pop() || '';
      for (const event of events) {
        const type = event.match(/^event: (.+)$/m)?.[1];
        const payload = event.match(/^data: (.+)$/m)?.[1];
        if (!payload) continue;
        if (type === 'token') fullAnswer += JSON.parse(payload);
        if (type === 'sources') citations = JSON.parse(payload);
        if (type === 'error') throw new Error(JSON.parse(payload).error);
        answerBody.innerHTML = formatMarkdown(fullAnswer);
        answerBody.append(cursor);
        messages.scrollTop = messages.scrollHeight;
      }
      if (done) break;
    }
    cursor.remove();
    answerBody.innerHTML = formatMarkdown(fullAnswer || 'I could not generate an answer. Please try again.');
    if (citations.length) {
      const citationRow = document.createElement('div');
      citationRow.className = 'citations';
      citationRow.innerHTML = citations.map((source) => `<button class="citation-chip" data-id="${escapeHtml(source.id)}">[${source.ref}] ${escapeHtml(source.name)} · p. ${source.page}</button>`).join('');
      citationRow.querySelectorAll('.citation-chip').forEach((button) => button.addEventListener('click', () => previewDocument(button.dataset.id)));
      answerBody.append(citationRow);
    }
    conversation.push({ role: 'assistant', content: fullAnswer });
  } catch (error) {
    cursor.remove();
    answerBody.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    showToast(error.message);
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); sendQuestion(input.value); });
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 150)}px`; });
document.querySelectorAll('.suggestion-card').forEach((button) => button.addEventListener('click', () => {
  input.value = button.dataset.prompt;
  input.focus();
  if (selectedIds().length) form.requestSubmit();
}));
fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  uploadFiles([...event.dataTransfer.files]);
});

function setAuthMode(mode) {
  authMode = mode;
  document.querySelector('#auth-title').textContent = mode === 'login' ? 'Welcome to DocuMind' : 'Create your account';
  document.querySelector('#auth-description').textContent = mode === 'login' ? 'Sign in to your private document library.' : 'Your documents are private to your account.';
  document.querySelector('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  document.querySelector('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authToggle.textContent = mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in';
  authError.textContent = '';
}

async function showApplication(user) {
  authScreen.hidden = true;
  appShell.hidden = false;
  document.querySelector('#profile-name').textContent = user.email;
  document.querySelector('.profile-avatar').textContent = user.email.slice(0, 1).toUpperCase();
  await loadDocuments();
}

async function checkSession() {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) throw new Error('Sign in required.');
    const { user } = await response.json();
    await showApplication(user);
  } catch {
    appShell.hidden = true;
    authScreen.hidden = false;
  }
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = document.querySelector('#auth-submit');
  submit.disabled = true;
  authError.textContent = '';
  try {
    const response = await fetch(`/api/auth/${authMode === 'login' ? 'login' : 'register'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.querySelector('#auth-email').value, password: document.querySelector('#auth-password').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not sign in.');
    authForm.reset();
    await showApplication(data.user);
  } catch (error) { authError.textContent = error.message; }
  finally { submit.disabled = false; }
});

authToggle.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
document.querySelector('#logout-button').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  documents = [];
  renderDocuments();
  setAuthMode('login');
  authScreen.hidden = false;
  appShell.hidden = true;
});

function closePreview() {
  previewOverlay.hidden = true;
  document.querySelector('#pdf-preview').removeAttribute('src');
}
document.querySelector('#close-preview').addEventListener('click', closePreview);
previewOverlay.addEventListener('click', (event) => { if (event.target === previewOverlay) closePreview(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !previewOverlay.hidden) closePreview(); });
checkSession();
