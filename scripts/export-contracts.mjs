import {mkdir,writeFile} from 'node:fs/promises';
import * as z from 'zod/v4';
import {configSchema} from '../dist/config.js';
await mkdir('contracts',{recursive:true});
const schema=z.toJSONSchema(configSchema,{target:'draft-2020-12'});
// Do not publish machine-specific defaults captured when the module was imported.
schema.properties.cwd.default='.';schema.properties.shell.default='/bin/zsh';
await writeFile('contracts/runtime-config.schema.json',JSON.stringify(schema,null,2)+'\n');
console.log('Exported runtime-config.schema.json');
