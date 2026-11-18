const {contextBridge, ipcRenderer} = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('studio', {
  refreshProject: () => ipcRenderer.invoke('project:refresh'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  readFile: file => ipcRenderer.invoke('file:read', file),
  saveFile: (file, text, expected) => ipcRenderer.invoke('file:save', file, text, expected),
  confirmEdits: count => ipcRenderer.invoke('editor:confirm', count),
  closeWindow: () => ipcRenderer.invoke('editor:close'),
  onCloseRequest: callback => subscribe('editor:requestClose', callback),
  runTask: (prompt, taskId, threadId) => ipcRenderer.invoke('agent:run', prompt, taskId, threadId),
  listChats: () => ipcRenderer.invoke('chat:list'),
  saveChat: (directory, chat) => ipcRenderer.invoke('chat:save', directory, chat),
  decide: (taskId, key, accept) => ipcRenderer.invoke('agent:decision', taskId, key, accept),
  onAgentEvent: callback => subscribe('agent:event', callback),
  cancelTask: () => ipcRenderer.invoke('agent:cancel'),
  checkCli: () => ipcRenderer.invoke('agent:check'),
  checkAuth: () => ipcRenderer.invoke('agent:auth'),
  openUsage: () => ipcRenderer.invoke('sourcecraft:openUsage'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  chooseCli: () => ipcRenderer.invoke('settings:choose'),
  setCliPath: file => ipcRenderer.invoke('settings:setCliPath', file),
  onOutput: callback => subscribe('agent:output', callback),
});
