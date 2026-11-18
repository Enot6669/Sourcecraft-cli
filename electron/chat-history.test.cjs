const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createChatHistory} = require('./chat-history.cjs');
const {describeApproval, describeActivity} = require('./app-server.cjs');

test('stores each project separately and restores its conversation id and messages', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-history-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const project = path.join(directory, 'project');
  const chat = {id: randomUUID(), threadId: randomUUID(), agent: 'chat', title: 'Задача',
    messages: [{role: 'user', text: 'Проверь файл'}, {role: 'agent', text: 'Проверил'}]};
  const history = createChatHistory(directory);
  await Promise.all([history.save(project, chat), history.save(project, {...chat, title: 'Новый заголовок'})]);
  const restored = await createChatHistory(directory).list(project);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].threadId, chat.threadId);
  assert.equal(restored[0].title, 'Новый заголовок');
  assert.deepEqual(restored[0].messages, chat.messages);
  assert.deepEqual(await history.list(path.join(directory, 'another')), []);
  assert.throws(() => history.save(project, {...chat, id: '../foreign'}));
});

test('approval previews require a concrete command or file diff and reject broader access', () => {
  const command = {method: 'item/commandExecution/requestApproval', params: {cwd: '/project', command: 'git status'}};
  assert.match(describeApproval(command).details, /git status/);
  assert.equal(describeApproval({...command, params: {command: 'git status'}}), null);
  assert.equal(describeApproval({...command, params: {...command.params, networkApprovalContext: {host: 'example.org'}}}), null);
  assert.equal(describeApproval({...command, params: {...command.params, additionalPermissions: {}}}), null);
  const patch = {method: 'item/fileChange/requestApproval', params: {}};
  const item = {changes: [{path: 'index.js', diff: '+const n = 1;'}]};
  assert.match(describeApproval(patch, item).details, /index\.js\n\+const n/);
  assert.equal(describeApproval({...patch, params: {grantRoot: '/outside'}}, item), null);
  assert.match(describeActivity({type: 'commandExecution', commandActions: [{type: 'read', path: 'README.md'}]}), /README.md/);
});
