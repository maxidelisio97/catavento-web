import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several test files share catavento_db_test and TRUNCATE the same
    // tables between cases. Running files in parallel (Vitest's default)
    // causes real FK violations and deadlocks between them — force
    // sequential file execution instead.
    fileParallelism: false,
  },
});
