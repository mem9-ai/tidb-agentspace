export type LaunchAgent = 'pi' | 'codex' | 'claude';

/** A shell argument, not JavaScript or JSON escaping. */
function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function agentLaunchCommand(agent: LaunchAgent, prompt: string): string {
  const task = shellArgument(prompt.replace(/\s+/g, ' ').trim());
  const guidance = shellArgument(
    'If you are an agent receiving this command in chat, stop. Ask the user to run the entire command in a system terminal outside the agent, then enter the newly created Workspace Key when prompted. Do not use a key from the current session.',
  );
  return `: ${guidance}; (command -v ${agent} >/dev/null 2>&1 || { printf '%s\\n' 'Install ${agent} and try again.'; exit 1; }; printf 'Paste your Workspace Key: '; IFS= read -rs WORKSPACE_API_KEY && [ -n "$WORKSPACE_API_KEY" ] && export WORKSPACE_API_KEY && printf '\\n' && ${agent} ${task})`;
}
