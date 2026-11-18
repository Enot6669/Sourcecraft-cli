const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');

const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
const roles = new Set(['user', 'agent', 'result', 'error', 'activity']);

function createChatHistory(directory) {
  let writes = Promise.resolve();
  const fileFor = (root, id) => {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    return path.join(directory, createHash('sha256').update(key).digest('hex'), id + '.json');
  };

  async function list(root) {
    await writes.catch(() => {});
    const folder = path.dirname(fileFor(root, 'unused'));
    const files = await fs.readdir(folder).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const chats = await Promise.all(files.filter(name => validId(path.basename(name, '.json')) && name.endsWith('.json'))
      .map(async name => {
        try {
          return JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
        } catch {
          return null;
        }
      }));
    return chats.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function save(root, input) {
    if (!input || !validId(input.id) || !['chat', 'ycodex', 'codex'].includes(input.agent) ||
        (input.threadId && !validId(input.threadId)) || !Array.isArray(input.messages)) {
      throw Error('Не удалось сохранить чат: неверный формат.');
    }
    const chat = {
      id: input.id,
      agent: input.agent,
      threadId: input.threadId || '',
      title: String(input.title || 'Новый чат').slice(0, 90),
      updatedAt: Date.now(),
      messages: input.messages.filter(item => item && roles.has(item.role) && typeof item.text === 'string')
        .slice(-500).map(({role, text}) => ({role, text: text.slice(0, 160_000)})),
    };
    const body = JSON.stringify(chat);
    if (Buffer.byteLength(body) > 12 * 1024 * 1024) throw Error('Чат слишком большой для сохранения.');
    const file = fileFor(root, chat.id);
    const write = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), {recursive: true});
      try {
        await fs.writeFile(file + '.tmp', body, 'utf8');
        await fs.rename(file + '.tmp', file);
      } finally {
        await fs.rm(file + '.tmp', {force: true}).catch(() => {});
      }
    });
    writes = write;
    return write;
  }

  return {list, save};
}

module.exports = {createChatHistory, validId};
