import React, {useEffect, useState} from 'react';

function Folder({entry, root, revision, active, disabled, onOpenFile, readFolder}) {
  const [open, setOpen] = useState(false);
  const [contents, setContents] = useState({entries: null, error: false});

  useEffect(() => {
    if (!open) return;
    let current = true;
    readFolder(root, entry.path).then(entries => {
      if (current) setContents({entries, error: false});
    }).catch(() => {
      if (current) setContents({entries: null, error: true});
    });
    return () => { current = false; };
  }, [open, root, entry.path, revision, readFolder]);

  return <details className="project-folder" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary title={entry.path}>{entry.name}</summary>
    <div className="project-children">
      {contents.error ? <p>Не удалось открыть папку. Сверните и раскройте её снова.</p> :
        contents.entries === null ? <p>Загрузка…</p> :
        contents.entries.length === 0 ? <p>Нет отображаемых файлов</p> :
        <ProjectEntries entries={contents.entries} root={root} revision={revision} active={active}
          disabled={disabled} onOpenFile={onOpenFile} readFolder={readFolder} />}
    </div>
  </details>;
}

function ProjectEntries({entries, ...props}) {
  return entries.map(entry => entry.isFolder ?
    <Folder key={entry.path} entry={entry} {...props} /> :
    <button key={entry.path} title={entry.path} disabled={props.disabled}
      className={props.active === entry.path ? 'selected' : ''} onClick={() => props.onOpenFile(entry.path)}>
      <span aria-hidden="true">▤ </span>{entry.name}
    </button>);
}

export function ProjectFiles(props) {
  return <div className="files" role="region" aria-label="Файлы проекта">
    <ProjectEntries {...props} />
  </div>;
}
