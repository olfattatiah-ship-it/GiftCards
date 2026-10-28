// PreToolUse hook: blocks edits to dependencies and data files.
// Receives the tool call as JSON on stdin; exit code 2 blocks the call.
const path = require('node:path');

const PROTECTED_DIRS = ['node_modules', 'data'];

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const call = JSON.parse(input || '{}');
  const filePath = call.tool_input && call.tool_input.file_path;
  if (!filePath) process.exit(0);

  const projectDir = process.cwd();
  const relative = path.relative(projectDir, path.resolve(projectDir, filePath));
  const top = relative.split(path.sep)[0];

  if (PROTECTED_DIRS.includes(top)) {
    process.stderr.write(
      `ممنوع تعديل "${relative}": هذا المسار محمي (node_modules أو بيانات). راجعي CLAUDE.md.\n`,
    );
    process.exit(2);
  }
  process.exit(0);
});
