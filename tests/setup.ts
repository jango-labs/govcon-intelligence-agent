// Runs before every test file: isolate from any real .env / data folder / keys on the developer's machine.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GOVCON_DATA_DIR = mkdtempSync(join(tmpdir(), 'govcon-test-data-'));
process.env.SAM_API_KEY = ''; process.env.ANTHROPIC_API_KEY = ''; process.env.OPENAI_API_KEY = ''; process.env.GOVCON_UI_TOKEN = '';
process.env.GOVCON_SECRET_STORE = 'env'; process.env.GOVCON_LLM_PROVIDER = 'none';
