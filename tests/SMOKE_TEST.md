# SourceCraft Studio Windows smoke test

- [ ] Install and launch the Windows installer from a successful CI run.
- [ ] Open CLI settings and verify automatic detection of the official CLI in its standard installation folder.
- [ ] Select a valid custom `src.exe`, restart Studio and check that the path persists.
- [ ] Select an invalid executable and verify that it is rejected. Enable automatic detection and check that the custom path is cleared.
- [ ] Check authorization before and after signing in with `src auth login`.
- [ ] Edit a UTF-8 file. Test saving, discarding and cancelling when closing its tab, choosing another project and closing the window.
- [ ] Edit the same file externally while it has a Studio draft. Check that Studio preserves the draft and refuses to overwrite the external change.
- [ ] Run a read-only task with each agent and inspect the output and final status.
- [ ] Cancel an active task and verify in Task Manager that the CLI and its child processes exit.
