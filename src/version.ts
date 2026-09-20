import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const NAME: string = pkg.name;
export const VERSION: string = pkg.version;
export const CONTRACT_VERSION = '3.1';
