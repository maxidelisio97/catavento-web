import readline from 'node:readline';
import { db } from '../src/db/client.js';
import { hashPassword } from '../src/auth/hashPassword.js';

// SPEC-modulo-6-panel-base.md § "6B.1 Modelo de usuarios": "vía script CLI
// de creación de usuario que pide la contraseña por stdin y nunca la
// loguea." No registration endpoint exists — this is the only way an
// account gets created.

const KEY_ENTER = '\r';
const KEY_NEWLINE = '\n';
const KEY_EOF = '\x04'; // Ctrl+D
const KEY_INTERRUPT = '\x03'; // Ctrl+C
const KEY_BACKSPACE = '\x7f';

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Reads the password without echoing it to the terminal. Falls back to a
// visible prompt when stdin isn't a TTY (e.g. piped input in CI) — there's
// no terminal to hide characters on in that case anyway.
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return prompt(question);

  return new Promise((resolve) => {
    process.stdout.write(question);
    let input = '';

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (char: string): void => {
      if (char === KEY_NEWLINE || char === KEY_ENTER || char === KEY_EOF) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
        return;
      }

      if (char === KEY_INTERRUPT) {
        process.stdout.write('\n');
        process.exit(1);
      }

      if (char === KEY_BACKSPACE) {
        input = input.slice(0, -1);
        return;
      }

      input += char;
    };

    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const email = (await prompt('Email: ')).toLowerCase();
  const name = await prompt('Nome: ');
  const password = await promptHidden('Senha: ');

  if (password.length < 8) {
    throw new Error('A senha deve ter pelo menos 8 caracteres.');
  }

  const passwordHash = await hashPassword(password);

  const user = await db
    .insertInto('users')
    .values({ email, name, password_hash: passwordHash, role: 'admin' })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();

  console.log(`Usuário criado: ${user.email} (id ${user.id})`);
}

main()
  .then(() => db.destroy())
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    return db.destroy().finally(() => process.exit(1));
  });
