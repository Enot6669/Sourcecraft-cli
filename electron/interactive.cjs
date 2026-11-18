function quotePowerShell(value) {
  return "'" + value.replace(/['\u2018\u2019\u201a\u201b]/g, char => char + char) + "'";
}

function interactiveCommand(directory, executable, agent) {
  if (agent !== 'codex' && agent !== 'ycodex') throw Error('Этот агент не поддерживается');
  return 'Set-Location -LiteralPath ' + quotePowerShell(directory) +
    ' -ErrorAction Stop; & ' + quotePowerShell(executable) + ' ' + agent;
}

module.exports = {interactiveCommand};
